import { describe, expect, it } from 'vitest';
import { BudgetService, DEFAULT_BUDGET, levelOf, periodStarts } from '../src/budget.ts';
import { EventBus } from '../src/engine/events.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { Store } from '../src/store/db.ts';

/** База с прогоном и сервис лимитов; время сервиса - настоящее, как у сессий агентов в базе. */
function setup() {
  const store = new Store(':memory:');
  const bus = new EventBus(store, createRedactor([]));
  const run = store.createRun({ issueKey: 'TEAM-1', repoId: 'gate', standId: null, presetId: 'code-pr', dryRun: false }, [{ stepId: 'code.implement', selected: true }]);
  const budget = new BudgetService({ store, bus });
  /** Сессия агента, которая уже кончилась с расходом costUsd; finishedAt - когда (по умолчанию сейчас). */
  const spend = (costUsd: number, finishedAt?: Date) => {
    const s = store.createAgentSession({ sessionId: `s-${Math.random()}`, runId: run.id, stepId: 'code.implement', label: 'код', model: null });
    store.finishAgentSession(s.id, { status: 'succeeded', costUsd });
    if (finishedAt) store.db.prepare('UPDATE agent_sessions SET started_at = ?, finished_at = ? WHERE id = ?').run(finishedAt.toISOString(), finishedAt.toISOString(), s.id);
  };
  const events = () => store.listEvents(run.id).filter((e) => e.type.startsWith('budget.'));
  return { store, bus, run, budget, spend, events, target: { runId: run.id, stepId: 'code.implement' } };
}

describe('periods of the agent budget', () => {
  it('start the day at local midnight and the week on Monday', () => {
    const thursday = periodStarts(new Date(2026, 8, 24, 13, 30));
    expect(thursday).toEqual({ day: new Date(2026, 8, 24), nextDay: new Date(2026, 8, 25), week: new Date(2026, 8, 21), nextWeek: new Date(2026, 8, 28) });
    expect(periodStarts(new Date(2026, 8, 27, 23, 59)).week).toEqual(new Date(2026, 8, 21));
    expect(periodStarts(new Date(2026, 8, 28, 0, 5)).week).toEqual(new Date(2026, 8, 28));
    expect(periodStarts(new Date(2026, 11, 31, 12)).nextDay).toEqual(new Date(2027, 0, 1));
  });

  it('warn from 80% of the limit, are spent at the limit and never warn without one', () => {
    expect(levelOf(39.99, 50)).toBe('ok');
    expect(levelOf(40, 50)).toBe('warn');
    expect(levelOf(50, 50)).toBe('exhausted');
    expect(levelOf(1000, null)).toBe('ok');
  });
});

describe('agent budget', () => {
  it('has $50 a day and $200 a week until the owner changes them, and keeps the new limits in the database', () => {
    const t = setup();
    expect(t.budget.limits()).toEqual(DEFAULT_BUDGET);
    expect(t.budget.setLimits({ dayUsd: 30, weekUsd: null })).toMatchObject({ day: { limitUsd: 30 }, week: { limitUsd: null, level: 'ok' } });
    expect(new BudgetService({ store: t.store, bus: t.bus }).limits()).toEqual({ dayUsd: 30, weekUsd: null });
    const changed = t.store.db.prepare("SELECT message FROM events WHERE type = 'budget.changed' AND run_id IS NULL").all().map((r) => r.message);
    expect(changed).toEqual(['Лимиты расхода агентов: $30 в день, без лимита в неделю']);
    expect(() => t.budget.setLimits({ dayUsd: -1, weekUsd: 100 })).toThrow();
    expect(t.budget.limits()).toEqual({ dayUsd: 30, weekUsd: null });
  });

  it('counts the sessions of today and of this week only', () => {
    const t = setup();
    const now = new Date();
    const { day, week } = periodStarts(now);
    t.spend(1.25);
    t.spend(2, new Date(day.getTime() - 60_000));
    t.spend(4, new Date(week.getTime() - 60_000));
    const s = t.budget.status();
    expect(s.day.spentUsd).toBeCloseTo(1.25);
    // Минута до начала дня - это еще эта неделя, если сегодня не понедельник.
    expect(s.week.spentUsd).toBeCloseTo(day.getTime() === week.getTime() ? 1.25 : 3.25);
    expect(s.day.resetsAt).toBe(periodStarts(now).nextDay.toISOString());
  });

  it('refuses to start an agent once the day or the week limit is spent and says how to raise it', () => {
    const t = setup();
    t.budget.setLimits({ dayUsd: 1, weekUsd: null });
    t.spend(0.9);
    expect(() => t.budget.assertCanStart(t.target)).not.toThrow();
    t.spend(0.6);
    expect(() => t.budget.assertCanStart(t.target)).toThrow('Лимит расхода агентов на день исчерпан: $1.50 из $1. Новые агенты не запускаются до');
    expect(t.events().map((e) => e.type)).toEqual(['budget.exceeded']);
    t.budget.setLimits({ dayUsd: null, weekUsd: 1.2 });
    expect(() => t.budget.assertCanStart(t.target)).toThrow('Лимит расхода агентов на неделю исчерпан: $1.50 из $1.2');
    t.budget.setLimits({ dayUsd: 5, weekUsd: 5 });
    expect(() => t.budget.assertCanStart(t.target)).not.toThrow();
  });

  it('tells once when a session takes the spend over 80% of the limit and once when it spends the limit', () => {
    const t = setup();
    t.budget.setLimits({ dayUsd: 10, weekUsd: null });
    const session = (cost: number) => {
      t.spend(cost);
      t.budget.recorded(t.target, cost);
    };
    session(7);
    expect(t.events()).toEqual([]);
    session(1.5);
    session(0.5);
    expect(t.events().map((e) => e.message)).toEqual(['Расход агентов за день $8.50 из $10: больше 80% лимита']);
    session(1.5);
    expect(t.events().map((e) => e.type)).toEqual(['budget.warning', 'budget.exhausted']);
    expect(t.events()[1]?.message).toBe('Лимит расхода агентов на день исчерпан: $10.50 из $10, новые агенты не запустятся');
    t.budget.recorded(t.target, 0);
    expect(t.events()).toHaveLength(2);
  });
});
