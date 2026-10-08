import { describe, expect, it } from 'vitest';
import type { ForecastDto, RunHistoryDto, StepDto } from '@task-pilot/api-types';
import { byRuns, forecastAccuracy, forecastLine, roughly, stepGroups } from './progress.ts';

const MIN = 60_000;

const step = (stepId: string, status: StepDto['status'], selected = true) => ({ stepId, status, selected }) as StepDto;

const forecast = (over: Partial<ForecastDto> = {}): ForecastDto => ({
  basis: 4,
  totalMs: 70 * MIN,
  workMs: 50 * MIN,
  ownerMs: 20 * MIN,
  doneMs: 0,
  remainingMs: 70 * MIN,
  percent: 0,
  steps: [],
  initial: null,
  ...over,
});

describe('groups of steps in the run', () => {
  it('folds finished steps together, keeps the plan ahead in order and puts unplanned steps apart', () => {
    const g = stepGroups([
      step('git.prepare', 'succeeded'),
      step('task.analyze', 'skipped'),
      step('wiki.update', 'pending', false),
      step('code.implement', 'failed'),
      step('code.verify', 'pending'),
      step('pilot.retro', 'already', false),
    ]);
    expect(g.done.map((s) => s.stepId)).toEqual(['git.prepare', 'task.analyze', 'pilot.retro']);
    expect(g.ahead.map((s) => s.stepId)).toEqual(['code.implement', 'code.verify']);
    expect(g.off.map((s) => s.stepId)).toEqual(['wiki.update']);
    expect(g.current).toBe('code.implement');
  });

  it('points at the running or waiting step before a stuck one and at nothing when the plan is done', () => {
    expect(stepGroups([step('a', 'failed'), step('b', 'waiting_owner')]).current).toBe('b');
    expect(stepGroups([step('a', 'succeeded'), step('b', 'waiting'), step('c', 'pending')]).current).toBe('b');
    expect(stepGroups([step('a', 'succeeded'), step('b', 'pending', false)]).current).toBeNull();
  });

  it('shows in full every step that runs or waits at once: the chain step and the background steps beside it', () => {
    const g = stepGroups([step('a', 'succeeded'), step('wiki', 'waiting_owner'), step('dash', 'running'), step('finish', 'waiting'), step('retro', 'pending')]);
    expect(g.current).toBe('wiki');
    expect(g.live).toEqual(['wiki', 'dash', 'finish']);
  });

  it('shows in full only the first step ahead when nothing runs or waits, and nothing when the plan is done', () => {
    expect(stepGroups([step('a', 'failed'), step('b', 'pending')]).live).toEqual(['a']);
    expect(stepGroups([step('a', 'succeeded')]).live).toEqual([]);
  });
});

describe('forecast line', () => {
  it('tells before the start how long the plan takes and what it consists of', () => {
    expect(forecastLine(forecast(), false, null)).toBe('Примерно 1 ч 10 мин: работа 50 мин, ваши ответы и подтверждения 20 мин, по 4 прогонам');
    expect(forecastLine(forecast({ basis: 0, ownerMs: 0, totalMs: 50 * MIN }), false, null)).toBe('Примерно 50 мин: работа 50 мин, истории пока нет, время по видам шагов');
  });

  it('tells the percent and the time left while the run goes', () => {
    expect(forecastLine(forecast({ percent: 45, remainingMs: 25 * MIN }), true, null)).toBe('45%, осталось примерно 25 мин из 1 ч 10 мин, по 4 прогонам');
  });

  it('compares the time of the finished run with the forecast made at its start', () => {
    const done = forecast({ percent: 100, remainingMs: 0, initial: { totalMs: 70 * MIN, workMs: 50 * MIN, ownerMs: 20 * MIN, basis: 3, at: '2026-09-24T10:00:00Z' } });
    expect(forecastLine(done, true, 85 * MIN)).toBe('Выполнено за 1 ч 25 мин, прогноз при запуске 1 ч 10 мин (+21%)');
    expect(forecastLine(forecast({ percent: 100 }), true, 12 * MIN)).toBe('Выполнено за 12 мин');
  });

  it('rounds the time to minutes and agrees the number of runs', () => {
    expect(roughly(40_000)).toBe('40 с');
    expect(roughly(119 * MIN)).toBe('1 ч 59 мин');
    expect(byRuns(1)).toBe('по 1 прогону');
    expect(byRuns(11)).toBe('по 11 прогонам');
    expect(byRuns(21)).toBe('по 21 прогону');
  });
});

describe('accuracy of the forecast', () => {
  const row = (status: RunHistoryDto['run']['status'], wallMs: number, pauseMs: number, forecastMs: number | null) =>
    ({ run: { status }, timing: { wallMs, pauseMs }, forecast: forecastMs === null ? null : { totalMs: forecastMs } }) as RunHistoryDto;

  it('is the median error of finished runs against their forecast at start, without the pauses', () => {
    const history = [row('completed', 60 * MIN, 10 * MIN, 50 * MIN), row('completed', 30 * MIN, 0, 40 * MIN), row('completed', 100 * MIN, 0, 50 * MIN), row('running', 5 * MIN, 0, 60 * MIN)];
    expect(forecastAccuracy(history)).toEqual({ errorPercent: 25, runs: 3 });
    expect(forecastAccuracy(history, 1)).toEqual({ errorPercent: 0, runs: 1 });
  });

  it('is unknown while no finished run had a forecast', () => {
    expect(forecastAccuracy([row('completed', 60 * MIN, 0, null), row('paused', 10 * MIN, 0, 20 * MIN)])).toBeNull();
  });
});
