import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { childEnv } from '../lib/env.ts';

/** Вход CLI claude по claude auth status --json. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  /** Как вошел CLI: claude.ai, oauth_token, api_key или none. */
  method: string | null;
  email: string | null;
  org: string | null;
  /** Тариф подписки, например team. */
  plan: string | null;
}

/** Запущенный вход claude auth login: браузер открывает сам CLI. */
export interface ClaudeLoginProcess {
  /** Ссылка входа, если браузер не открылся; вход по ней заканчивается кодом, который вставляют в CLI. */
  url(): string | null;
  /** Код со страницы входа. */
  sendCode(code: string): void;
  cancel(): void;
  /** Конец входа: код выхода CLI и хвост его вывода. */
  readonly done: Promise<{ code: number | null; output: string }>;
}

/** Что Task Pilot делает с CLI claude для аккаунтов: env - переменные аккаунта поверх окружения агентов. */
export interface ClaudeCli {
  status(env: Record<string, string>): Promise<ClaudeAuthStatus>;
  login(env: Record<string, string>, email: string | null): ClaudeLoginProcess;
  logout(env: Record<string, string>): Promise<void>;
  /** Короткий запуск claude -p: с этим доступом CLI действительно отвечает. Сбой - исключение с ответом CLI. */
  probe(env: Record<string, string>): Promise<void>;
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Разбор claude auth status --json. Без входа CLI печатает JSON с loggedIn: false. */
export function parseAuthStatus(raw: string): ClaudeAuthStatus {
  let s: { loggedIn?: unknown; authMethod?: unknown; email?: unknown; orgName?: unknown; subscriptionType?: unknown };
  try {
    s = JSON.parse(raw) as typeof s;
  } catch {
    throw new Error('CLI claude ответил не JSON');
  }
  return { loggedIn: s.loggedIn === true, method: text(s.authMethod), email: text(s.email), org: text(s.orgName), plan: text(s.subscriptionType) };
}

/** Хвост вывода для сообщения об ошибке. */
const tail = (s: string) => s.trim().slice(-600);

/**
 * CLI claude в окружении агентов: без переменных родительской сессии Claude, с переменными аккаунта. Вход
 * claude auth login работает и без терминала: CLI открывает браузер сам, печатает ссылку на случай, если браузер
 * не открылся, и ждет возврата из браузера или кода в stdin.
 */
export function createClaudeCli(cli: string): ClaudeCli {
  const envOf = (extra: Record<string, string>) => childEnv(process.env, extra);
  return {
    status: (env) =>
      new Promise((resolve, reject) => {
        // Без входа CLI выходит с кодом 1, но JSON все равно печатает, поэтому вывод берется и в этом случае.
        execFile(cli, ['auth', 'status', '--json'], { env: envOf(env), timeout: 15_000 }, (err, stdout) => {
          if (!stdout.trim()) return reject(new Error(`CLI claude не ответил: ${err?.message ?? 'пустой ответ'}`));
          try {
            resolve(parseAuthStatus(stdout));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      }),

    login(env, email) {
      const child = spawn(cli, ['auth', 'login', ...(email ? ['--email', email] : [])], { env: envOf(env), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let link: string | null = null;
      const onData = (d: Buffer) => {
        output = (output + d.toString()).slice(-20_000);
        link ??= /https:\/\/\S+/.exec(output)?.[0] ?? null;
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      // Код может прийти, когда CLI уже вышел: запись в закрытый stdin не должна ронять сервер.
      child.stdin.on('error', () => undefined);
      const done = new Promise<{ code: number | null; output: string }>((resolve) => {
        child.on('error', (e) => resolve({ code: null, output: `${output}\n${e.message}` }));
        child.on('close', (code) => resolve({ code, output: tail(output) }));
      });
      return {
        url: () => link,
        sendCode: (code) => {
          if (child.stdin.writable) child.stdin.write(`${code.trim()}\n`);
        },
        cancel: () => child.kill('SIGTERM'),
        done,
      };
    },

    logout: (env) =>
      new Promise((resolve, reject) => {
        execFile(cli, ['auth', 'logout'], { env: envOf(env), timeout: 30_000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`claude auth logout: ${tail(stderr || stdout) || err.message}`));
          else resolve();
        });
      }),

    probe: (env) =>
      new Promise((resolve, reject) => {
        const args = ['-p', 'Ответь одним словом: ok', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--max-budget-usd', '0.05'];
        execFile(cli, args, { env: envOf(env), cwd: tmpdir(), timeout: 120_000 }, (err, stdout, stderr) => {
          let result: { is_error?: unknown; result?: unknown } = {};
          try {
            result = JSON.parse(stdout) as typeof result;
          } catch {
            // Без JSON причина в stderr.
          }
          if (!err && result.is_error !== true) return resolve();
          reject(new Error(`CLI claude не ответил с этим доступом: ${tail(typeof result.result === 'string' ? result.result : stderr || stdout) || err?.message || 'ошибка'}`));
        });
      }),
  };
}

/**
 * Что из ~/.claude агент видит и под другим аккаунтом Claude: инструкции владельца, настройки, скиллы, агенты,
 * команды, стили, плагины и сессии (без них не продолжить сессию, начатую под другим аккаунтом). Свои у папки
 * аккаунта только вход и служебный .claude.json.
 */
export const SHARED_CLAUDE = ['CLAUDE.md', 'settings.json', 'skills', 'agents', 'commands', 'output-styles', 'plugins', 'projects'];

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Готовит папку аккаунта Claude (CLAUDE_CONFIG_DIR): ссылки на общее из ~/.claude, которое у владельца есть. */
export function prepareClaudeDir(dir: string, claudeHome: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of SHARED_CLAUDE) {
    const target = join(claudeHome, name);
    const link = join(dir, name);
    if (existsSync(target) && !present(link)) symlinkSync(target, link);
  }
}

/**
 * Удаляет папку аккаунта Claude. Сначала снимаются ссылки на общее из ~/.claude, чтобы удаление папки не могло
 * зайти по ним в настоящие скиллы и сессии; удаляется только папка внутри root.
 */
export function removeClaudeDir(dir: string, root: string): void {
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Папка ${dir} не внутри ${root}: не удаляю`);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Файлы входа в папке аккаунта Claude, путями и шаблонами, как у ~/.claude.json в песочнице: агенту их читать нельзя. */
export function claudeDirSecrets(dir: string): string[] {
  return [join(dir, '.credentials.json'), `${join(dir, '.claude.json')}*`, join(dir, 'backups')];
}
