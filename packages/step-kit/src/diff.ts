/** Строка сравнения двух текстов: общая, удаленная или добавленная. */
export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

/**
 * Построчное сравнение двух текстов по наибольшей общей подпоследовательности: каждая строка обоих текстов по порядку
 * с пометкой, общая она, удаленная или добавленная. При равном выборе сначала идет удаление: было-стало читается привычно.
 */
export function alignLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Длина наибольшей общей подпоследовательности с конца: по ней восстанавливается путь.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({ op: '-', text: a[i]! });
      i++;
    } else {
      out.push({ op: '+', text: b[j]! });
      j++;
    }
  }
  return out;
}

/** Для каждой строки нового текста: есть ли она без изменений в прежнем. */
export function keptLines(before: string, after: string): boolean[] {
  return alignLines(before, after)
    .filter((l) => l.op !== '-')
    .map((l) => l.op === ' ');
}

/**
 * Построчный дифф двух текстов для показа владельцу: общие строки с двумя пробелами, удаленные с "- ",
 * добавленные с "+ ". Длинные общие куски сворачиваются до context строк вокруг изменений.
 */
export function lineDiff(before: string, after: string, context = 2): string[] {
  const out = alignLines(before, after).map((l) => `${l.op === ' ' ? ' ' : l.op} ${l.text}`);
  const changed = out.map((line, k) => (line.startsWith('  ') ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return [];
  return out.filter((_line, k) => changed.some((c) => Math.abs(c - k) <= context));
}

/** Кусок унифицированного диффа: с какой строки и сколько строк в старом и новом тексте, строки с "-", "+" или пробелом. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * Унифицированный дифф с номерами строк, как его показывают git и CLI claude: изменения с context общими строками
 * вокруг, близкие изменения в одном куске. У нового файла (прежний текст пустой) один кусок из добавленных строк.
 */
export function patchHunks(before: string, after: string, context = 3): DiffHunk[] {
  const ops: DiffLine[] = before === '' ? after.split('\n').map((text) => ({ op: '+', text })) : alignLines(before, after);
  let oldNo = 1;
  let newNo = 1;
  const rows = ops.map((l) => {
    const row = { ...l, old: l.op === '+' ? null : oldNo, new: l.op === '-' ? null : newNo };
    if (l.op !== '+') oldNo++;
    if (l.op !== '-') newNo++;
    return row;
  });
  const changed = rows.flatMap((r, i) => (r.op === ' ' ? [] : [i]));
  const hunks: DiffHunk[] = [];
  for (let k = 0; k < changed.length; ) {
    const start = Math.max(0, changed[k]! - context);
    let end = Math.min(rows.length - 1, changed[k]! + context);
    let next = k + 1;
    while (next < changed.length && changed[next]! - context <= end + 1) end = Math.min(rows.length - 1, changed[next++]! + context);
    const slice = rows.slice(start, end + 1);
    // У куска без строк старого текста начало - строка, после которой идет вставка, как в git.
    const before = rows.slice(0, start);
    hunks.push({
      oldStart: slice.find((r) => r.old !== null)?.old ?? before.filter((r) => r.op !== '+').length,
      oldLines: slice.filter((r) => r.op !== '+').length,
      newStart: slice.find((r) => r.new !== null)?.new ?? before.filter((r) => r.op !== '-').length,
      newLines: slice.filter((r) => r.op !== '-').length,
      lines: slice.map((r) => `${r.op}${r.text}`),
    });
    k = next;
  }
  return hunks;
}
