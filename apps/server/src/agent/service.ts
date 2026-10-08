import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { AgentRequest, AgentResult, StepAgent, StepManifest } from '@task-pilot/step-kit';
import type { McpServerConfig } from '../config.ts';
import { EngineError } from '../engine/engine.ts';
import type { EventBus, NewEvent } from '../engine/events.ts';
import type { Redactor } from '../lib/redact.ts';
import type { QuestionRow, Store } from '../store/db.ts';
import { AgentError, type AgentRunner, type StreamEvent } from './claude.ts';
import type { BudgetService } from '../budget.ts';
import { agentEnv, baseDeny, buildClaudeArgs, sandboxSettings, writableDirs, type McpWriteServers } from './policy.ts';

/** Чей это агент: прогон, шаг и сессия Claude. */
export interface AgentSessionRef {
  runId: string;
  stepId: string;
  sessionId: string;
}

/** Чей агент запускается: прогон, шаг, настройки агента из манифеста шага и сигнал остановки шага. */
export interface AgentTarget {
  runId: string;
  stepId: string;
  manifest: Pick<StepManifest, 'agent'>;
  signal: AbortSignal;
  /** Не писать в ленту запуски и вызовы инструментов агента. */
  quiet?: boolean;
}

/**
 * Агент вне прогона: правка мониторинга по запросу. Он всегда тихий, сессия не пишется в журнал агентов прогонов, а
 * расход сессии вызывающий записывает сам в onCost до того, как лимиты пересчитают расход.
 */
export interface ToolTarget {
  /** Кто запускает агента, например monitor.edit: так называется папка журнала потока. */
  tool: string;
  manifest: Pick<StepManifest, 'agent'>;
  signal: AbortSignal;
  onCost: (costUsd: number) => void;
}

/** Зависимости сервиса агентов. */
export interface AgentServiceDeps {
  store: Store;
  bus: EventBus;
  redact: Redactor;
  runner: AgentRunner;
  /**
   * MCP-серверы владельца из ~/.claude.json с доступом с экрана "Интеграции": шаг берет из них только нужные.
   * Функция отдает текущий набор: каждый запуск получает доступ, действующий в момент запуска.
   */
  ownerMcp: Record<string, McpServerConfig> | (() => Record<string, McpServerConfig>);
  /** Переменные окружения активного аккаунта Claude: CLAUDE_CONFIG_DIR или токен; пусто - вход CLI владельца. */
  claudeEnv?: () => Record<string, string>;
  /** Файлы входа папок аккаунтов Claude: агенту их читать нельзя. */
  claudeSecrets?: () => string[];
  /** Скрипт MCP-сервера pipeline с инструментами ask_owner и report_progress. */
  pipelineScript: string;
  /** Плагин со скиллами агентов Task Pilot: CLI получает его флагом --plugin-dir. */
  pluginDir?: string;
  /** MCP-серверы Jira, Bitbucket и Bamboo из профилей: их пишущие инструменты агентам запрещены. */
  writeServers?: McpWriteServers;
  /** Лимиты расхода: исчерпанный лимит не дает запустить нового агента, расход сессии учитывается после нее. */
  budget?: Pick<BudgetService, 'assertCanStart' | 'recorded'>;
  /** Адрес API, по которому pipeline обращается к серверу. */
  serverUrl: () => string;
  dataDir: string;
  /** Сколько ask_owner ждет ответа владельца. */
  askTimeoutMs: number;
  /** Таймаут инструментов MCP для CLI: больше ожидания ask_owner. */
  mcpToolTimeoutMs: number;
}

/** Инструменты, о которых в ленте писать незачем. */
const QUIET_TOOLS = new Set(['ToolSearch', 'StructuredOutput']);

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

/**
 * Короткое описание вызова инструмента для ленты: команда, файл или шаблон поиска. Пути внутри
 * рабочей папки показываются относительно нее; roots - сама папка и ее путь без символических ссылок.
 */
