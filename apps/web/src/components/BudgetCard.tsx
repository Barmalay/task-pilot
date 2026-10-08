import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { BudgetLevel, BudgetPeriodDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { parseLimit, share, spentText } from '../budget.ts';
import { Button, Card, cx, ErrorBox, Loading } from '../ui.tsx';

const BAR: Record<BudgetLevel, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', exhausted: 'bg-red-500' };
const INPUT = 'w-28 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900';

function Period({ title, p }: { title: string; p: BudgetPeriodDto }) {
  const part = share(p);
  return (
    <div className="min-w-56 flex-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-slate-500">{title}</span>
        <span className="font-medium tabular-nums">{spentText(p)}</span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
        {part !== null && part > 0 && <div className={cx('h-2 rounded-full', BAR[p.level])} style={{ width: `${Math.max(2, part * 100)}%` }} />}
      </div>
    </div>
  );
}

const field = (v: number | null) => (v === null ? '' : String(v));

/**
 * Расход агентов за день и неделю по ценам API и лимиты на них. Когда лимит исчерпан, новые агенты не запускаются, а
 * тот, что уже работает, доделывает шаг; лимиты меняются здесь и действуют сразу.
 */
export function BudgetCard() {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ['budget'], queryFn: api.budget, refetchInterval: 60_000 });
  const [draft, setDraft] = useState<{ day: string; week: string } | null>(null);
  const save = useMutation({
    mutationFn: api.setBudget,
    onSuccess: (b) => {
      qc.setQueryData(['budget'], b);
      setDraft(null);
    },
  });
  if (budget.isPending) return <Loading text="Считаю расход агентов" />;
  if (budget.isError) return <ErrorBox error={budget.error} title="Не удалось узнать расход агентов" />;
  const b = budget.data;
  const values = draft ?? { day: field(b.day.limitUsd), week: field(b.week.limitUsd) };
  const day = parseLimit(values.day);
  const week = parseLimit(values.week);
  const invalid = day === 'invalid' || week === 'invalid';
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (day === 'invalid' || week === 'invalid') return;
    save.mutate({ dayUsd: day, weekUsd: week });
  };
  return (
    <Card className="p-4">
      <h2 className="font-semibold">Расход агентов</h2>
      <p className="text-xs text-slate-500">
        По ценам API: на подписке это не списание, а мера нагрузки. С 80% лимита в шапке появляется предупреждение, а когда лимит исчерпан, новые агенты не
        запускаются до следующего дня или недели; агент, который уже работает, доделывает шаг.
      </p>
      <div className="mt-3 flex flex-wrap gap-6">
        <Period title="Сегодня" p={b.day} />
        <Period title="Эта неделя" p={b.week} />
      </div>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
        <label className="text-xs text-slate-500">
          Лимит на день, $
          <input className={cx(INPUT, 'mt-1 block')} inputMode="decimal" placeholder="без лимита" value={values.day} onChange={(e) => setDraft({ ...values, day: e.target.value })} />
        </label>
        <label className="text-xs text-slate-500">
          Лимит на неделю, $
          <input className={cx(INPUT, 'mt-1 block')} inputMode="decimal" placeholder="без лимита" value={values.week} onChange={(e) => setDraft({ ...values, week: e.target.value })} />
        </label>
        <Button type="submit" size="sm" icon={Save} disabled={!draft || invalid || save.isPending} title="Сохранить лимиты: пустое поле - без лимита">
          Сохранить
        </Button>
        {invalid && <span className="text-xs text-red-700 dark:text-red-300">Лимит - положительное число долларов или пустое поле</span>}
        {save.error && <span className="text-xs text-red-700 dark:text-red-300">{save.error.message}</span>}
      </form>
    </Card>
  );
}
