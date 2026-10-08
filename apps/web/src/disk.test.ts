import { describe, expect, it } from 'vitest';
import type { CacheDto } from '@task-pilot/api-types';
import { runCache, sizeText } from './disk.ts';

describe('sizes on screen', () => {
  it('show bytes below a kilobyte, one decimal below ten and whole numbers above', () => {
    expect(sizeText(0)).toBe('0 Б');
    expect(sizeText(1023)).toBe('1023 Б');
    expect(sizeText(1024)).toBe('1.0 КБ');
    expect(sizeText(5 * 1024 + 512)).toBe('5.5 КБ');
    expect(sizeText(300 * 1024)).toBe('300 КБ');
    expect(sizeText(12.4 * 1024 ** 2)).toBe('12 МБ');
    expect(sizeText(1.25 * 1024 ** 3)).toBe('1.3 ГБ');
    expect(sizeText(2048 * 1024 ** 3)).toBe('2048 ГБ');
  });
});

describe('cache of a run in the history', () => {
  const cache: CacheDto = { runs: [{ runId: 'r1', bytes: 4096, clearable: true }], runsBytes: 4096, clearableBytes: 4096, qa: { bytes: 0, running: false } };

  it('finds the files of the run and is empty for a run without files or before the answer', () => {
    expect(runCache(cache, 'r1')).toEqual({ runId: 'r1', bytes: 4096, clearable: true });
    expect(runCache(cache, 'r2')).toBeNull();
    expect(runCache(undefined, 'r1')).toBeNull();
  });
});
