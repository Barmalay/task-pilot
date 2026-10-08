import { useQuery } from '@tanstack/react-query';
import { Crosshair } from 'lucide-react';
import { api } from '../api.ts';
import { JOURNAL_LOOK, journalRows } from '../journal.ts';
import { clock } from '../timing.ts';
import { Button, Card, Chip } from '../ui.tsx';

/**
 * Сбои и правки прогона: падения шагов, ваши решения "Переделать" и "Отклонить" с замечаниями, круги петель
 * доработки и отказы агенту в инструментах, новые сверху. Клик по записи открывает ее событие в ленте с
 * подробностями, кнопка рядом показывает шаг в списке. По этому журналу шаг "Разбор прогона" предлагает правки
 * промптов и скиллов. Пустой журнал карточку не показывает.
 */
export function JournalPanel({ runId, onOpen, onJump }: { runId: string; onOpen: (eventId: number) => void; onJump: (stepId: string) => void }) {
  const q = useQuery({ queryKey: ['journal', runId], queryFn: () => api.journal(runId) });
  const rows = q.data ? journalRows(q.data) : [];
  if (!rows.length) return null;
  // Журнал долгого прогона тянется на несколько дней: тогда записи идут под заголовками дней.
  const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const days = new Set(rows.map((r) => day(r.at))).size > 1;
  return (
    <Card>
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">Сбои и правки</h2>
        <p className="text-xs text-slate-500">Новые сверху. По ним шаг "Разбор прогона" предлагает правки промптов и скиллов</p>
      </div>
      <ul className="space-y-0.5 px-2 py-2 text-xs">
        {rows.map((r, i) => {
          const event = r.eventId;
          const when = new Date(r.at).toLocaleString('ru-RU');
          const header = days && (i === 0 || day(rows[i - 1]!.at) !== day(r.at));
          return (
            <li key={`${r.kind}-${r.stepId}-${r.at}`} className="group flex flex-wrap items-start gap-1">
              {header && <div className="w-full px-2 pt-2 pb-0.5 text-[11px] font-medium text-slate-500">{day(r.at)}</div>}
              <button
                type="button"
                disabled={event === undefined}
                onClick={() => event !== undefined && onOpen(event)}
                title={event !== undefined ? `${when}. Открыть в ленте с подробностями` : when}
                className="grid min-w-0 flex-1 grid-cols-[3rem_7rem_minmax(0,1fr)] items-baseline gap-2 rounded-md px-2 py-1 text-left enabled:hover:bg-slate-50 dark:enabled:hover:bg-slate-800/60"
              >
                <span className="text-slate-500 tabular-nums">{clock(r.at)}</span>
                <Chip tone={JOURNAL_LOOK[r.kind].tone} className="justify-self-start">
                  {JOURNAL_LOOK[r.kind].label}
                </Chip>
                <span className="min-w-0 text-slate-800 dark:text-slate-200">
                  <span className="font-medium">{r.step}</span>: <span className="line-clamp-3 break-words">{r.text}</span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                icon={Crosshair}
                className="opacity-60 group-hover:opacity-100"
                onClick={() => onJump(r.stepId)}
                aria-label={`К шагу "${r.step}"`}
                title={`Показать шаг "${r.step}" в списке шагов`}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
