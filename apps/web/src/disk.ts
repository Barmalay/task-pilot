import type { CacheDto } from '@task-pilot/api-types';

const UNITS = ['КБ', 'МБ', 'ГБ'];

/** Размер для экрана: до килобайта в байтах, дальше КБ, МБ или ГБ, меньше десяти - с одной цифрой после точки. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** Что показать в колонке "Кэш" для прогона: размер его файлов и можно ли их очистить; null - файлов нет. */
export function runCache(cache: CacheDto | undefined, runId: string): { bytes: number; clearable: boolean } | null {
  return cache?.runs.find((r) => r.runId === runId) ?? null;
}
