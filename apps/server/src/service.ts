import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { GitPort, RunStatus } from '@task-pilot/step-kit';
import type { ServiceDocDto, ServiceDto, ServiceLogLineDto } from '@task-pilot/api-types';
import { EngineError } from './engine/errors.ts';
import type { Redactor } from './lib/redact.ts';
import type { Store } from './store/db.ts';

/**
 * Что сервер читает только при запуске: код сервера и пакетов, слои компании, зависимости и настройки Vite. Шаги и
 * пресеты каталог перезагружает сам, интерфейс обновляет сам Vite, поэтому их правки перезапуска не требуют. Профили
 * и team.yaml пакета команды лежат вне корня: их передает тот, кто собирает сведения.
 */
export const RESTART_AREAS = ['apps/server/src', 'packages/step-kit/src', 'packages/api-types/src', 'company', 'package.json', 'apps/server/package.json', 'apps/web/package.json', 'apps/web/vite.config.ts'];

/** Статусы прогонов, которые видны на экране: выполняющиеся и ждущие. */
const LIVE: RunStatus[] = ['running', 'waiting_owner', 'waiting'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.data']);
const LOG_LINES = 200;
const ACCEPTED_KEY = 'service.accepted';
/** Сколько после запроса перезапуска сервер считает, что перезапуск идет: дольше - перезапуск не удался. */
const RESTART_MS = 2 * 60_000;

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Файлы областей (папки и файлы от root или абсолютные пути), измененные после since, по алфавиту: внутри root - путь
 * от root, снаружи - от домашней папки через ~.
 */
export function changedSince(root: string, areas: string[], since: number): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (st.mtimeMs > since) out.push(path.startsWith(`${root}${sep}`) ? relative(root, path) : path.replace(homedir(), '~'));
      return;
    }
    if (!st.isDirectory()) return;
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      walk(join(path, e.name));
    }
  };
  for (const area of areas) walk(isAbsolute(area) ? area : join(root, area));
  return out.sort();
}

/**
 * Зависимости расходятся с pnpm-lock.yaml. Установленный lockfile pnpm кладет в node_modules/.pnpm/lock.yaml: пока он
 * совпадает с pnpm-lock.yaml, ставить нечего. Время файлов не годится: pnpm пишет их в одну секунду в любом порядке.
 */
export function installNeeded(root: string): boolean {
  const lock = join(root, 'pnpm-lock.yaml');
  if (!existsSync(lock)) return false;
  const installed = join(root, 'node_modules', '.pnpm', 'lock.yaml');
  return !existsSync(installed) || readFileSync(lock, 'utf8') !== readFileSync(installed, 'utf8');
}

