/** Сортировка таблицы: столбец и направление; null - порядок по умолчанию. */
export interface Sort<K extends string> {
  key: K;
  desc: boolean;
}

/**
 * Следующая сортировка по клику на столбец: числа сначала по убыванию, текстовые столбцы (text) по алфавиту; второй
 * клик меняет направление, третий возвращает порядок по умолчанию.
 */
export function nextSort<K extends string>(current: Sort<K> | null, key: K, text: readonly K[] = []): Sort<K> | null {
  const first = !text.includes(key);
  if (current?.key !== key) return { key, desc: first };
  if (current.desc === first) return { key, desc: !current.desc };
  return null;
}

/** Строки в порядке сортировки: без нее - как есть, числа по значению, текст по алфавиту. */
export function sortBy<T, K extends string>(rows: T[], sort: Sort<K> | null, value: (row: T, key: K) => number | string): T[] {
  if (!sort) return rows;
  const sign = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = value(a, sort.key);
    const y = value(b, sort.key);
    return sign * (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, 'ru') : Number(x) - Number(y));
  });
}
