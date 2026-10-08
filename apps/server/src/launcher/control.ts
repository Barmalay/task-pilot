import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Процесс, который запускает приложение Task Pilot. */
export interface ProcessSpec {
  command: string[];
  cwd: string;
}

/** Что и где запускает приложение Task Pilot в Dock. */
export interface LaunchOptions {
  /** Папка служебных файлов запуска: какие процессы запущены и журнал. */
  data: string;
  /** Окружение запускаемых процессов. */
  env: NodeJS.ProcessEnv;
  server: ProcessSpec;
  web: ProcessSpec;
  /** Адрес API сервера без завершающего слеша, например http://127.0.0.1:5176/api. */
  api: string;
  /** Адрес интерфейса. */
  ui: string;
  /** Сколько ждать, пока сервер и интерфейс ответят. */
  readyTimeoutMs?: number;
  /** Сколько ждать завершения процесса после SIGTERM, прежде чем завершить его принудительно. */
  stopTimeoutMs?: number;
}

/** Task Pilot запущен этим приложением, запущен иначе (например pnpm dev в терминале) или не работает. */
export type LaunchStatus = 'running:ours' | 'running:external' | 'stopped';

const NAMES = ['server', 'web'] as const;
type Name = (typeof NAMES)[number];

/** Запущенный процесс: pid лидера своей группы и время его старта. */
interface Entry {
  pgid: number;
  started: string;
}

/** Содержимое launcher.json: запущенные процессы и перезапуск, который идет сейчас. */
interface State {
  server?: Entry;
  web?: Entry;
  /** Процесс команды restart: пока он работает, status считает Task Pilot своим и запущенным. */
  restarting?: { pid: number; started: string };
}

const stateFile = (o: LaunchOptions) => join(o.data, 'launcher.json');

/** Журнал текущего запуска: вывод сервера и интерфейса. Журнал предыдущего остается в launcher.prev.log. */
export const logFile = (o: LaunchOptions) => join(o.data, 'launcher.log');

/**
 * Нужно ли выполнять команду запускалки. pnpm restart вызывает подряд скрипты stop, restart и start, и у всех
 * трех npm_command равен restart. Остановку и запуск тогда делает сам restart: он отказывается при выполняющемся
 * прогоне и ставит метку для приложения в Dock, поэтому stop и start внутри pnpm restart пропускаются.
 */
export function skipsCommand(command: string, npmCommand: string | undefined): boolean {
  return npmCommand === 'restart' && (command === 'stop' || command === 'start');
}

/**
 * PATH для процессов Task Pilot. Приложениям из Finder macOS дает только системные папки, поэтому первой
 * идет папка node, на котором работает запускалка, затем ~/.local/bin с CLI claude и PATH входной оболочки
 * из /etc/paths и /etc/paths.d (вывод path_helper -s), где есть Homebrew с git, mvn и командами MCP-серверов.
 */
export function launchPath(pathHelperOutput: string, home: string, nodeDir: string): string {
  const system = /PATH="([^"]*)"/.exec(pathHelperOutput)?.[1] ?? '/usr/bin:/bin:/usr/sbin:/sbin';
  return [...new Set([nodeDir, join(home, '.local/bin'), ...system.split(':')])].filter(Boolean).join(':');
}

