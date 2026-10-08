import { z } from 'zod';
import type { EventBus } from './engine/events.ts';
import type { BudgetDto, BudgetLevel, BudgetPeriodDto } from '@task-pilot/api-types';

/** Лимиты расхода агентов в долларах по ценам API: на день и на неделю; null - без лимита. */
export interface BudgetLimits {
  dayUsd: number | null;
  weekUsd: number | null;
}

/** Лимиты по умолчанию, пока владелец их не поменял. */
export const DEFAULT_BUDGET: BudgetLimits = { dayUsd: 50, weekUsd: 200 };
/** Доля лимита, после которой расход подсвечивается предупреждением. */
export const WARN_SHARE = 0.8;

const SETTING = 'budget';

export const budgetLimitsSchema = z.strictObject({
  dayUsd: z.number().positive().max(10_000).nullable(),
  weekUsd: z.number().positive().max(100_000).nullable(),
});

/** Что учету расхода нужно от хранилища: сумма расхода агентов с момента и настройка лимитов. */
export interface BudgetStore {
  agentSpendSince(iso: string): number;
  setting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

/** Начало текущего дня и недели (с понедельника) и начало следующих по местному времени машины. */
export function periodStarts(now: Date): { day: Date; nextDay: Date; week: Date; nextWeek: Date } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const week = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
  const nextWeek = new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7);
  return { day, nextDay, week, nextWeek };
}

/** Состояние расхода относительно лимита: с WARN_SHARE лимита - предупреждение, с лимита - исчерпан. */
export function levelOf(spentUsd: number, limitUsd: number | null): BudgetLevel {
  if (limitUsd === null) return 'ok';
  if (spentUsd >= limitUsd) return 'exhausted';
  return spentUsd >= limitUsd * WARN_SHARE ? 'warn' : 'ok';
}

const WORSE: Record<BudgetLevel, number> = { ok: 0, warn: 1, exhausted: 2 };
const worst = (a: BudgetLevel, b: BudgetLevel): BudgetLevel => (WORSE[a] >= WORSE[b] ? a : b);
const usd = (v: number) => `$${v.toFixed(2)}`;
const limitText = (v: number | null) => (v === null ? 'без лимита' : `$${v}`);
const PERIOD_NAME = { day: 'день', week: 'неделю' } as const;

/**
 * Расход агентов и лимиты на день и неделю. Перед запуском агента лимит проверяется: исчерпан - агент не
 * запускается, а тот, что уже работает, доделывает шаг. Расход сессии записывается, когда она кончилась, поэтому
 * работающие сессии в сумме пока не видны.
 */
export class BudgetService {
  private readonly d: { store: BudgetStore; bus: EventBus };
  private readonly now: () => Date;

  constructor(deps: { store: BudgetStore; bus: EventBus; now?: () => Date }) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Текущие лимиты: заданные владельцем или по умолчанию. */
  limits(): BudgetLimits {
    const raw = this.d.store.setting(SETTING);
    if (!raw) return DEFAULT_BUDGET;
    try {
      return budgetLimitsSchema.parse(JSON.parse(raw));
    } catch {
      return DEFAULT_BUDGET;
    }
  }

  /** Меняет лимиты: действуют сразу, в том числе для шагов, которые ждут запуска агента. */
  setLimits(limits: BudgetLimits): BudgetDto {
    const next = budgetLimitsSchema.parse(limits);
    this.d.store.setSetting(SETTING, JSON.stringify(next));
    this.d.bus.emitEvent({ type: 'budget.changed', message: `Лимиты расхода агентов: ${limitText(next.dayUsd)} в день, ${limitText(next.weekUsd)} в неделю`, data: next });
    return this.status();
  }

  /** Расход за текущие день и неделю относительно лимитов. */
  status(): BudgetDto {
    const limits = this.limits();
    const p = periodStarts(this.now());
    const period = (from: Date, to: Date, limitUsd: number | null): BudgetPeriodDto => {
      const spentUsd = this.d.store.agentSpendSince(from.toISOString());
      return { spentUsd, limitUsd, level: levelOf(spentUsd, limitUsd), resetsAt: to.toISOString() };
    };
    const day = period(p.day, p.nextDay, limits.dayUsd);
    const week = period(p.week, p.nextWeek, limits.weekUsd);
    return { day, week, level: worst(day.level, week.level) };
  }

  /** Перед запуском агента: лимит дня или недели исчерпан - отказ с объяснением и событие в ленте прогона. */
  assertCanStart(target: { runId: string | null; stepId: string | null }): void {
    const s = this.status();
    const which = s.day.level === 'exhausted' ? 'day' : s.week.level === 'exhausted' ? 'week' : null;
    if (!which) return;
    const p = s[which];
    const until = new Date(p.resetsAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const message = `Лимит расхода агентов на ${PERIOD_NAME[which]} исчерпан: ${usd(p.spentUsd)} из ${limitText(p.limitUsd)}. Новые агенты не запускаются до ${until}; поднять лимит можно на экране "История"`;
    this.d.bus.emitEvent({ runId: target.runId, stepId: target.stepId, type: 'budget.exceeded', message, data: { period: which, spentUsd: p.spentUsd, limitUsd: p.limitUsd } });
    throw new Error(message);
  }

  /** После сессии агента: если ее расход перевел день или неделю через WARN_SHARE лимита или через лимит - событие. */
  recorded(target: { runId: string | null; stepId: string | null }, costUsd: number): void {
    if (!(costUsd > 0)) return;
    const s = this.status();
    for (const which of ['day', 'week'] as const) {
      const p = s[which];
      const before = levelOf(p.spentUsd - costUsd, p.limitUsd);
      if (WORSE[p.level] <= WORSE[before]) continue;
      const message =
        p.level === 'exhausted'
          ? `Лимит расхода агентов на ${PERIOD_NAME[which]} исчерпан: ${usd(p.spentUsd)} из ${limitText(p.limitUsd)}, новые агенты не запустятся`
          : `Расход агентов за ${PERIOD_NAME[which]} ${usd(p.spentUsd)} из ${limitText(p.limitUsd)}: больше ${WARN_SHARE * 100}% лимита`;
      this.d.bus.emitEvent({ runId: target.runId, stepId: target.stepId, type: p.level === 'exhausted' ? 'budget.exhausted' : 'budget.warning', message, data: { period: which, spentUsd: p.spentUsd, limitUsd: p.limitUsd } });
    }
  }
}
