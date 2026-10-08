import { execFile } from 'node:child_process';
import type { GitPort, GitResult } from '@task-pilot/step-kit';

/** Ошибка команды git с выводом команды. */
export class GitError extends Error {
  readonly result: GitResult;

  constructor(args: string[], result: GitResult) {
    super(`git ${args.join(' ')}: ${(result.stderr || result.stdout).trim() || `код ${result.code}`}`);
    this.result = result;
  }
}

/** Заголовок, который git отправляет на хост: токен Bitbucket с экрана "Интеграции" для git по https. */
export interface GitHeader {
  /** Начало адреса, к которому относится заголовок, например https://git.example.com/. */
  prefix: string;
  header: string;
}

/**
 * Настройки `http.<адрес>.extraHeader` для git через окружение (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`,
 * `GIT_CONFIG_VALUE_n`): значение не попадает ни в аргументы процесса, ни в конфиг репозитория, а git отправляет
 * заголовок только на адреса под своим началом.
 */
export function gitConfigEnv(headers: GitHeader[]): Record<string, string> {
  if (!headers.length) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(headers.length) };
  headers.forEach((h, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `http.${h.prefix}.extraHeader`;
    env[`GIT_CONFIG_VALUE_${i}`] = h.header;
  });
  return env;
}

function exec(cwd: string, args: string[], headers: GitHeader[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...gitConfigEnv(headers) },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 180_000,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Настройки порта git. */
export interface GitOptions {
  /** Заголовки для хостов с токеном Bitbucket на экране "Интеграции"; берутся при каждой команде. */
  headers?: () => GitHeader[];
}

/**
 * Порт git поверх CLI. Пароль никогда не спрашивается: учетные данные берутся из Keychain, а для хоста с токеном
 * Bitbucket на экране "Интеграции" git получает этот токен заголовком.
 */
export function createGit(o: GitOptions = {}): GitPort {
  const run = (cwd: string, args: string[]) => exec(cwd, args, o.headers?.() ?? []);
  return {
    async run(cwd, args) {
      const r = await run(cwd, args);
      if (r.code !== 0) throw new GitError(args, r);
      return r;
    },
    tryRun: run,
  };
}
