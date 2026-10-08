import { describe, expect, it } from 'vitest';
import { diffStat, diffView, lineDiff } from './diff.ts';

describe('line diff of a monitoring file', () => {
  it('keeps common lines and marks the removed and added ones in place', () => {
    const d = lineDiff('id: rba\ntitle: A\npanels: []\n', 'id: rba\ntitle: B\npanels: []\nalerts: []\n');
    expect(d).toEqual([
      { kind: 'same', text: 'id: rba' },
      { kind: 'del', text: 'title: A' },
      { kind: 'add', text: 'title: B' },
      { kind: 'same', text: 'panels: []' },
      { kind: 'add', text: 'alerts: []' },
    ]);
    expect(diffStat(d)).toEqual({ added: 2, removed: 1 });
    expect(lineDiff('a\n', 'a\n')).toEqual([{ kind: 'same', text: 'a' }]);
  });

  it('folds common lines far from the changes into one skipped line', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const view = diffView(lineDiff(before, after), 2);
    expect(view[0]).toEqual({ kind: 'skip', count: 8 });
    expect(view.filter((l) => l.kind !== 'skip').map((l) => ('text' in l ? l.text : ''))).toEqual(['line 8', 'line 9', 'line 10', 'line ten', 'line 11', 'line 12']);
    expect(view.at(-1)).toEqual({ kind: 'skip', count: 7 });
  });
});