export function describeTool(name: string, input: Record<string, unknown>, roots: string[]): string {
  const path = (p: unknown) => {
    const value = String(p);
    if (!isAbsolute(value)) return value;
    for (const root of roots) {
      const rel = relative(root, value);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    }
    return value;
  };
  if (typeof input.command === 'string') return `${name}: ${input.command.replace(/\s+/g, ' ').slice(0, 200)}`;
  if (input.file_path !== undefined) return `${name}: ${path(input.file_path)}`;
  if (typeof input.pattern === 'string') return `${name}: ${input.pattern.slice(0, 120)}${input.path ? ` в ${path(input.path)}` : ''}`;
  if (typeof input.question === 'string') return `${name}: ${input.question.slice(0, 200)}`;
  return name;
}

/**
 * Запускает агентов шагов и связывает их с владельцем. Каждый запуск получает одноразовый
 * токен, по которому MCP-сервер pipeline задает вопросы именно в свой прогон и шаг.
 */
export class AgentService {
  private readonly d: AgentServiceDeps;
  private readonly sessions = new Map<string, AgentSessionRef>();
  private readonly answers = new EventEmitter();
  private readonly active = new Set<AbortController>();

  constructor(deps: AgentServiceDeps) {
    this.d = deps;
    this.answers.setMaxListeners(0);
  }

  /**
   * Агент для шага прогона: настройки модели берутся из манифеста шага. Тихий агент (quiet) не пишет в ленту свои
   * запуски и вызовы инструментов: так отвечает на вопросы владельца агент, который только читает, а его вопрос и
   * ответ ленте отдает сервис вопросов.
   */
  forStep(target: AgentTarget): StepAgent {
    return {
      run: (request) => this.run(target, request),
      lastSession: (label) => {
        const s = this.d.store.lastAgentSession(target.runId, target.stepId, label);
        return s ? { sessionId: s.sessionId, status: s.status } : null;
      },
    };
  }

  /** Агент вне прогона: без ленты, журнала агентов прогона и вопросов владельцу; лимиты расхода действуют. */
  forTool(target: ToolTarget): { run: (request: AgentRequest) => Promise<AgentResult> } {
    return { run: (request) => this.run(target, request) };
  }

