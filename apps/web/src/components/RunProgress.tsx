import { useQuery } from '@tanstack/react-query';
import type { StepStatus } from '@task-pilot/step-kit';
import type { RunViewDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { byRuns, forecastLine, roughly } from '../progress.ts';
import { STEP_LOOK } from '../status.tsx';
import { cx, Tip } from '../ui.tsx';

/** Цвет отрезка шага на полосе по его статусу. */
const SEGMENT: Record<StepStatus, string> = {
  succeeded: 'bg-emerald-500',
  already: 'bg-emerald-400',
  simulated: 'bg-violet-400',
  skipped: 'bg-slate-300 dark:bg-slate-600',
  running: 'bg-blue-500 animate-pulse',
  waiting_owner: 'bg-amber-400',
  waiting: 'bg-sky-400',
  failed: 'bg-red-500',
  blocked: 'bg-orange-400',
  pending: 'bg-slate-200 dark:bg-slate-700',
};

/**
 * Полоса шагов плана и прогноз над ней. Отрезок шага по ширине - его ожидаемое время, по цвету - статус; нажатие
 * переносит к шагу в списке. Строка над полосой говорит, сколько займет план до запуска, сколько сделано и осталось
 * в работе и за сколько прогон выполнен против прогноза при запуске.
 */
export function RunProgress({ view, onJump }: { view: RunViewDto; onJump: (stepId: string) => void }) {
  const id = view.run.id;
  const live = view.active || view.run.status === 'running' || view.run.status === 'waiting_owner' || view.run.status === 'waiting';
  // Идущий шаг прибавляет время каждую секунду: пока прогон идет, прогноз перечитывается чаще событий.
  const forecast = useQuery({ queryKey: ['forecast', id], queryFn: () => api.forecast(id), refetchInterval: live ? 5000 : false });
  const done = forecast.data?.percent === 100;
  const timing = useQuery({ queryKey: ['timing', id], queryFn: () => api.timing(id), enabled: done });
  const f = forecast.data;
  if (!f || !f.steps.length) return null;
  const byId = new Map(view.steps.map((s) => [s.stepId, s]));
  const started = view.run.status !== 'idle' || f.initial !== null;
  const factMs = timing.data ? timing.data.wallMs - timing.data.pauseMs : null;
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="font-medium tabular-nums">{forecastLine(f, started, factMs)}</span>
        {f.initial && !done && <span className="text-xs text-slate-500">прогноз при запуске: {roughly(f.initial.totalMs)}</span>}
      </div>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" role="list" aria-label="Шаги плана">
        {f.steps.map((s) => {
          const step = byId.get(s.stepId);
          if (!step) return null;
          const look = STEP_LOOK[step.status];
          const usual = s.runs ? `обычно ${roughly(s.expectedMs)}, ${byRuns(s.runs)}` : `примерно ${roughly(s.expectedMs)}, истории нет`;
          return (
            <div key={s.stepId} role="listitem" className="flex min-w-1.5" style={{ flexGrow: Math.max(s.expectedMs, 1), flexBasis: 0 }}>
              <Tip text={`${step.title}: ${look.label}, ${usual}. Нажмите, чтобы перейти к шагу`} className="w-full">
                <button
                  type="button"
                  aria-label={`${step.title}: ${look.label}`}
                  onClick={() => onJump(s.stepId)}
                  className={cx('h-3 w-full transition-opacity hover:opacity-75', SEGMENT[step.status])}
                />
              </Tip>
            </div>
          );
        })}
      </div>
    </div>
  );
}
