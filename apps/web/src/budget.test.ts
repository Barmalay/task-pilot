import { describe, expect, it } from 'vitest';
import type { BudgetDto, BudgetPeriodDto } from '@task-pilot/api-types';
import { budgetBadge, parseLimit, share, spentText } from './budget.ts';

const period = (over: Partial<BudgetPeriodDto> = {}): BudgetPeriodDto => ({ spentUsd: 12.5, limitUsd: 50, level: 'ok', resetsAt: '2026-09-24T21:00:00.000Z', ...over });
const budget = (day: Partial<BudgetPeriodDto> = {}, week: Partial<BudgetPeriodDto> = {}): BudgetDto => {
  const d = period(day);
  const w = period({ limitUsd: 200, ...week });
  const order = { ok: 0, warn: 1, exhausted: 2 } as const;
  return { day: d, week: w, level: order[d.level] >= order[w.level] ? d.level : w.level };
};

describe('agent budget on screen', () => {
  it('shows the spend against the limit and a bar that stops at the limit', () => {
    expect(spentText(period())).toBe('$12.50 из $50');
    expect(spentText(period({ limitUsd: null }))).toBe('$12.50, без лимита');
    expect(share(period())).toBe(0.25);
    expect(share(period({ spentUsd: 70 }))).toBe(1);
    expect(share(period({ limitUsd: null }))).toBeNull();
  });

  it('puts a badge in the header only from 80% of a limit, naming the period that is closest to its limit', () => {
    expect(budgetBadge(undefined)).toBeNull();
    expect(budgetBadge(budget())).toBeNull();
    expect(budgetBadge(budget({ spentUsd: 42, level: 'warn' }))).toEqual({ look: 'warn', text: '$42.00 из $50', title: 'Расход агентов за день больше 80% лимита: $42.00 из $50' });
    expect(budgetBadge(budget({ spentUsd: 42, level: 'warn' }, { spentUsd: 201, level: 'exhausted', resetsAt: '2026-09-27T21:00:00.000Z' }))).toMatchObject({
      look: 'fail',
      text: 'лимит исчерпан',
      title: expect.stringContaining('Лимит расхода агентов на неделю исчерпан: $201.00 из $200. Новые агенты не запускаются до'),
    });
  });

  it('reads a limit from the field: empty is no limit, a comma is a decimal point, zero and words are errors', () => {
    expect(parseLimit('')).toBeNull();
    expect(parseLimit('  ')).toBeNull();
    expect(parseLimit('30')).toBe(30);
    expect(parseLimit('12,5')).toBe(12.5);
    expect(parseLimit('0')).toBe('invalid');
    expect(parseLimit('-1')).toBe('invalid');
    expect(parseLimit('много')).toBe('invalid');
  });
});
