import { describe, expect, it } from 'vitest';
import { forecastMessage, forecastRun, roughly, stepNorms, type PlanStep, type StepNorm } from '../src/forecast.ts';
import { FakeCatalog, makeEngine, manifest } from './helpers.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function step(stepId: string, status: PlanStep['status'], over: Partial<PlanStep> = {}): PlanStep {
  return { stepId, selected: true, status, startedAt: null, kind: 'code', gate: 'none', ...over };
}

const norm = (workMs: number, ownerMs: number, runIds = ['r1']): StepNorm => ({ runIds, workMs, ownerMs });

describe('usual time of steps', () => {
  it('is the median of the work and the median of the owner waits over the runs where the step succeeded', () => {
    const norms = stepNorms([
      { runId: 'r1', stepId: 'code.implement', workMs: 10 * MIN, ownerMs: 0 },
      { runId: 'r2', stepId: 'code.implement', workMs: 14 * MIN, ownerMs: 2 * MIN },
      { runId: 'r3', stepId: 'code.implement', workMs: 90 * MIN, ownerMs: 60 * MIN },
      { runId: 'r2', stepId: 'git.prepare', workMs: 1000, ownerMs: 0 },
    ]);
    expect(norms.get('code.implement')).toEqual({ runIds: ['r1', 'r2', 'r3'], workMs: 14 * MIN, ownerMs: 2 * MIN });
    expect(norms.get('git.prepare')).toEqual({ runIds: ['r2'], workMs: 1000, ownerMs: 0 });
  });
});

describe('forecast of a run with background steps', () => {
  const norms = new Map([
    ['code.implement', norm(10 * MIN, 0)],
    ['wiki.update', norm(6 * MIN, 2 * MIN)],
    ['monitor.dashboard', norm(5 * MIN, 0)],
    ['task.finish', norm(30 * MIN, 0)],
  ]);
  const bg = (stepId: string, status: PlanStep['status'], over: Partial<PlanStep> = {}) => step(stepId, status, { background: true, ...over });

  it('leaves out a background step that ends while the chain still goes, but keeps the run below 100% until the step is done', () => {
    const plan = [step('code.implement', 'succeeded'), bg('wiki.update', 'running', { startedAt: new Date(NOW - MIN).toISOString() }), step('task.finish', 'succeeded')];
    const f = forecastRun(plan, norms, NOW);
    expect(f).toMatchObject({ totalMs: 40 * MIN, workMs: 40 * MIN, ownerMs: 0, remainingMs: 0, percent: 99 });
    expect(f.steps.map((s) => [s.stepId, s.expectedMs])).toEqual([
      ['code.implement', 10 * MIN],
      ['wiki.update', 0],
      ['task.finish', 30 * MIN],
    ]);
    expect(forecastRun([plan[0]!, { ...plan[1]!, status: 'succeeded' }, plan[2]!], norms, NOW).percent).toBe(100);
  });

  it('adds only how far the latest background step runs past the end of the chain', () => {
    // Вики после кода кончается через 8 минут после цепочки, дашборд рядом с ней - раньше и в прогноз не идет.
    const f = forecastRun([step('code.implement', 'succeeded'), bg('wiki.update', 'pending'), bg('monitor.dashboard', 'pending')], norms, NOW);
    expect(f).toMatchObject({ totalMs: 18 * MIN, workMs: 16 * MIN, ownerMs: 2 * MIN, doneMs: 10 * MIN, percent: 55 });
    expect(f.steps.map((s) => [s.stepId, s.expectedMs])).toEqual([
      ['code.implement', 10 * MIN],
      ['wiki.update', 8 * MIN],
      ['monitor.dashboard', 0],
    ]);
    // Пресет из одного фонового шага: его время и есть время прогона.
    expect(forecastRun([bg('monitor.dashboard', 'pending')], norms, NOW).totalMs).toBe(5 * MIN);
  });
});

