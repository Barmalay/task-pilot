import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { PilotCheck, PilotPort, ShellPort } from '@task-pilot/step-kit';
import { journalOf } from './journal.ts';
import type { Redactor } from './lib/redact.ts';
import type { Store } from './store/db.ts';

/** Что не входит в копию Task Pilot: зависимости, сборка, данные и личные файлы. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.data', '.claude', '.idea']);
// .git бывает и файлом: в рабочей папке git worktree он ссылается на настоящий репозиторий, и git в копии работал бы с ним.
const SKIP_FILES = /^\.git$|^\.DS_Store$|\.log$|\.iml$/;
const OUTPUT_TAIL = 4000;
const CHECK_TIMEOUT_MS = 10 * 60_000;

/** Путь из overlay: только относительный и внутри корня. */
export function safeRelative(path: string): string {
  const rel = normalize(path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Путь ${path} вне Task Pilot`);
  return rel;
}

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) copyTree(join(src, e.name), join(dest, e.name));
    } else if (e.isFile() && !SKIP_FILES.test(e.name)) {
      copyFileSync(join(src, e.name), join(dest, e.name));
    }
  }
}

/**
 * Зависимости копии: своя папка node_modules, в которой каждая запись - ссылка на запись настоящей. Ссылка
 * на папку целиком не годится: vitest пишет кэш и временный конфиг в node_modules, а песочница пускает
 * запись только в копию.
 */
function linkModules(src: string, dest: string): void {
  const dirs = ['.', ...['apps', 'packages'].flatMap((d) => (existsSync(join(src, d)) ? readdirSync(join(src, d)).map((x) => join(d, x)) : []))];
  for (const d of dirs) {
    const from = join(src, d, 'node_modules');
    if (!existsSync(from)) continue;
    const to = join(dest, d, 'node_modules');
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (name === '.vite' || name === '.vite-temp') continue;
      symlinkSync(realpathSync(join(from, name)), join(to, name));
    }
  }
}

/** Копия Task Pilot без личных и служебных файлов, с зависимостями настоящей папки: для проверки правок и демо. */
export function copyPilotTree(root: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  copyTree(root, dest);
  linkModules(root, dest);
  return dest;
}

/** Суть вывода команды для человека: сколько тестов прошло и упало, сколько ошибок типов. */
export function checkSummary(command: string, code: number, output: string, timedOut: boolean): string {
  if (timedOut) return `Не уложилось в ${CHECK_TIMEOUT_MS / 60_000} мин`;
  if (command.includes('tsc')) {
    if (code === 0) return 'Типы в порядке';
    const errors = output.match(/error TS\d+/g)?.length ?? 0;
    return errors ? `Ошибок типов: ${errors}` : `Проверка типов упала, код ${code}`;
  }
  const line = /Tests\s+([^\n]*?)\s*\(\d+\)/.exec(output)?.[1];
  if (!line) return code === 0 ? 'Тесты прошли' : `Тесты не запустились, код ${code}`;
  const count = (what: string) => Number(new RegExp(`(\\d+) ${what}`).exec(line)?.[1] ?? 0);
  const parts = [`пройдено ${count('passed')}`, count('failed') ? `упало ${count('failed')}` : '', count('skipped') ? `пропущено ${count('skipped')}` : ''].filter(Boolean);
  return `Тесты: ${parts.join(', ')}`;
}

/**
 * Проверка правок Task Pilot: копия рабочей папки во временной папке, файлы overlay подменены или удалены,
 * затем проверка типов шагов и тесты tests в песочнице оболочки. Копия удаляется после проверки.
 */
export async function checkPilot(o: { root: string; shell: ShellPort; overlay: Record<string, string | null>; tests: string[]; signal?: AbortSignal }): Promise<PilotCheck> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-pilot-check-')));
  try {
    copyPilotTree(o.root, dir);
    for (const [path, text] of Object.entries(o.overlay)) {
      const file = join(dir, safeRelative(path));
      if (text === null) {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
    }
    const commands = ['node_modules/.bin/tsc -p steps --noEmit', ...(o.tests.length ? [`node_modules/.bin/vitest run ${o.tests.map((t) => `'${safeRelative(t).replace(/'/g, '')}'`).join(' ')}`] : [])];
    const results: PilotCheck['results'] = [];
    for (const command of commands) {
      const r = await o.shell.run(command, { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS, signal: o.signal });
      const output = r.output.replace(/\u001b\[[0-9;]*m/g, '').slice(-OUTPUT_TAIL);
      results.push({ command, ok: r.code === 0 && !r.timedOut, summary: checkSummary(command, r.code, output, r.timedOut), output });
      if (r.aborted) break;
    }
    return { ok: results.every((r) => r.ok), results };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Порт самого Task Pilot: журнал прогона из хранилища и проверка правок на копии. */
export function createPilotPort(d: { root: string; skillsDir: string; teamRules?: string; store: Store; redact: Redactor; shell: ShellPort; title: (stepId: string) => string }): PilotPort {
  return {
    root: d.root,
    skillsDir: d.skillsDir,
    ...(d.teamRules ? { teamRules: d.teamRules } : {}),
    async journal(runId) {
      return journalOf(d.store, runId, d.title, d.redact);
    },
    check(overlay, tests) {
      return checkPilot({ root: d.root, shell: d.shell, overlay, tests });
    },
  };
}
