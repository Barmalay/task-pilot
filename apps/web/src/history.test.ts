import { describe, expect, it } from 'vitest';
import type { RunHistoryDto } from '@task-pilot/api-types';
import { dailyStats, filterHistory, NO_FILTER, sortHistory, stepTrend } from './history.ts';
import { nextSort } from './sort.ts';

const NOW = new Date(2026, 8, 25, 12, 0).getTime();
const daysAgo = (n: number, hour = 10) => new Date(2026, 8, 25 - n, hour, 0).toISOString();

function row(key: string, over: { start?: string | null; preset?: string; status?: string; live?: boolean; wallMs?: number; pauseMs?: number; costUsd?: number; summary?: string; steps?: { stepId: string; workMs: number }[]; failures?: number } = {}): RunHistoryDto {
  return {
    run: { id: key, issueKey: key, repoId: 'r', standId: null, presetId: over.preset ?? 'full', dryRun: false, status: (over.status ?? 'completed') as RunHistoryDto['run']['status'], createdAt: '', updatedAt: '' },
    summary: over.summary ?? null,
    timing: {
      start: over.start === undefined ? daysAgo(0) : over.start,
      end: null,
      live: over.live ?? false,
      wallMs: over.wallMs ?? 0,
      workMs: 0,
      agentMs: 0,
      systemMs: 0,
      questionsMs: 0,
      approvalsMs: 0,
      pauseMs: over.pauseMs ?? 0,
      otherMs: 0,
      costUsd: over.costUsd ?? 0,
      steps: (over.steps ?? []).map((s) => ({ ...s, title: s.stepId, attempts: 1, agentMs: 0, systemMs: 0, questionsMs: 0, approvalsMs: 0, costUsd: 0 })),
      questions: 0,
      approvals: 0,
    },
    features: { labels: [], components: [], type: null, acCount: null, files: null, loops: 0 },
    journal: { failures: over.failures ?? 0, reworks: 0, rejects: 0, loops: 0, denials: 0 },
    forecast: null,
  };
}

describe('history of runs', () => {
  const rows = [
    row('TEAM-2860', { summary: 'Метрика входа по телефону', status: 'completed', start: daysAgo(0) }),
    row('TEAM-2799', { preset: 'code-pr', status: 'paused', start: daysAgo(3) }),
    row('TEAM-2716', { live: true, status: 'waiting', start: daysAgo(40) }),
  ];

  it('filters by the task or its summary, preset, status of the run and the last days', () => {
    const keys = (f: Partial<typeof NO_FILTER>) => filterHistory(rows, { ...NO_FILTER, ...f }, NOW).map((h) => h.run.issueKey);
    expect(keys({ query: 'телефон' })).toEqual(['TEAM-2860']);
    expect(keys({ query: 'team-27' })).toEqual(['TEAM-2799', 'TEAM-2716']);
    expect(keys({ preset: 'code-pr' })).toEqual(['TEAM-2799']);
    // Идущий прогон ищется как идущий, а не по статусу его ожидания.
    expect(keys({ status: 'running' })).toEqual(['TEAM-2716']);
    expect(keys({ days: 7 })).toEqual(['TEAM-2860', 'TEAM-2799']);
  });

  it('sorts by a column: the time of the run is counted without its pauses', () => {
    const timed = [row('A', { wallMs: 10, pauseMs: 8 }), row('B', { wallMs: 5 }), row('C', { wallMs: 7, pauseMs: 1, failures: 3 })];
    expect(sortHistory(timed, nextSort(null, 'active')).map((h) => h.run.issueKey)).toEqual(['C', 'B', 'A']);
    expect(sortHistory(timed, nextSort(null, 'problems')).map((h) => h.run.issueKey)[0]).toBe('C');
    expect(sortHistory(timed, null).map((h) => h.run.issueKey)).toEqual(['A', 'B', 'C']);
  });

  it('sums the runs, their time without pauses and the cost by the day they started, with empty days in between', () => {
    const days = dailyStats([row('A', { start: daysAgo(0), wallMs: 3000, pauseMs: 1000, costUsd: 1.5 }), row('B', { start: daysAgo(0, 9), wallMs: 1000, costUsd: 0.5 }), row('C', { start: daysAgo(2) }), row('D', { start: null })], NOW, 3);
    expect(days).toEqual([
      { day: '2026-09-23', runs: 1, activeMs: 0, costUsd: 0 },
      { day: '2026-09-24', runs: 0, activeMs: 0, costUsd: 0 },
      { day: '2026-09-25', runs: 2, activeMs: 3000, costUsd: 2 },
    ]);
  });

  it('gives the work of a step over the runs in the order they started', () => {
    const trend = stepTrend(
      [row('new', { start: daysAgo(0), steps: [{ stepId: 'qa.stand', workMs: 30 }] }), row('old', { start: daysAgo(5), steps: [{ stepId: 'qa.stand', workMs: 10 }] }), row('none', { start: daysAgo(3) })],
      'qa.stand',
    );
    expect(trend).toEqual([10, 30]);
  });
});