/** Время старта процесса по ps: вместе с pid отличает свой процесс от чужого, получившего тот же pid. */
function startedAt(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Процесс или группа процессов (отрицательный id) существует. */
function exists(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signal(id: number, name: NodeJS.Signals): void {
  try {
    process.kill(id, name);
  } catch {
    // Процесс уже завершился.
  }
}

async function waitGone(id: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (exists(id)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

function readState(o: LaunchOptions): State {
  try {
    return JSON.parse(readFileSync(stateFile(o), 'utf8')) as State;
  } catch {
    return {};
  }
}

/** Процесс с этим pid - тот же, что записан: после перезагрузки pid мог достаться другому процессу. */
const same = (pid: unknown, started: unknown) => typeof pid === 'number' && typeof started === 'string' && startedAt(pid) === started;

/** Процессы, которые запустило это приложение и которые еще работают. */
function owned(saved: State): Partial<Record<Name, Entry>> {
  const result: Partial<Record<Name, Entry>> = {};
  for (const name of NAMES) {
    const e = saved[name];
    if (e && same(e.pgid, e.started)) result[name] = e;
  }
  return result;
}

const pgidsOf = (own: Partial<Record<Name, Entry>>) => NAMES.flatMap((n) => (own[n] ? [own[n].pgid] : []));

async function responds(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Отвечают и сервер, и интерфейс. */
async function isUp(o: LaunchOptions): Promise<boolean> {
  const [api, ui] = await Promise.all([responds(`${o.api}/health`), responds(o.ui)]);
  return api && ui;
}

/**
 * Останавливает процессы: сначала SIGTERM лидеру группы, чтобы сервер сам остановил агентов и сборки
 * и отметил прерванные шаги, затем SIGTERM и при необходимости SIGKILL всем, кто остался в группе.
 */
async function terminate(pgids: number[], timeoutMs: number): Promise<void> {
  await Promise.all(
    pgids.map(async (pgid) => {
      signal(pgid, 'SIGTERM');
      await waitGone(pgid, timeoutMs);
      signal(-pgid, 'SIGTERM');
      if (!(await waitGone(-pgid, 2000))) signal(-pgid, 'SIGKILL');
      await waitGone(-pgid, 2000);
    }),
  );
}

async function spawnDetached(p: ProcessSpec, env: NodeJS.ProcessEnv, out: number): Promise<number> {
  // detached: процесс становится лидером своей группы, и остановка завершает его вместе с дочерними.
  const child = spawn(p.command[0]!, p.command.slice(1), { cwd: p.cwd, env, detached: true, stdio: ['ignore', out, out] });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child.pid!;
}

function tail(file: string, lines: number): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Состояние Task Pilot. */
export async function status(o: LaunchOptions): Promise<LaunchStatus> {
  const saved = readState(o);
  // Во время перезапуска процессов может не быть, но Task Pilot свой: приложение в Dock не должно принять его за упавший.
  if (saved.restarting && same(saved.restarting.pid, saved.restarting.started)) return 'running:ours';
  const own = owned(saved);
  if (own.server && own.web) return 'running:ours';
  return (await isUp(o)) ? 'running:external' : 'stopped';
}

/**
 * Запускает сервер и интерфейс, если Task Pilot еще не работает, и ждет, пока оба ответят. Экземпляр,
 * запущенный иначе, не трогает. Если процесс завершился при запуске или не ответил вовремя, останавливает
 * запущенное и бросает ошибку с концом журнала.
 */
export async function start(o: LaunchOptions): Promise<'started' | 'running:ours' | 'running:external'> {
  const own = owned(readState(o));
  if (own.server && own.web) return 'running:ours';
  // Уцелевшая половина прошлого запуска (например, интерфейс пережил упавший сервер) заняла бы порт.
  if (own.server || own.web) await stop(o);
  if (await isUp(o)) return 'running:external';
  return launch(o);
}

/**
 * Перезапускает то, что запустил start, например после обновления кода сервера. Пока идет перезапуск, status
 * отвечает running:ours, и приложение в Dock не принимает его за остановку. Если выполняется прогон, не
 * перезапускает: шаги в работе прервались бы. Экземпляр, запущенный иначе, не трогает.
 */
export async function restart(o: LaunchOptions): Promise<'started' | 'running:external'> {
  const own = owned(readState(o));
  if (!own.server && !own.web && (await isUp(o))) return 'running:external';
  const active = await busy(o);
  if (active > 0) throw new Error(`Выполняется прогонов: ${active}. Перезапуск прервал бы их шаги`);
  const marker = { pid: process.pid, started: startedAt(process.pid) ?? '' };
  mkdirSync(o.data, { recursive: true });
  writeFileSync(stateFile(o), JSON.stringify({ ...own, restarting: marker } satisfies State));
  await terminate(pgidsOf(own), o.stopTimeoutMs ?? 15_000);
  return launch(o, marker);
}

/**
 * Запускает сервер и интерфейс и ждет, пока оба ответят. Метка перезапуска остается в launcher.json, пока новый
 * экземпляр не ответил, поэтому status не видит промежутка, в котором процессов уже нет или запущен только один.
 */
async function launch(o: LaunchOptions, restarting?: State['restarting']): Promise<'started'> {
  mkdirSync(o.data, { recursive: true });
  const log = logFile(o);
  if (existsSync(log)) renameSync(log, join(o.data, 'launcher.prev.log'));
  const state: State = { restarting };
  const save = () => writeFileSync(stateFile(o), JSON.stringify(state));
  const out = openSync(log, 'a');
  try {
    for (const name of NAMES) {
      const pgid = await spawnDetached(o[name], o.env, out);
      state[name] = { pgid, started: startedAt(pgid) ?? '' };
      save();
    }
    const deadline = Date.now() + (o.readyTimeoutMs ?? 60_000);
    for (;;) {
      if (await isUp(o)) {
        delete state.restarting;
        save();
        return 'started';
      }
      const dead = NAMES.filter((n) => !exists(state[n]!.pgid));
      if (dead.length) {
        const what = dead.length === 2 ? 'Сервер и интерфейс завершились' : dead[0] === 'server' ? 'Сервер завершился' : 'Интерфейс завершился';
        throw new Error(`${what} при запуске. Журнал: ${log}\n\n${tail(log, 15)}`);
      }
      if (Date.now() >= deadline) throw new Error(`Task Pilot не ответил за ${Math.round((o.readyTimeoutMs ?? 60_000) / 1000)} с. Журнал: ${log}\n\n${tail(log, 15)}`);
      await sleep(300);
    }
  } catch (e) {
    await terminate(pgidsOf(state), o.stopTimeoutMs ?? 15_000);
    rmSync(stateFile(o), { force: true });
    throw e;
  } finally {
    closeSync(out);
  }
}

/** Останавливает то, что запустил start. Экземпляр, запущенный иначе, не трогает. */
export async function stop(o: LaunchOptions): Promise<'stopped' | 'not-running'> {
  const pgids = pgidsOf(owned(readState(o)));
  // Сервер после SIGTERM останавливает агентов и сборки и помечает прерванные шаги, на это ему нужно до 12 с.
  await terminate(pgids, o.stopTimeoutMs ?? 15_000);
  rmSync(stateFile(o), { force: true });
  return pgids.length ? 'stopped' : 'not-running';
}

/** Сколько прогонов выполняется сейчас: их шаги прервутся, если остановить Task Pilot. */
export async function busy(o: LaunchOptions): Promise<number> {
  try {
    const r = await fetch(`${o.api}/runs`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return 0;
    const runs = (await r.json()) as { status?: unknown }[];
    return runs.filter((run) => run.status === 'running').length;
  } catch {
    return 0;
  }
}
