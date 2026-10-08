import { matchesGlob } from 'node:path';
import type { TextStyle } from '../../packages/step-kit/src/index.ts';

/** Изменение файла в рабочей папке: M, A, D, R, C или ? для неотслеживаемого. */
export interface FileChange {
  path: string;
  status: string;
}

/** Файлы, которые не коммитятся никогда, даже если попали в allowlist профиля. */
export const NEVER_COMMIT = ['**/.claude/**', '**/.env', '**/.DS_Store', '**/.idea/**', '**/*.iml'];

/** Коды git status для путей с неразрешенным конфликтом слияния. */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Символы, которые запрещает личный стиль: е с точками, длинные тире, типографские кавычки. */
const STYLE_CHARS: Record<keyof TextStyle, string> = { yo: 'ёЁ', dash: '—–―', quotes: '«»„“”‹›‘' };

/** Символы, запрещенные включенными правилами стиля; null - стиль ничего не запрещает. */
function styleChars(style: TextStyle): RegExp | null {
  const chars = (Object.keys(STYLE_CHARS) as (keyof TextStyle)[]).filter((k) => style[k]).map((k) => STYLE_CHARS[k]).join('');
  return chars ? new RegExp(`[${chars}]`) : null;
}

interface Entry {
  xy: string;
  path: string;
  from?: string;
}

/** Записи git status --porcelain=v1 -z: у переименования и копии второй путь - исходный. */
function entries(out: string): Entry[] {
  const parts = out.split('\0');
  const list: Entry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const twoPaths = 'RC'.includes(xy[0]!) || 'RC'.includes(xy[1]!);
    list.push(twoPaths ? { xy, path, from: parts[++i] } : { xy, path });
  }
  return list;
}

/**
 * Разбирает git status --porcelain=v1 -z. Переименование (в индексе или в рабочей папке) дает два
 * изменения: новый путь и удаление старого, иначе коммит унес бы новый файл без удаления прежнего.
 * Файл, добавленный в индекс и затем удаленный (AD), изменением относительно HEAD не считается.
 */
export function parsePorcelain(out: string): FileChange[] {
  const list: FileChange[] = [];
  for (const e of entries(out)) {
    if (e.xy === '??') {
      list.push({ path: e.path, status: '?' });
      continue;
    }
    if (e.xy === 'AD') continue;
    const renamed = e.xy[0] === 'R' || e.xy[1] === 'R';
    const copied = e.xy[0] === 'C' || e.xy[1] === 'C';
    if (renamed || copied) {
      list.push({ path: e.path, status: renamed ? 'R' : 'C' });
      if (renamed && e.from) list.push({ path: e.from, status: 'D' });
      continue;
    }
    list.push({ path: e.path, status: e.xy[1] !== ' ' ? e.xy[1]! : e.xy[0]! });
  }
  return list;
}

/** Пути с неразрешенным конфликтом слияния. */
export function unmergedPaths(out: string): string[] {
  return entries(out)
    .filter((e) => UNMERGED.has(e.xy))
    .map((e) => e.path);
}

/** Делит изменения на то, что войдет в коммит по allowlist профиля, и все прочее. */
export function classify(changes: FileChange[], allow: string[]): { included: FileChange[]; excluded: FileChange[] } {
  const included: FileChange[] = [];
  const excluded: FileChange[] = [];
  for (const change of changes) {
    const never = NEVER_COMMIT.some((g) => matchesGlob(change.path, g));
    const allowed = allow.some((g) => matchesGlob(change.path, g));
    (allowed && !never ? included : excluded).push(change);
  }
  return { included, excluded };
}

/** Путь относится к тестам. */
export function isTestPath(path: string): boolean {
  return /(^|\/)src\/test\//.test(path);
}

/**
 * Тесты, которые ветка удаляет или меняет: владелец видит их на подтверждении отдельно, чтобы
 * зеленая сборка не получилась ослаблением тестов. Измененным считается файл, из которого что-то
 * удалено (reduced); файл, в который тесты только добавлены, попадает в extended и тревоги не вызывает.
 */
export function testChanges(changes: FileChange[], reduced: Set<string>): { deleted: string[]; modified: string[]; extended: string[] } {
  const tests = changes.filter((c) => isTestPath(c.path));
  const uniq = (list: string[]) => [...new Set(list)].sort();
  const changed = uniq(tests.filter((c) => c.status === 'M').map((c) => c.path));
  return {
    deleted: uniq(tests.filter((c) => c.status === 'D').map((c) => c.path)),
    modified: changed.filter((p) => reduced.has(p)),
    extended: changed.filter((p) => !reduced.has(p)),
  };
}

/** true, если в diff есть удаленные строки, а не только добавленные. */
export function removesLines(diff: string): boolean {
  return diff.split('\n').some((line) => line.startsWith('-') && !line.startsWith('---'));
}

/**
 * Файлы, в добавленных строках которых есть символы, запрещенные личным стилем: Javadoc, комментарии и строки логов
 * тоже тексты владельца. diff - вывод git diff без цвета. Без стиля запрещенных символов нет.
 */
export function styleOffenders(diff: string, newFiles: { path: string; text: string }[], style: TextStyle): string[] {
  const re = styleChars(style);
  if (!re) return [];
  const found = new Set<string>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('+') && re.test(line)) found.add(file);
  }
  for (const f of newFiles) if (re.test(f.text)) found.add(f.path);
  found.delete('');
  found.delete('/dev/null');
  return [...found].sort();
}
