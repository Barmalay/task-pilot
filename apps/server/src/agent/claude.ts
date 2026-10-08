import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Событие из потока stream-json, нужное конвейеру. */
export type StreamEvent =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'result'; result: ClaudeResult };

/** Итог запуска claude -p. */
export interface ClaudeResult {
  sessionId: string;
  isError: boolean;
  subtype: string;
  text: string;
  output: unknown;
  costUsd: number;
  durationMs: number;
  turns: number;
  denials: string[];
}

interface RawContent {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface RawLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: RawContent[] };
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  permission_denials?: { tool_name?: string; tool_input?: Record<string, unknown> }[];
}

function denial(d: { tool_name?: string; tool_input?: Record<string, unknown> }): string {
  const input = d.tool_input ?? {};
  const detail = input.command ?? input.file_path ?? input.path ?? '';
  return `${d.tool_name ?? '?'}${detail ? ` ${String(detail)}` : ''}`;
}

/** Разбирает строку stream-json. Непонятные и служебные строки дают пустой список. */
export function parseStreamLine(line: string): StreamEvent[] {
  let raw: RawLine;
  try {
    raw = JSON.parse(line) as RawLine;
  } catch {
    return [];
  }
  if (raw.type === 'system' && raw.subtype === 'init' && raw.session_id) {
    return [{ kind: 'init', sessionId: raw.session_id, model: raw.model ?? '' }];
  }
  if (raw.type === 'assistant') {
    const out: StreamEvent[] = [];
    for (const c of raw.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text });
      if (c.type === 'tool_use' && c.name) out.push({ kind: 'tool', id: c.id ?? '', name: c.name, input: c.input ?? {} });
    }
    return out;
  }
  if (raw.type === 'result') {
    return [
      {
        kind: 'result',
        result: {
          sessionId: raw.session_id ?? '',
          isError: raw.is_error === true || raw.subtype !== 'success',
          subtype: raw.subtype ?? 'unknown',
          text: raw.result ?? '',
          output: raw.structured_output ?? null,
          costUsd: raw.total_cost_usd ?? 0,
          durationMs: raw.duration_ms ?? 0,
          turns: raw.num_turns ?? 0,
          denials: (raw.permission_denials ?? []).map(denial),
        },
      },
    ];
  }
  return [];
}

/** Ошибка запуска агента. */
export class AgentError extends Error {
  readonly result: ClaudeResult | null;

  constructor(message: string, result: ClaudeResult | null = null) {
    super(message);
    this.result = result;
  }
}

/** Что нужно раннеру для одного запуска. */
export interface RunnerInput {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  /** Сюда пишется весь поток stream-json после маскирования. */
  logFile: string;
  redact: (text: string) => string;
  onEvent: (e: StreamEvent) => void;
}

/** То, чем движок запускает агента: настоящий CLI или подмена в тестах. */
export interface AgentRunner {
  run(input: RunnerInput): Promise<ClaudeResult>;
}

const STOP_GRACE_MS = 5000;

/**
 * Запускает claude -p с закрытым stdin и читает поток stream-json. Остановка владельцем
 * завершает процесс: сначала SIGTERM, через несколько секунд SIGKILL.
 */
export class ClaudeRunner implements AgentRunner {
  private readonly cli: string;
  private readonly baseArgs: string[];

  /** baseArgs идут перед аргументами запуска: так в тестах вместо CLI работает скрипт node. */
  constructor(cli: string, baseArgs: string[] = []) {
    this.cli = cli;
    this.baseArgs = baseArgs;
  }

  run(input: RunnerInput): Promise<ClaudeResult> {
    return new Promise((resolve, reject) => {
      if (input.signal.aborted) return reject(new AgentError('Остановлено владельцем'));
      const log = createWriteStream(input.logFile, { flags: 'a', mode: 0o600 });
      // Журнал вспомогательный: его сбой не должен ронять сервер или запуск.
      log.on('error', () => {});
      const child = spawn(this.cli, [...this.baseArgs, ...input.args], { cwd: input.cwd, env: input.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let result: ClaudeResult | null = null;
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', onAbort);
        log.end();
        fn();
      };
      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS).unref();
        finish(() => reject(new AgentError('Остановлено владельцем')));
      };
      input.signal.addEventListener('abort', onAbort, { once: true });

      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim() || settled) return;
        log.write(`${input.redact(line)}\n`);
        for (const e of parseStreamLine(line)) {
          if (e.kind === 'result') result = e.result;
          input.onEvent(e);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on('error', (e) => finish(() => reject(new AgentError(`Не удалось запустить ${this.cli}: ${e.message}`))));
      child.on('close', (code) => {
        finish(() => {
          if (!result) {
            const tail = input.redact(stderr.trim()).slice(-600);
            return reject(new AgentError(`Агент завершился без итога, код ${code}${tail ? `: ${tail}` : ''}`));
          }
          if (result.isError) return reject(new AgentError(`Агент завершился с ошибкой ${result.subtype}: ${input.redact(result.text).slice(0, 600)}`, result));
          resolve(result);
        });
      });
    });
  }
}
