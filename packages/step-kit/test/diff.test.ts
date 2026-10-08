import { describe, expect, it } from 'vitest';
import { keptLines, lineDiff, patchHunks } from '../src/diff.ts';

describe('line diff', () => {
  it('marks removed and added lines and keeps a little context around them', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'].join('\n');
    expect(lineDiff(before, after, 1)).toEqual(['  c', '- d', '+ D', '  e', '  g', '+ h']);
  });

  it('is empty for equal texts', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([]);
  });

  it('tells which lines of the new text were already in the old one', () => {
    expect(keptLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([true, false, true, false]);
    expect(keptLines('', 'x')).toEqual([false]);
  });

  it('builds unified hunks with line numbers and context, joining close changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
    expect(patchHunks(before, after, 1)).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [' j', '+k'] },
    ]);
    expect(patchHunks(before, after, 4)).toHaveLength(1);
    expect(patchHunks('a\nb', 'a\nb')).toEqual([]);
  });

  it('shows a new file as one hunk of added lines', () => {
    expect(patchHunks('', 'x\ny')).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }]);
  });
});

