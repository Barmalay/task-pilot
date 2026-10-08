import { describe, expect, it } from 'vitest';
import type { AttentionDto } from '@task-pilot/api-types';
import { attentionAction, attentionCount, attentionRuns, changesAttention } from './attention.ts';

const item = (runId: string, at: string, over: Partial<AttentionDto> = {}): AttentionDto => ({
  runId,
  issueKey: runId === 'r1' ? 'TEAM-7' : 'TEAM-8',
  kind: 'approval',
  step: 'Коммит, пуш и PR',
  text: 'TEAM-7: коммит, пуш и PR',
  at,
  ...over,
});

describe('what waits for the owner', () => {
  it('lists every run once, the one waiting longest first, with its items in the order they were asked', () => {
    const runs = attentionRuns([
      item('r2', '2026-09-30T10:05:00Z'),
      item('r1', '2026-09-30T10:07:00Z', { kind: 'question', step: 'Реализация' }),
      item('r1', '2026-09-30T10:01:00Z'),
    ]);
    expect(runs.map((r) => [r.issueKey, r.items.map((i) => i.at)])).toEqual([
      ['TEAM-7', ['2026-09-30T10:01:00Z', '2026-09-30T10:07:00Z']],
      ['TEAM-8', ['2026-09-30T10:05:00Z']],
    ]);
  });

  it('says what the owner has to do: approve a step or answer its agent', () => {
    expect(attentionAction({ kind: 'approval', step: 'Деплой на стенд' })).toBe('подтвердить шаг "Деплой на стенд"');
    expect(attentionAction({ kind: 'question', step: 'Реализация' })).toBe('ответить агенту шага "Реализация"');
  });

  it('counts the waiting runs in words with the right form', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map(attentionCount)).toEqual([
      '1 прогон ждет вас',
      '2 прогона ждут вас',
      '5 прогонов ждут вас',
      '11 прогонов ждут вас',
      '21 прогон ждет вас',
      '22 прогона ждут вас',
      '25 прогонов ждут вас',
    ]);
  });

  it('is read again after an approval or a question appears, is settled or burns, and after a run is deleted', () => {
    for (const type of ['approval.requested', 'approval.decided', 'approval.stale', 'question.asked', 'question.answered', 'question.expired', 'run.deleted']) expect(changesAttention(type)).toBe(true);
    for (const type of ['run.status', 'pr.merged', 'step.log']) expect(changesAttention(type)).toBe(false);
  });
});
