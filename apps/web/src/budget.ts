import type { BudgetDto, BudgetPeriodDto } from '@task-pilot/api-types';
import type { Shown } from './integrations.ts';

const usd = (v: number) => `$${v.toFixed(2)}`;

/** Расход периода: "$42.10 из $50" или "$42.10, без лимита". */
export function spentText(p: BudgetPeriodDto): string {
  return p.limitUsd === null ? `${usd(p.spentUsd)}, без лимита` : `${usd(p.spentUsd)} из $${p.limitUsd}`;
}

/** Доля лимита для полосы расхода, не больше 1; без лимита - null. */
export function share(p: BudgetPeriodDto): number | null {
  return p.limitUsd === null ? null : Math.min(1, p.spentUsd / p.limitUsd);
}

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Значок расхода агентов в шапке: только когда расход дня или недели больше 80% лимита (warn) или лимит исчерпан
 * (fail); в остальное время шапка значок не показывает.
 */
export function budgetBadge(b: BudgetDto | undefined): Shown | null {
  if (!b || b.level === 'ok') return null;
  const which = b.day.level === b.level ? b.day : b.week;
  const period = which === b.day ? 'день' : 'неделю';
  if (b.level === 'exhausted') {
    return { look: 'fail', text: 'лимит исчерпан', title: `Лимит расхода агентов на ${period} исчерпан: ${spentText(which)}. Новые агенты не запускаются до ${when(which.resetsAt)}` };
  }
  return { look: 'warn', text: spentText(which), title: `Расход агентов за ${period} больше 80% лимита: ${spentText(which)}` };
}

/** Значение поля лимита: пусто - без лимита, иначе положительное число долларов; иначе ошибка ввода. */
export function parseLimit(raw: string): number | null | 'invalid' {
  const v = raw.trim().replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 'invalid';
}
