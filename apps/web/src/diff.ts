/** Строка построчного диффа: общая, добавленная или убранная. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Построчный дифф двух текстов по наибольшей общей подпоследовательности: файлы мониторинга небольшие. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i][j] - длина общей подпоследовательности хвостов a[i..] и b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! });
  while (j < m) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

/** Дифф для экрана: общие строки дальше context от изменений сворачиваются в одну строку "пропущено N". */
export function diffView(lines: DiffLine[], context = 3): (DiffLine | { kind: 'skip'; count: number })[] {
  const near = lines.map((_, i) => lines.slice(Math.max(0, i - context), i + context + 1).some((l) => l.kind !== 'same'));
  const out: (DiffLine | { kind: 'skip'; count: number })[] = [];
  lines.forEach((l, i) => {
    if (l.kind !== 'same' || near[i]) out.push(l);
    else {
      const last = out.at(-1);
      if (last?.kind === 'skip') last.count++;
      else out.push({ kind: 'skip', count: 1 });
    }
  });
  return out;
}

/** Сколько строк добавлено и убрано. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length };
}
