import { useQuery } from '@tanstack/react-query';
import { Hand, MessageCircleQuestion } from 'lucide-react';
import { api } from '../api.ts';
import { attentionAction, attentionCount, attentionRuns } from '../attention.ts';
import { ago, cx, Popover, Tip, useNow, usePopover } from '../ui.tsx';

/**
 * "Ждут вас" в шапке: сколько прогонов ждут подтверждения шага или ответа агенту, и список, из которого прогон
 * открывается в один клик с любого экрана. Когда ничего не ждет, кнопки нет. Список перечитывается по событиям общего
 * потока, раз в минуту - на случай, если поток прерывался.
 */
export function AttentionMenu() {
  const attention = useQuery({ queryKey: ['attention'], queryFn: api.attention, refetchInterval: 60_000 });
  const runs = attentionRuns(attention.data ?? []);
  const pop = usePopover();
  useNow(60_000);
  if (!runs.length) return null;
  return (
    <div ref={pop.ref} className="relative shrink-0">
      <Tip text="Прогоны, которые ждут вашего подтверждения или ответа агенту. Нажмите, чтобы выбрать прогон">
        <button
          type="button"
          onClick={pop.toggle}
          aria-expanded={pop.open}
          aria-label={attentionCount(runs.length)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900"
        >
          <Hand className="size-3.5" aria-hidden />
          <span className="hidden xl:inline">Ждут вас:</span>
          {runs.length}
        </button>
      </Tip>
      {pop.open && (
        <Popover label="Ждут вас">
          <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold dark:border-slate-800">{attentionCount(runs.length)}</div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {runs.map((r) => (
              <li key={r.runId}>
                <a href={`#/runs/${r.runId}`} className="block px-4 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800">
                  <div className="font-mono text-sm font-medium text-blue-700 dark:text-blue-300">{r.issueKey}</div>
                  {r.items.map((item, i) => {
                    const Icon = item.kind === 'approval' ? Hand : MessageCircleQuestion;
                    return (
                      <div key={`${item.kind}-${item.at}-${i}`} className="mt-1.5 flex gap-2 text-sm">
                        <Icon className={cx('mt-0.5 size-3.5 shrink-0', item.kind === 'approval' ? 'text-amber-600' : 'text-blue-600')} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="text-slate-800 dark:text-slate-100">{attentionAction(item)}</div>
                          <div className="line-clamp-2 text-xs text-slate-500">{item.text}</div>
                        </div>
                        <span className="shrink-0 text-xs text-slate-400">{ago(item.at)}</span>
                      </div>
                    );
                  })}
                </a>
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </div>
  );
}
