import { describe, expect, it } from 'vitest';
import { loopRoundsOf, runTiming, type TimingEvent, type TimingInput } from '../src/timing.ts';

const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const run = (s: number, status: string): TimingEvent => ({ ts: at(s), type: 'run.status', stepId: null, message: null, data: { status } });
const step = (s: number, stepId: string, status: string): TimingEvent => ({ ts: at(s), type: 'step.status', stepId, message: null, data: { status } });
const ev = (s: number, type: string, stepId: string, message: string | null = null, data: unknown = null): TimingEvent => ({ ts: at(s), type, stepId, message, data });

function input(over: Partial<TimingInput>): TimingInput {
  return { now: at(10_000), events: [], restarts: [], questions: [], sessions: [], order: [], title: (id) => `шаг ${id}`, ...over };
}

describe('time of a run', () => {
  it('splits the work of every step into agent, system and answers to the agent and counts approvals, pauses and retries', () => {
    const t = runTiming(
      input({
        order: ['a.agent', 'b.gate', 'c.flaky'],
        events: [
          run(0, 'running'),
          step(0, 'a.agent', 'running'),
          step(70, 'a.agent', 'succeeded'),
          step(70, 'b.gate', 'running'),
          step(75, 'b.gate', 'waiting_owner'),
          ev(75, 'approval.requested', 'b.gate', 'Коммит, пуш и PR'),
          run(75, 'waiting_owner'),
          ev(135, 'approval.decided', 'b.gate', 'Подтверждено: Коммит, пуш и PR', { decision: 'approved' }),
          run(135, 'running'),
          step(136, 'b.gate', 'running'),
          step(140, 'b.gate', 'succeeded'),
          step(140, 'c.flaky', 'running'),
          step(150, 'c.flaky', 'failed'),
          run(150, 'failed'),
          run(250, 'running'),
          step(250, 'c.flaky', 'running'),
          step(260, 'c.flaky', 'succeeded'),
          run(260, 'completed'),
        ],
        sessions: [{ stepId: 'a.agent', startedAt: at(1), finishedAt: at(61), costUsd: 0.4 }],
        questions: [{ stepId: 'a.agent', question: 'Какой стенд?', status: 'answered', createdAt: at(20), answeredAt: at(50) }],
      }),
    );

    expect(t).toMatchObject({ start: at(0), end: at(260), live: false, wallMs: 260_000, pauseMs: 100_000, approvalsMs: 60_000, costUsd: 0.4 });
    expect(t.steps.map((s) => [s.stepId, s.workMs, s.agentMs, s.systemMs, s.questionsMs, s.approvalsMs, s.attempts])).toEqual([
      ['a.agent', 70_000, 30_000, 10_000, 30_000, 0, 1],
      ['b.gate', 9_000, 0, 9_000, 0, 60_000, 1],
      ['c.flaky', 20_000, 0, 20_000, 0, 0, 2],
    ]);
    expect(t).toMatchObject({ workMs: 99_000, agentMs: 30_000, systemMs: 39_000, questionsMs: 30_000, otherMs: 1_000 });
    expect(t.steps[0]!.segments.map((s) => [s.kind, s.from, s.to])).toEqual([
      ['system', at(0), at(1)],
      ['agent', at(1), at(20)],
      ['question', at(20), at(50)],
      ['agent', at(50), at(61)],
      ['system', at(61), at(70)],
    ]);
    expect(t.pauses).toEqual([{ from: at(150), to: at(250) }]);
    expect(t.waits).toEqual([
      { kind: 'question', stepId: 'a.agent', label: 'Какой стенд?', from: at(20), to: at(50), ms: 30_000, outcome: 'answered' },
      { kind: 'approval', stepId: 'b.gate', label: 'Коммит, пуш и PR', from: at(75), to: at(135), ms: 60_000, outcome: 'approved' },
    ]);
  });

  it('ends the work of a step at a server restart that left no status event and counts the stop as a pause', () => {
    const t = runTiming(
      input({
        order: ['a.step'],
        events: [run(0, 'running'), step(10, 'a.step', 'running'), run(100, 'running'), step(100, 'a.step', 'running'), step(110, 'a.step', 'succeeded'), run(110, 'completed')],
        restarts: [at(40)],
      }),
    );
    expect(t.steps.map((s) => [s.workMs, s.attempts])).toEqual([[40_000, 2]]);
    expect(t.pauseMs).toBe(60_000);
    expect(t.pauses).toEqual([{ from: at(40), to: at(100) }]);
  });

  it('counts the wait of a step for a build as its system work, not as a pause, also through a server restart', () => {
    const t = runTiming(
      input({
        order: ['ci.wait'],
        events: [run(0, 'running'), step(0, 'ci.wait', 'running'), step(10, 'ci.wait', 'waiting'), run(10, 'waiting'), run(100, 'running'), step(100, 'ci.wait', 'running'), step(110, 'ci.wait', 'succeeded'), run(110, 'completed')],
        restarts: [at(40)],
      }),
    );
    expect(t.steps.map((s) => [s.systemMs, s.attempts])).toEqual([[110_000, 1]]);
    expect(t.pauseMs).toBe(0);
    const live = runTiming(input({ now: at(70), order: ['ci.wait'], events: [run(0, 'running'), step(0, 'ci.wait', 'running'), step(10, 'ci.wait', 'waiting'), run(10, 'waiting')] }));
    expect(live).toMatchObject({ live: true, end: at(70), systemMs: 70_000, pauseMs: 0 });
  });

  it('shows the time of a background step in its row but leaves the part that ran beside the chain out of the totals, except its agent cost', () => {
    const t = runTiming(
      input({
        order: ['a.chain', 'b.wiki'],
        background: ['b.wiki'],
        events: [run(0, 'running'), step(0, 'a.chain', 'running'), step(0, 'b.wiki', 'running'), step(30, 'b.wiki', 'succeeded'), step(40, 'a.chain', 'succeeded'), run(40, 'completed')],
        sessions: [{ stepId: 'b.wiki', startedAt: at(0), finishedAt: at(30), costUsd: 0.5 }],
      }),
    );
    expect(t.steps.map((s) => [s.stepId, s.workMs])).toEqual([
      ['a.chain', 40_000],
      ['b.wiki', 30_000],
    ]);
    expect(t).toMatchObject({ wallMs: 40_000, workMs: 40_000, agentMs: 0, systemMs: 40_000, costUsd: 0.5, otherMs: 0 });
  });

  it('adds to the totals the time of background steps after the chain ended and counts two background steps at once only once', () => {
    const t = runTiming(
      input({
        order: ['a.chain', 'b.wiki', 'b.dash'],
        background: ['b.wiki', 'b.dash'],
        events: [
          run(0, 'running'),
          step(0, 'a.chain', 'running'),
          step(10, 'a.chain', 'succeeded'),
          step(10, 'b.wiki', 'running'),
          step(10, 'b.dash', 'running'),
          step(30, 'b.dash', 'succeeded'),
          step(40, 'b.wiki', 'waiting_owner'),
          ev(40, 'approval.requested', 'b.wiki', 'Страница вики'),
          ev(60, 'approval.decided', 'b.wiki', 'Подтверждено: Страница вики', { decision: 'approved' }),
          step(60, 'b.wiki', 'running'),
          step(70, 'b.wiki', 'succeeded'),
          run(70, 'completed'),
        ],
      }),
    );
    expect(t.steps.map((s) => [s.stepId, s.workMs, s.approvalsMs])).toEqual([
      ['a.chain', 10_000, 0],
      ['b.wiki', 40_000, 20_000],
      ['b.dash', 20_000, 0],
    ]);
    expect(t).toMatchObject({ wallMs: 70_000, workMs: 50_000, approvalsMs: 20_000, pauseMs: 0, otherMs: 0 });
  });

  it('keeps counting a live run up to now, including a question the owner has not answered yet', () => {
    const t = runTiming(
      input({
        now: at(70),
        order: ['qa.stand'],
        events: [run(0, 'running'), step(10, 'qa.stand', 'running')],
        sessions: [{ stepId: 'qa.stand', startedAt: at(10), finishedAt: null, costUsd: 0 }],
        questions: [{ stepId: 'qa.stand', question: 'Удалите куки и ответьте "удалил"', status: 'open', createdAt: at(30), answeredAt: null }],
      }),
    );
    expect(t).toMatchObject({ live: true, end: at(70), wallMs: 70_000, workMs: 60_000, agentMs: 20_000, questionsMs: 40_000 });
    expect(t.waits).toEqual([{ kind: 'question', stepId: 'qa.stand', label: 'Удалите куки и ответьте "удалил"', from: at(30), to: null, ms: 40_000, outcome: null }]);
  });

  it('closes a burned approval as stale and reads the outcome of old decisions from their message', () => {
    const t = runTiming(
      input({
        order: ['deploy.stand'],
        events: [
          run(0, 'running'),
          ev(5, 'approval.requested', 'deploy.stand', 'Деплой на stable'),
          ev(20, 'approval.stale', 'deploy.stand', 'Запрос подтверждения больше не нужен'),
          ev(30, 'approval.requested', 'deploy.stand', 'Деплой на testing-5'),
          ev(40, 'approval.requested', 'deploy.stand', 'Деплой на testing-5'),
          ev(50, 'approval.decided', 'deploy.stand', 'Отклонено: Деплой на testing-5'),
          run(50, 'paused'),
        ],
      }),
    );
    expect(t.waits.map((w) => [w.label, w.ms, w.outcome])).toEqual([
      ['Деплой на stable', 15_000, 'stale'],
      ['Деплой на testing-5', 10_000, 'stale'],
      ['Деплой на testing-5', 10_000, 'rejected'],
    ]);
    expect(t.approvalsMs).toBe(35_000);
    expect(t.end).toBe(at(50));
  });

  it('counts a start of a gate step that waits for approval before it works', () => {
    const t = runTiming(
      input({
        order: ['deploy.stand'],
        events: [
          run(0, 'running'),
          step(2, 'deploy.stand', 'waiting_owner'),
          ev(2, 'approval.requested', 'deploy.stand', 'Деплой на testing-5'),
          run(2, 'waiting_owner'),
          ev(62, 'approval.decided', 'deploy.stand', 'Подтверждено: Деплой на testing-5', { decision: 'approved' }),
          run(62, 'running'),
          step(63, 'deploy.stand', 'running'),
          step(223, 'deploy.stand', 'succeeded'),
          run(223, 'completed'),
        ],
      }),
    );
    expect(t.steps.map((s) => [s.stepId, s.attempts, s.workMs, s.approvalsMs])).toEqual([['deploy.stand', 1, 160_000, 60_000]]);
  });

  it('shows nothing for a run that was never started', () => {
    expect(runTiming(input({ events: [run(0, 'idle')] }))).toMatchObject({ start: null, end: null, wallMs: 0, steps: [], waits: [] });
  });
});

describe('rounds of the rework loops of a run', () => {
  it('sums the rounds of every loop of the run, not only the loop of the test', () => {
    expect(loopRoundsOf({ 'qa.fix': 2, 'pr.address-review': 1, 'task.rework': 1 })).toBe(4);
    expect(loopRoundsOf({ 'pr.address-review': 3 })).toBe(3);
  });

  it('counts no rounds for a run without loops or with a record of an unexpected form', () => {
    expect(loopRoundsOf(undefined)).toBe(0);
    expect(loopRoundsOf({})).toBe(0);
    expect(loopRoundsOf('2')).toBe(0);
    expect(loopRoundsOf({ 'qa.fix': '2', 'pr.address-review': 1 })).toBe(1);
  });
});
