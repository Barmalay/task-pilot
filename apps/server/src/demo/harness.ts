import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ROOT } from '../config.ts';

/** Свободный порт на 127.0.0.1: его выдает система, пока сокет открыт, и порт тут же освобождается. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Процесс с выводом: вывод копится, чтобы показать его, если процесс упал. */
export interface Child {
  process: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

/** Запускает процесс и копит его вывод; stop завершает его и ждет выхода. */
export function launch(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Child {
  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const keep = (d: Buffer) => {
    out = (out + d.toString()).slice(-20_000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return {
    process: child,
    output: () => out,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const kill = setTimeout(() => child.kill('SIGKILL'), 12_000);
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}

/** Ждет, пока адрес ответит 2xx, не дольше timeoutMs; процесс, который упал раньше, - ошибка с концом его вывода. */
export async function waitFor(url: string, timeoutMs: number, child?: Child): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.process.exitCode !== null) throw new Error(`Процесс для ${url} завершился с кодом ${child.process.exitCode}:\n${child.output().slice(-3000)}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      // Еще не поднялся.
    }
    if (Date.now() > deadline) throw new Error(`${url} не ответил за ${Math.round(timeoutMs / 1000)} с${child ? `:\n${child.output().slice(-3000)}` : ''}`);
    await sleep(300);
  }
}

/**
 * Демо Task Pilot в своей временной папке и на своем порту: для смоука интерфейса и эталонных задач. scripted -
 * сценарный агент вместо CLI claude, тогда лимит подписки не тратится.
 */
export async function startDemo(opts: { root: string; port: number; scripted: boolean }): Promise<Child> {
  const env: NodeJS.ProcessEnv = { ...process.env, TASK_PILOT_DEMO_ROOT: opts.root, TASK_PILOT_DEMO_PORT: String(opts.port) };
  if (opts.scripted) env.TASK_PILOT_DEMO_AGENT = 'script';
  else delete env.TASK_PILOT_DEMO_AGENT;
  const demo = launch(process.execPath, [join(ROOT, 'apps/server/src/demo.ts')], { cwd: join(ROOT, 'apps/server'), env });
  await waitFor(`http://127.0.0.1:${opts.port}/api/health`, 90_000, demo);
  return demo;
}

/** Запрос к API демо с заголовком, без которого изменения отклоняются. */
export async function api<T>(port: number, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'x-task-pilot': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}