/** Сервер с этим pid запустило приложение Task Pilot: он записан в launcher.json лидером группы процессов. */
export function launchedByApp(dataDir: string, pid: number): boolean {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'launcher.json'), 'utf8')) as { server?: { pgid?: unknown } };
    return state.server?.pgid === pid;
  } catch {
    return false;
  }
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
// Токены, которые могли попасть в вывод вместе с заголовком или параметром: значение заменяется целиком.
const TOKEN = /\b(Bearer\s+|(?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s"',;&]+/gi;

/** Уровень строки журнала по словам в ней: сервер пишет ошибки и предупреждения обычным текстом. */
export function lineLevel(text: string): ServiceLogLineDto['level'] {
  if (/\b(error|exception|fatal|failed)\b|ошибк|не сделан|не удалось|упал/i.test(text)) return 'error';
  if (/\bwarn(ing)?\b|предупреж|внимание|каталог:/i.test(text)) return 'warn';
  return null;
}

/** Последние строки журнала без цветов терминала и токенов; нет файла - пусто. */
export function logLines(file: string, redact: (text: string) => string, limit = LOG_LINES): ServiceLogLineDto[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').replace(ANSI, '').trimEnd().split('\n').slice(-limit);
  return lines.map((line) => {
    const text = redact(line.replace(TOKEN, '$1***'));
    return { text, level: lineLevel(text) };
  });
}

function docKind(name: string): ServiceDocDto['kind'] | null {
  if (/^acceptance.*\.md$/.test(name)) return 'acceptance';
  if (name === 'notes.md') return 'notes';
  if (name === 'plan.md') return 'plan';
  return null;
}

/**
 * Гайды приемки, журналы решений и планы в `.claude/<тема>/`, от свежих к старым. Принятым считается файл, который
 * владелец отметил и который с тех пор не менялся: правка файла снова выносит его на решение.
 */
export function docsOf(root: string, accepted: Record<string, number>): ServiceDocDto[] {
  const base = join(root, '.claude');
  if (!existsSync(base)) return [];
  const out: ServiceDocDto[] = [];
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'artifacts') continue;
    for (const f of readdirSync(join(base, dir.name), { withFileTypes: true })) {
      const kind = f.isFile() ? docKind(f.name) : null;
      if (!kind) continue;
      const path = `${dir.name}/${f.name}`;
      const full = join(base, path);
      const text = readFileSync(full, 'utf8');
      const modified = statSync(full).mtimeMs;
      out.push({
        path,
        title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path,
        kind,
        modified: new Date(modified).toISOString(),
        questions: /^#{2,4}\s.*(подтверд|открыт|вопрос)/im.test(text),
        accepted: accepted[path] !== undefined && modified <= accepted[path],
      });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Репозиторий Task Pilot: ветка, последние коммиты, незакоммиченные файлы и remote с расхождением. */
export async function repoOf(git: GitPort, root: string, redact: (text: string) => string): Promise<ServiceDto['repo']> {
  const out = async (args: string[]) => {
    const r = await git.tryRun(root, args);
    return r.code === 0 ? r.stdout : null;
  };
  const branch = (await out(['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? null;
  if (branch === null) return { branch: null, commits: [], dirty: [], remote: null, error: 'Папка Task Pilot не репозиторий git' };
  const commits = ((await out(['log', '-5', '--format=%h%x1f%s%x1f%cI'])) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', at = ''] = line.split('\x1f');
      return { hash, subject, at };
    });
  // Первые два знака строки status - код (индекс и рабочая папка), и пробел в нем значим: вывод не обрезается.
  const dirty = ((await out(['status', '--porcelain=v1'])) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  const name = ((await out(['remote'])) ?? '').split('\n').find(Boolean)?.trim();
  if (!name) return { branch, commits, dirty, remote: null, error: null };
  const url = redact(((await out(['remote', 'get-url', name])) ?? '').trim());
  const counts = (await out(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']))?.trim().split(/\s+/).map(Number);
  const [behind, ahead] = counts?.length === 2 && counts.every(Number.isFinite) ? counts : [null, null];
  return { branch, commits, dirty, remote: { name, url, ahead: ahead ?? null, behind: behind ?? null }, error: null };
}

/** Что нужно сведениям о Task Pilot. */
export interface ServiceInfoDeps {
  root: string;
  dataDir: string;
  /** Личные настройки: их сервер тоже читает только при запуске. */
  personalFile: string;
  /** Что еще сервер читает только при запуске вне корня: team.yaml и профили пакета команды. */
  teamAreas?: string[];
  store: Store;
  git: GitPort;
  redact: Redactor;
  /** Когда запущен сервер и его pid. */
  startedAt: Date;
  pid: number;
  /** Запуск перезапуска; по умолчанию - команда restart приложения Task Pilot отдельным процессом. */
  spawnRestart?: () => void;
}

/** Служебные сведения о запущенном Task Pilot и перезапуск с экрана "Служебное". */
export interface ServiceInfo {
  status(): Promise<ServiceDto>;
  /** Запускает перезапуск: при выполняющемся прогоне и у сервера, запущенного не приложением, отказывает. */
  restart(): void;
  /** Текст дока из списка на решение. */
  doc(path: string): string;
  /** Отмечает док принятым (или снимает отметку). */
  accept(path: string, accepted: boolean): void;
}

/**
 * Сведения о запущенном Task Pilot. Коммит при запуске запоминается при создании: сервер создает сведения сразу
 * после старта. Перезапуск делает команда restart приложения (`apps/server/src/launcher.ts`) отдельной группой
 * процессов: остановка сервера ее не задевает, а вывод идет в `.data/restart.log`.
 */
export async function createServiceInfo(d: ServiceInfoDeps): Promise<ServiceInfo> {
  const head = async () => {
    const r = await d.git.tryRun(d.root, ['rev-parse', '--short', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const commitAtStart = await head();
  let restartAt = 0;
  const acceptedMap = (): Record<string, number> => {
    try {
      return JSON.parse(d.store.setting(ACCEPTED_KEY) ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  };
  const runs = () => d.store.listRuns(500).filter((r) => LIVE.includes(r.status)).map((r) => ({ id: r.id, issueKey: r.issueKey, status: r.status }));
  const spawnRestart =
    d.spawnRestart ??
    (() => {
      const out = openSync(join(d.dataDir, 'restart.log'), 'w');
      try {
        spawn(process.execPath, [join(d.root, 'apps/server/src/launcher.ts'), 'restart'], { cwd: d.root, env: process.env, detached: true, stdio: ['ignore', out, out] }).unref();
      } finally {
        closeSync(out);
      }
    });
  const text = (value: string) => d.redact.text(value);
  const personal = () => (mtime(d.personalFile) > d.startedAt.getTime() ? [d.personalFile.replace(homedir(), '~')] : []);
  return {
    async status() {
      return {
        server: {
          startedAt: d.startedAt.toISOString(),
          node: process.version,
          commitAtStart,
          commitNow: await head(),
          launchedByApp: launchedByApp(d.dataDir, d.pid),
          changed: [...changedSince(d.root, [...RESTART_AREAS, ...(d.teamAreas ?? [])], d.startedAt.getTime()), ...personal()],
          installNeeded: installNeeded(d.root),
          runs: runs(),
        },
        repo: await repoOf(d.git, d.root, text),
        docs: docsOf(d.root, acceptedMap()),
        log: {
          current: logLines(join(d.dataDir, 'launcher.log'), text),
          previous: logLines(join(d.dataDir, 'launcher.prev.log'), text),
          restart: logLines(join(d.dataDir, 'restart.log'), text),
        },
        at: new Date().toISOString(),
      };
    },
    restart() {
      if (Date.now() - restartAt < RESTART_MS) throw new EngineError('Перезапуск уже идет', 409);
      const active = runs().filter((r) => r.status === 'running').length;
      if (active) throw new EngineError(`Выполняется прогонов: ${active}. Перезапуск прервал бы их шаги`, 409);
      if (!launchedByApp(d.dataDir, d.pid)) throw new EngineError('Сервер запущен не приложением Task Pilot, например командой pnpm dev: перезапустите его там, где запускали', 409);
      restartAt = Date.now();
      spawnRestart();
    },
    doc(path) {
      // Читается только файл из списка на решение: путь из запроса сверяется со списком, а не собирается сам.
      if (!docsOf(d.root, {}).some((x) => x.path === path)) throw new EngineError(`Дока ${path} нет среди гайдов и журналов в .claude`, 404);
      return text(readFileSync(join(d.root, '.claude', path), 'utf8'));
    },
    accept(path, accepted) {
      if (!docsOf(d.root, {}).some((x) => x.path === path)) throw new EngineError(`Дока ${path} нет среди гайдов и журналов в .claude`, 404);
      const map = acceptedMap();
      if (accepted) map[path] = mtime(join(d.root, '.claude', path));
      else delete map[path];
      d.store.setSetting(ACCEPTED_KEY, JSON.stringify(map));
    },
  };
}
