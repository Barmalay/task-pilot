import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { api } from '../api.ts';
import { budgetBadge } from '../budget.ts';
import type { Look } from '../integrations.ts';
import { cx, Tip } from '../ui.tsx';

/** Цвет точки состояния доступа. */
export const DOT: Record<Look, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  fail: 'bg-red-500',
  wait: 'bg-slate-300 dark:bg-slate-600',
};

/** Расход агентов в шапке: виден, только когда он больше 80% лимита или лимит исчерпан; ведет на экран "История". */
export function BudgetBadge() {
  const budget = useQuery({ queryKey: ['budget'], queryFn: api.budget, refetchInterval: 60_000 });
  const shown = budgetBadge(budget.data);
  if (!shown) return null;
  return (
    <Tip text={`${shown.title}. Нажмите, чтобы открыть расход и лимиты`} className="min-w-0">
      <a
        href="#/history"
        className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <span className={cx('size-2 shrink-0 rounded-full', DOT[shown.look])} aria-hidden />
        <Wallet className="size-3.5 shrink-0 text-slate-500" aria-hidden />
        <span className="max-w-52 truncate text-slate-800 dark:text-slate-100">{shown.text}</span>
      </a>
    </Tip>
  );
}
