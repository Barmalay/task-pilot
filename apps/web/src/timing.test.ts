import { describe, expect, it } from 'vitest';
import type { RunHistoryDto, RunTimingDto, StepTimingDto } from '@task-pilot/api-types';
import { nextSort } from './sort.ts';
import { activeMs, duration, ganttRows, shares, sortSteps, spent, stepStats, timeAxis, type StepSortKey } from './timing.ts';

const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const step = (stepId: string, over: Partial<StepTimingDto> = {}): StepTimingDto => ({
  stepId,
  title: `шаг ${stepId}`,
  attempts: 1,
  workMs: 0,
  agentMs: 0,
  systemMs: 0,
  questionsMs: 0,
  approvalsMs: 0,
  costUsd: 0,
  segments: [],
  ...over,
});

const timing = (over: Partial<RunTimingDto> = {}): RunTimingDto => ({
  start: at(0),
  end: at(1000),
  live: false,
  wallMs: 1_000_000,
  workMs: 0,
  agentMs: 0,
  systemMs: 0,
  questionsMs: 0,
  approvalsMs: 0,
  pauseMs: 0,
  otherMs: 0,
  costUsd: 0,
  steps: [],
  pauses: [],
  waits: [],
  ...over,
});

describe('run time for the screen', () => {
  it('writes durations in seconds, minutes and hours', () => {
    expect([duration(0), duration(45_400), duration(725_000), duration(4_800_000)]).toEqual(['0 с', '45 с', '12 мин 5 с', '1 ч 20 мин']);
  });

  it('marks time that did not happen with a dash and an instant step as less than a second', () => {
    expect([spent(0), spent(300), spent(61_000)]).toEqual(['-', '<1 с', '1 мин 1 с']);
  });

  it('lays every segment on the run line and puts pauses on top', () => {
    const rows = ganttRows(
      timing({
        pauses: [{ from: at(500), to: at(600) }],
        steps: [
          step('a', {
            segments: [
              { kind: 'agent', from: at(0), to: at(250) },
              { kind: 'question', from: at(250), to: at(251) },
            ],
          }),
        ],
      }),
    );
    expect(rows.map((r) => r.key)).toEqual(['pause', 'a']);
    expect(rows[0]!.bars[0]).toMatchObject({ kind: 'pause', left: 50, width: 10 });
    expect(rows[1]!.bars.map((b) => [b.kind, b.left, b.width])).toEqual([
      ['agent', 0, 25],
      ['question', 25, 0.4],
    ]);
  });

  it('shows no line for a run that has not started', () => {
    expect(ganttRows(timing({ start: null, end: null, wallMs: 0 }))).toEqual([]);
  });

  it('gives the shares of every kind of time that took place in the run without its pauses', () => {
    const t = timing({ agentMs: 500_000, questionsMs: 250_000, pauseMs: 250_000 });
    expect(activeMs(t)).toBe(750_000);
    expect(shares(t).map((x) => [x.kind, Math.round(x.percent * 10) / 10])).toEqual([
      ['agent', 66.7],
      ['question', 33.3],
    ]);
  });

  it('folds a long pause of the run into a narrow break so the work is not squeezed into a strip', () => {
    // Прогон 10000 с, из них 8000 с на паузе: работа занимает всю ось, пауза - метку в 2%.
    const t = timing({
      end: at(10_000),
      wallMs: 10_000_000,
      pauseMs: 8_000_000,
      pauses: [{ from: at(1000), to: at(9000) }],
      steps: [step('a', { segments: [{ kind: 'agent', from: at(0), to: at(1000) }] }), step('b', { segments: [{ kind: 'system', from: at(9000), to: at(10_000) }] })],
    });
    const axis = timeAxis(t)!;
    expect(axis.breaks).toEqual([{ left: 49, width: 2, ms: 8_000_000, from: at(1000), to: at(9000) }]);
    expect([axis.x(Date.parse(at(500))), axis.x(Date.parse(at(9500)))]).toEqual([24.5, 75.5]);
    expect(axis.at(75.5)).toBe(Date.parse(at(9500)));
    const rows = ganttRows(t, axis);
    expect(rows.map((r) => [r.key, r.bars.map((b) => [b.kind, b.left, b.width])])).toEqual([
      ['pause', []],
      ['a', [['agent', 0, 49]]],
      ['b', [['system', 51, 49]]],
    ]);
  });

  it('keeps a short pause in scale, zooms into a part of the run and hides the kinds of time the owner switched off', () => {
    const t = timing({
      pauses: [{ from: at(500), to: at(600) }],
      steps: [
        step('a', {
          segments: [
            { kind: 'agent', from: at(0), to: at(400) },
            { kind: 'approval', from: at(400), to: at(500) },
            { kind: 'agent', from: at(600), to: at(1000) },
          ],
        }),
      ],
    });
    expect(timeAxis(t)!.breaks).toEqual([]);
    const zoomed = timeAxis(t, { from: Date.parse(at(300)), to: Date.parse(at(700)) })!;
    expect(ganttRows(t, zoomed)[1]!.bars.map((b) => [b.kind, b.left, b.width])).toEqual([
      ['agent', 0, 25],
      ['approval', 25, 25],
      ['agent', 75, 25],
    ]);
    expect(ganttRows(t, zoomed, new Set(['agent']))[1]!.bars.map((b) => b.kind)).toEqual(['approval']);
  });

  it('sorts the steps table by a column and returns to the order of the run on the third click', () => {
    const steps = [step('a', { title: 'Бета', workMs: 5, attempts: 2 }), step('b', { title: 'Альфа', workMs: 9, attempts: 1 }), step('c', { title: 'Гамма', workMs: 1, attempts: 3 })];
    const ids = (sort: Parameters<typeof sortSteps>[1]) => sortSteps(steps, sort).map((s) => s.stepId);
    const text: StepSortKey[] = ['title'];
    let sort = nextSort<StepSortKey>(null, 'workMs', text);
    expect([sort, ids(sort)]).toEqual([{ key: 'workMs', desc: true }, ['b', 'a', 'c']]);
    sort = nextSort(sort, 'workMs', text);
    expect(ids(sort)).toEqual(['c', 'a', 'b']);
    sort = nextSort(sort, 'workMs', text);
    expect([sort, ids(sort)]).toEqual([null, ['a', 'b', 'c']]);
    // Названия шагов сначала по алфавиту, а не по убыванию.
    expect(ids(nextSort<StepSortKey>(null, 'title', text))).toEqual(['b', 'a', 'c']);
  });

  it('takes the median time of every step over the history so one long wait does not shift it', () => {
    const row = (steps: Omit<StepTimingDto, 'segments'>[]) => ({ timing: { steps } }) as unknown as RunHistoryDto;
    const strip = ({ segments: _s, ...rest }: StepTimingDto) => rest;
    const stats = stepStats([
      row([strip(step('code.implement', { workMs: 600_000, agentMs: 550_000 })), strip(step('qa.stand', { workMs: 3_000_000, questionsMs: 3_600_000 }))]),
      row([strip(step('code.implement', { workMs: 1_200_000, agentMs: 1_100_000, attempts: 2 }))]),
      row([strip(step('code.implement', { workMs: 900_000, agentMs: 800_000 }))]),
    ]);
    expect(stats.map((s) => [s.stepId, s.runs, s.workMs, s.agentMs, s.ownerMs, s.attempts])).toEqual([
      ['code.implement', 3, 900_000, 800_000, 0, 1],
      ['qa.stand', 1, 3_000_000, 0, 3_600_000, 1],
    ]);
  });
});
