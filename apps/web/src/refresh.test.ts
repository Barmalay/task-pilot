import type { QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchRefresh, refreshKeysOf } from './refresh.ts';

const RUN = 'r1';
// Список того, что устарело, движок кладет только в событие шага, который закончился.
const status = (value: string, refresh?: string[]) => ({ type: 'step.status', data: refresh ? { status: value, refresh } : { status: value } });

describe('what an event of the run makes stale', () => {
  it('rereads the run, its time, journal and forecast after an event that changes its state and not after the agent or step log', () => {
    expect(refreshKeysOf({ type: 'approval.requested', data: null }, RUN)).toEqual([
      ['run', RUN],
      ['timing', RUN],
      ['journal', RUN],
      ['forecast', RUN],
    ]);
    for (const type of ['step.log', 'agent.tool', 'agent.text', 'agent.progress']) expect(refreshKeysOf({ type, data: null }, RUN)).toEqual([]);
  });

  it('rereads only the questions about the run after a question of the owner and its answer', () => {
    for (const type of ['ask.asked', 'ask.answered', 'ask.failed']) expect(refreshKeysOf({ type, data: { askId: 'a1' } }, RUN)).toEqual([['asks', RUN]]);
  });

  it('rereads what the finished step changes by its manifest: the stands after the deploy, the gallery after a step with artifacts', () => {
    expect(refreshKeysOf(status('succeeded', ['stands']), RUN)).toEqual([['run', RUN], ['timing', RUN], ['journal', RUN], ['forecast', RUN], ['stands']]);
    expect(refreshKeysOf(status('failed', ['artifacts']), RUN)).toEqual([['run', RUN], ['timing', RUN], ['journal', RUN], ['forecast', RUN], ['artifacts', RUN]]);
    expect(refreshKeysOf(status('succeeded', ['stands', 'artifacts']), RUN)).toEqual([['run', RUN], ['timing', RUN], ['journal', RUN], ['forecast', RUN], ['stands'], ['artifacts', RUN]]);
  });

  it('does not reread the stands or the gallery while the step is still running or after a step that changes neither', () => {
    expect(refreshKeysOf(status('running'), RUN)).toEqual([['run', RUN], ['timing', RUN], ['journal', RUN], ['forecast', RUN]]);
    expect(refreshKeysOf(status('waiting_owner'), RUN)).toEqual([['run', RUN], ['timing', RUN], ['journal', RUN], ['forecast', RUN]]);
    expect(refreshKeysOf(status('succeeded'), RUN)).toEqual([['run', RUN], ['timing', RUN], ['journal', RUN], ['forecast', RUN]]);
    // Список читается только у события шага: чужое событие с тем же полем ничего не перечитывает.
    expect(refreshKeysOf({ type: 'run.status', data: { status: 'completed', refresh: ['stands'] } }, RUN)).toEqual([['run', RUN], ['timing', RUN], ['journal', RUN], ['forecast', RUN]]);
  });
});

describe('batch of rereads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(delayMs = 150) {
    const flushes: QueryKey[][] = [];
    return { flushes, batch: batchRefresh((keys) => flushes.push(keys), delayMs) };
  }

  it('turns a burst of events into one reread of each key after the delay', () => {
    const t = setup();
    for (let i = 0; i < 36; i++) t.batch.add([['run', RUN]]);
    t.batch.add([['run', RUN], ['stands']]);
    vi.advanceTimersByTime(149);
    expect(t.flushes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.flushes).toEqual([[['run', RUN], ['stands']]]);
  });

  it('keeps rereading at least once per delay under a steady stream of events', () => {
    const t = setup();
    for (let ms = 0; ms < 1000; ms += 50) {
      t.batch.add([['run', RUN]]);
      vi.advanceTimersByTime(50);
    }
    expect(t.flushes.length).toBeGreaterThanOrEqual(6);
    expect(t.flushes.every((keys) => keys.length === 1)).toBe(true);
  });

  it('starts a new batch for an event after the reread', () => {
    const t = setup();
    t.batch.add([['run', RUN]]);
    vi.advanceTimersByTime(150);
    t.batch.add([['artifacts', RUN]]);
    vi.advanceTimersByTime(150);
    expect(t.flushes).toEqual([[['run', RUN]], [['artifacts', RUN]]]);
  });

  it('schedules nothing for an event that makes nothing stale and drops the pending batch on cancel', () => {
    const t = setup();
    t.batch.add([]);
    expect(vi.getTimerCount()).toBe(0);
    t.batch.add([['run', RUN]]);
    t.batch.cancel();
    vi.advanceTimersByTime(1000);
    expect(t.flushes).toEqual([]);
    t.batch.add([['stands']]);
    vi.advanceTimersByTime(150);
    expect(t.flushes).toEqual([[['stands']]]);
  });
});
