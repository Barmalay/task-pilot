import { describe, expect, it } from 'vitest';
import { effectiveParams, NO_MOVE, paramProblem, stepManifestSchema, stepSettings } from '../src/index.ts';

const BOARD = {
  path: [
    { from: 'Open', id: '4', name: 'Start Progress', to: 'In Progress' },
    { from: 'In Progress', id: '971', name: 'Готово к ревью', to: 'Ready to Review' },
    { from: 'Ready to Review', id: '1091', name: 'Можно тестировать', to: 'In Testing' },
  ],
  after: ['MERGED'],
  milestones: { inProgress: 'In Progress', review: 'Ready to Review' },
};

const manifest = stepManifestSchema.parse({
  id: 'code.publish',
  title: 'Коммит, пуш и PR',
  hint: 'шаг',
  phase: 'code',
  kind: 'hybrid',
  params: {
    moveTo: { type: 'jiraStatus', label: 'Куда перевести задачу', milestone: 'review' },
    attempts: { type: 'select', label: 'Попыток', options: ['1', '3'], default: '3' },
    draft: { type: 'boolean', label: 'Черновик PR' },
  },
});

describe('settings of a step', () => {
  it('offers the usual milestone, no move and every board status for a move and takes the value from the run, the preset or the manifest', () => {
    const s = stepSettings(manifest, BOARD, { attempts: '1' }, { moveTo: NO_MOVE });
    expect(s.map((x) => [x.key, x.value, x.defaultValue, x.source])).toEqual([
      ['moveTo', NO_MOVE, '', 'run'],
      ['attempts', '1', '1', 'preset'],
      ['draft', false, false, 'manifest'],
    ]);
    expect(s[0]!.options.map((o) => o.label)).toEqual(['как обычно (Ready to Review)', 'не переводить', 'Open', 'In Progress', 'Ready to Review', 'In Testing', 'MERGED']);
  });

  it('gives the step the milestone status for the usual move, the chosen status or no move', () => {
    expect(effectiveParams(manifest, BOARD).moveTo).toBe('Ready to Review');
    expect(effectiveParams(manifest, BOARD, { moveTo: 'In Testing' }).moveTo).toBe('In Testing');
    expect(effectiveParams(manifest, BOARD, { moveTo: 'In Testing' }, { moveTo: NO_MOVE })).toEqual({ moveTo: NO_MOVE, attempts: '3', draft: false });
  });

  it('refuses a value that is not among the options or has the wrong type', () => {
    const [move, attempts, draft] = stepSettings(manifest, BOARD);
    expect(paramProblem(move!, 'Closed')).toBe('"Куда перевести задачу": варианта "Closed" нет');
    expect(paramProblem(move!, 'In Testing')).toBeNull();
    expect(paramProblem(attempts!, '2')).toBe('"Попыток": варианта "2" нет');
    expect(paramProblem(draft!, 'да')).toBe('"Черновик PR": нужно да или нет');
  });

  it('needs the milestone of a move setting in the manifest', () => {
    const bad = stepManifestSchema.safeParse({ id: 'jira.start', title: 'В работу', hint: 'шаг', phase: 'task', kind: 'code', params: { moveTo: { type: 'jiraStatus', label: 'Куда' } } });
    expect(bad.success).toBe(false);
  });
});