describe('forecast of a run', () => {
  const norms = new Map([
    ['task.analyze', norm(4 * MIN, 1 * MIN, ['r1', 'r2'])],
    ['code.implement', norm(15 * MIN, 5 * MIN, ['r2', 'r3'])],
    ['code.publish', norm(1 * MIN, 4 * MIN, ['r3'])],
  ]);

  it('adds the usual time of the planned steps, splits the work and the owner waits and counts the runs it learned from', () => {
    const f = forecastRun([step('task.analyze', 'pending'), step('code.implement', 'pending'), step('code.publish', 'pending'), step('wiki.update', 'pending', { selected: false })], norms, NOW);
    expect(f).toMatchObject({ basis: 3, totalMs: 30 * MIN, workMs: 20 * MIN, ownerMs: 10 * MIN, doneMs: 0, remainingMs: 30 * MIN, percent: 0 });
    expect(f.steps).toEqual([
      { stepId: 'task.analyze', expectedMs: 5 * MIN, runs: 2 },
      { stepId: 'code.implement', expectedMs: 20 * MIN, runs: 2 },
      { stepId: 'code.publish', expectedMs: 5 * MIN, runs: 1 },
    ]);
  });

  it('fills by the expected time of the steps: a finished step whole, the running one by its elapsed time', () => {
    const f = forecastRun(
      [step('task.analyze', 'succeeded'), step('code.implement', 'running', { startedAt: new Date(NOW - 5 * MIN).toISOString() }), step('code.publish', 'pending')],
      norms,
      NOW,
    );
    expect(f).toMatchObject({ doneMs: 10 * MIN, remainingMs: 20 * MIN, percent: 33 });
  });

  it('does not reach 100% while a step runs longer than usual and reaches it when every planned step is over', () => {
    const late = forecastRun([step('task.analyze', 'succeeded'), step('code.implement', 'waiting_owner', { startedAt: new Date(NOW - 3 * 60 * MIN).toISOString() })], norms, NOW);
    expect(late.doneMs).toBe(5 * MIN + 18 * MIN);
    expect(late.percent).toBe(92);
    const over = forecastRun([step('task.analyze', 'succeeded'), step('code.implement', 'skipped'), step('code.publish', 'already')], norms, NOW);
    expect(over).toMatchObject({ percent: 100, remainingMs: 0, doneMs: 30 * MIN });
  });

  it('takes the time of a step without history from its kind, with a minute of waiting for a step with an approval', () => {
    const f = forecastRun([step('a.code', 'pending'), step('a.agent', 'pending', { kind: 'agent', gate: 'publish' }), step('a.manual', 'pending', { kind: 'manual' })], new Map(), NOW);
    expect(f.steps.map((s) => [s.stepId, s.expectedMs, s.runs])).toEqual([
      ['a.code', 30_000, 0],
      ['a.agent', 6 * MIN, 0],
      ['a.manual', 2 * MIN, 0],
    ]);
    expect(f).toMatchObject({ basis: 0, workMs: 5.5 * MIN, ownerMs: 3 * MIN });
  });

  it('is empty and at zero for a run without planned steps', () => {
    expect(forecastRun([step('a.one', 'pending', { selected: false })], norms, NOW)).toMatchObject({ totalMs: 0, percent: 0, steps: [] });
  });
});

describe('forecast texts', () => {
  it('round the time to minutes and name how many runs the forecast is based on', () => {
    expect(roughly(400)).toBe('1 с');
    expect(roughly(40_000)).toBe('40 с');
    expect(roughly(12.4 * MIN)).toBe('12 мин');
    expect(roughly(60 * MIN)).toBe('1 ч');
    expect(roughly(80 * MIN)).toBe('1 ч 20 мин');
    expect(forecastMessage({ totalMs: 70 * MIN, ownerMs: 20 * MIN, basis: 4 })).toBe('Прогноз прогона: примерно 1 ч 10 мин, из них ваши ответы и подтверждения 20 мин, по 4 прогонам');
    expect(forecastMessage({ totalMs: 30_000, ownerMs: 0, basis: 21 })).toBe('Прогноз прогона: примерно 30 с, по 21 прогону');
    expect(forecastMessage({ totalMs: 30_000, ownerMs: 0, basis: 0 })).toBe('Прогноз прогона: примерно 30 с, истории пока нет, время по видам шагов');
  });
});

describe('forecast service', () => {
  it('writes the forecast into the feed at the first start only and learns the usual time from each finished run', async () => {
    const work = { calls: 0 };
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        async run() {
          work.calls++;
          // Шаг без времени в историю не попадает: у настоящего шага время всегда есть.
          await new Promise((r) => setTimeout(r, 5));
          return {};
        },
      })
      .addPreset(['a.one']);
    const t = makeEngine(cat);
    const run = t.engine.createRun({ issueKey: 'TEAM-1' });
    expect(t.forecast.of(run.id)).toMatchObject({ basis: 0, totalMs: 30_000, percent: 0, initial: null });
    await t.engine.start(run.id);
    const forecasts = () => t.store.listEvents(run.id).filter((e) => e.type === 'run.forecast');
    expect(forecasts().map((e) => e.message)).toEqual(['Прогноз прогона: примерно 30 с, истории пока нет, время по видам шагов']);
    await t.engine.retry(run.id, 'a.one');
    expect(work.calls).toBe(2);
    expect(forecasts()).toHaveLength(1);
    expect(t.forecast.of(run.id)).toMatchObject({ percent: 100, initial: { totalMs: 30_000, basis: 0 } });

    // Прогноз прогона не учится на нем самом: у первого прогона истории по-прежнему нет, у следующего - первый.
    expect(t.forecast.of(run.id)).toMatchObject({ basis: 0, totalMs: 30_000 });
    const next = t.engine.createRun({ issueKey: 'TEAM-2' });
    const learned = t.forecast.of(next.id)!;
    expect(learned).toMatchObject({ basis: 1, steps: [{ stepId: 'a.one', runs: 1 }] });
    expect(learned.totalMs).toBeLessThan(30_000);
    expect(t.forecast.of('no-such-run')).toBeNull();
  });
});