  private async run(target: AgentTarget | ToolTarget, request: AgentRequest): Promise<AgentResult> {
    const runId = 'runId' in target ? target.runId : null;
    const stepId = 'runId' in target ? target.stepId : target.tool;
    const { manifest } = target;
    const quiet = 'runId' in target ? target.quiet : true;
    const feed = (e: NewEvent): void => {
      if (!quiet) this.d.bus.emitEvent(e);
    };
    const spent = (costUsd: number) => {
      if (!('runId' in target)) target.onCost(costUsd);
      this.d.budget?.recorded({ runId, stepId }, costUsd);
    };
    const model = request.model ?? manifest.agent?.model;
    const resolved: AgentRequest = { ...request, model, maxBudgetUsd: request.maxBudgetUsd ?? manifest.agent?.maxBudgetUsd };
    // Исчерпанный лимит расхода: агент не запускается, шаг падает с объяснением, как поднять лимит.
    this.d.budget?.assertCanStart({ runId, stepId });
    const sessionId = request.resume ?? randomUUID();
    const row = runId ? this.d.store.createAgentSession({ sessionId, runId, stepId, label: request.label, model: model ?? null }) : null;
    const dir = join(this.d.dataDir, 'agent', row?.id ?? `${stepId}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString('hex');
    // У агента вне прогона нет вопросов владельцу и отчетов о ходе: токен pipeline ему не выдается.
    if (runId) this.sessions.set(token, { runId, stepId, sessionId });
    const mcpFile = join(dir, 'mcp.json');
    const ctl = new AbortController();
    const onStepAbort = () => ctl.abort();
    target.signal.addEventListener('abort', onStepAbort, { once: true });
    if (target.signal.aborted) ctl.abort();
    this.active.add(ctl);
    const title = `Агент "${request.label}"`;
    const started = Date.now();
    try {
      // В файле могут быть токены MCP-серверов владельца: он доступен только владельцу и удаляется после запуска.
      writeFileSync(mcpFile, JSON.stringify(this.mcpConfig(token, request.mcp ?? [])), { mode: 0o600 });
      feed({
        runId,
        stepId,
        type: 'agent.started',
        message: `${title}: ${request.resume ? 'продолжение сессии' : 'запуск'}${model ? `, модель ${model}` : ''}`,
        data: { sessionId, label: request.label },
      });
      const roots = [request.cwd, realOrSelf(request.cwd)];
      const secrets = this.d.claudeSecrets?.() ?? [];
      const args = buildClaudeArgs({
        request: resolved,
        effort: manifest.agent?.effort,
        sessionId,
        resume: !!request.resume,
        mcpConfigFile: mcpFile,
        pluginDir: this.d.pluginDir,
        deny: baseDeny(this.d.dataDir, secrets, this.d.writeServers),
        settings: sandboxSettings({ writeDirs: writableDirs(resolved), dataDir: this.d.dataDir, denyRead: secrets }),
      });
      // Аккаунт Claude идет последним: переменные шага его не подменят.
      const env = agentEnv(process.env, { ...(request.env ?? {}), MCP_TOOL_TIMEOUT: String(this.d.mcpToolTimeoutMs), ...(this.d.claudeEnv?.() ?? {}) });
      const result = await this.d.runner.run({
        args,
        cwd: request.cwd,
        env,
        signal: ctl.signal,
        logFile: join(dir, 'stream.jsonl'),
        redact: this.d.redact.text,
        onEvent: (e) => {
          // Только начатую CLI сессию можно потом продолжить через --resume.
          if (e.kind === 'init' && row) this.d.store.markAgentStarted(row.id);
          if (!quiet && runId && row) this.forward(runId, stepId, roots, row.id, e);
        },
      });
      if (row) this.d.store.finishAgentSession(row.id, { status: 'succeeded', costUsd: result.costUsd, durationMs: result.durationMs, turns: result.turns });
      spent(result.costUsd);
      if (result.denials.length) {
        feed({
          runId,
          stepId,
          type: 'agent.denied',
          message: `${title}: отказано в ${result.denials.length} вызовах: ${result.denials.slice(0, 5).join('; ')}`,
          data: { denials: result.denials },
        });
      }
      feed({
        runId,
        stepId,
        type: 'agent.finished',
        message: `${title}: готово за ${minutes(result.durationMs || Date.now() - started)}, $${result.costUsd.toFixed(2)}, ходов ${result.turns}`,
        data: { costUsd: result.costUsd, durationMs: result.durationMs, turns: result.turns },
      });
      return {
        sessionId: result.sessionId || sessionId,
        text: result.text,
        output: result.output,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        turns: result.turns,
        denials: result.denials,
      };
    } catch (e) {
      const partial = e instanceof AgentError ? e.result : null;
      const message = e instanceof Error ? e.message : String(e);
      if (row) {
        this.d.store.finishAgentSession(row.id, {
          status: ctl.signal.aborted ? 'aborted' : 'failed',
          costUsd: partial?.costUsd,
          durationMs: partial?.durationMs || Date.now() - started,
          turns: partial?.turns,
          error: this.d.redact.text(message),
        });
      }
      spent(partial?.costUsd ?? 0);
      feed({ runId, stepId, type: 'agent.failed', message: `${title}: ${message}` });
      throw e;
    } finally {
      target.signal.removeEventListener('abort', onStepAbort);
      this.active.delete(ctl);
      this.sessions.delete(token);
      rmSync(mcpFile, { force: true });
      if (runId && this.d.store.expireQuestions({ sessionId })) {
        this.d.bus.emitEvent({ runId, stepId, type: 'question.expired', message: 'Агент завершился, его вопросы закрыты без ответа' });
      }
    }
  }

  private mcpConfig(token: string, servers: string[]): { mcpServers: Record<string, unknown> } {
    const all = typeof this.d.ownerMcp === 'function' ? this.d.ownerMcp() : this.d.ownerMcp;
    const owner = servers.map((name) => {
      const cfg = all[name];
      if (!cfg) throw new Error(`MCP-сервер ${name} не настроен в ~/.claude.json`);
      return [name, { type: 'stdio', command: cfg.command, args: cfg.args, env: cfg.env }] as const;
    });
    return {
      mcpServers: {
        ...Object.fromEntries(owner),
        pipeline: {
          type: 'stdio',
          command: process.execPath,
          args: [this.d.pipelineScript],
          env: {
            TASK_PILOT_URL: this.d.serverUrl(),
            TASK_PILOT_AGENT_TOKEN: token,
            TASK_PILOT_ASK_TIMEOUT_MS: String(this.d.askTimeoutMs),
          },
        },
      },
    };
  }

  /**
   * Действия агента в ленту. Вызов инструмента хранит ссылку на свой запуск и id вызова: что именно агент сделал
   * (дифф правки, вывод команды) лента читает по ней из журнала потока `stream.jsonl`, а не копирует в событие.
   */
  private forward(runId: string, stepId: string, roots: string[], session: string, e: StreamEvent): void {
    if (e.kind === 'tool' && !QUIET_TOOLS.has(e.name)) {
      const data = { tool: e.name, session, ...(e.id ? { toolUseId: e.id } : {}) };
      this.d.bus.emitEvent({ runId, stepId, type: 'agent.tool', message: describeTool(e.name, e.input, roots), data });
    } else if (e.kind === 'text') {
      this.d.bus.emitEvent({ runId, stepId, type: 'agent.text', message: e.text.trim().slice(0, 600) });
    }
  }

  /** Сессия агента по его токену; undefined - токен не выдавался или запуск закончился. */
  session(token: string): AgentSessionRef | undefined {
    return this.sessions.get(token);
  }

  private mustSession(token: string): AgentSessionRef {
    const s = this.sessions.get(token);
    if (!s) throw new EngineError('Неизвестный или завершившийся агент', 401);
    return s;
  }

  private mustOwnQuestion(s: AgentSessionRef, id: string): QuestionRow {
    const q = this.d.store.getQuestion(id);
    if (!q || q.runId !== s.runId || q.stepId !== s.stepId) throw new EngineError('Вопрос не найден', 404);
    return q;
  }

  /** Вопрос агента владельцу. */
  ask(token: string, question: string, options: string[]): QuestionRow {
    const s = this.mustSession(token);
    const q = this.d.store.createQuestion({ runId: s.runId, stepId: s.stepId, sessionId: s.sessionId, question: this.d.redact.text(question), options: this.d.redact.deep(options) });
    this.d.bus.emitEvent({ runId: s.runId, stepId: s.stepId, type: 'question.asked', message: `Агент спрашивает: ${q.question}`, data: { questionId: q.id } });
    return q;
  }

  /** Ждет ответа на вопрос не дольше waitMs и возвращает вопрос в текущем состоянии. */
  async wait(token: string, id: string, waitMs: number): Promise<QuestionRow> {
    const s = this.mustSession(token);
    const q = this.mustOwnQuestion(s, id);
    if (q.status !== 'open') return q;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.answers.off(id, done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.answers.once(id, done);
    });
    return this.d.store.getQuestion(id)!;
  }

  /** Агент больше не ждет ответа. */
  expire(token: string, id: string): void {
    const s = this.mustSession(token);
    this.mustOwnQuestion(s, id);
    if (this.d.store.expireQuestions({ id })) {
      this.d.bus.emitEvent({ runId: s.runId, stepId: s.stepId, type: 'question.expired', message: 'Агент не дождался ответа и продолжил без него' });
    }
    this.answers.emit(id);
  }

  /** Сообщение агента о ходе работы. */
  progress(token: string, message: string): void {
    const s = this.mustSession(token);
    this.d.bus.emitEvent({ runId: s.runId, stepId: s.stepId, type: 'agent.progress', message: this.d.redact.text(message).slice(0, 500) });
  }

  /** Ответ владельца из интерфейса. */
  answer(id: string, answer: string): QuestionRow {
    const q = this.d.store.getQuestion(id);
    if (!q) throw new EngineError('Вопрос не найден', 404);
    if (!this.d.store.answerQuestion(id, answer)) throw new EngineError('Вопрос уже закрыт: агент перестал ждать ответа', 409);
    this.d.bus.emitEvent({ runId: q.runId, stepId: q.stepId, type: 'question.answered', message: `Ответ владельца: ${this.d.redact.text(answer).slice(0, 300)}`, data: { questionId: q.id } });
    this.answers.emit(id);
    return this.d.store.getQuestion(id)!;
  }

  /** Идет ли сейчас хоть один агент. */
  running(): boolean {
    return this.active.size > 0;
  }

  /** Останавливает всех агентов: сервер завершается. */
  close(): void {
    for (const c of this.active) c.abort();
  }
}
