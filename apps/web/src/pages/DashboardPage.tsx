import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Period, Refresh } from '@task-pilot/step-kit';
import type { DashboardDataDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { AlertRow, LoadLine } from '../components/MonitorBits.tsx';
import { EditButton, EditDrawer, PreviewBanner, useMonitorEdit } from '../components/MonitorEdit.tsx';
import { PanelCard, PanelDialog } from '../components/MonitorPanel.tsx';
import { PERIOD_OPTIONS, REFRESH_OPTIONS, refreshMs } from '../monitor.ts';
import { Card, Chip, cx, ErrorBox, Loading, Tip } from '../ui.tsx';

const PERIOD_KEY = 'task-pilot.monitor.period.';

function readPeriod(id: string): Period {
  try {
    const saved = localStorage.getItem(PERIOD_KEY + id);
    return PERIOD_OPTIONS.some((p) => p.id === saved) ? (saved as Period) : '1h';
  } catch {
    return '1h';
  }
}

function savePeriod(id: string, period: Period): void {
  try {
    localStorage.setItem(PERIOD_KEY + id, period);
  } catch {
    // Период - удобство одной вкладки: без хранилища дашборд откроется за час.
  }
}

function Header({ data, actions }: { data: DashboardDataDto; actions?: ReactNode }) {
  const d = data.dashboard;
  return (
    <div className="space-y-1">
      <nav aria-label="Путь" className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
        <a href="#/monitor" className="hover:underline">
          Мониторинг
        </a>
        {data.epic && (
          <>
            <ChevronRight className="size-3.5" aria-hidden />
            <a href={data.epic.url} target="_blank" rel="noreferrer" className="hover:underline">
              <span className="font-mono">{data.epic.key}</span> {data.epic.summary ?? ''}
            </a>
          </>
        )}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{d.title}</h1>
        {actions}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <a href={data.task.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-blue-700 hover:underline dark:text-blue-300">
          {data.task.key}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        {data.task.summary && <span className="text-slate-600 dark:text-slate-300">{data.task.summary}</span>}
        {data.task.status && <Chip>{data.task.status}</Chip>}
        {d.related.length > 0 && <span className="text-xs text-slate-500">связанные: {d.related.join(', ')}</span>}
      </div>
      {d.description && <p className="max-w-4xl text-sm text-slate-600 dark:text-slate-300">{d.description}</p>}
    </div>
  );
}

/** Дашборд задачи: фильтры периода и опроса одной строкой, алерты и панели; клик по панели открывает провал. */
export function DashboardPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState<Period>(() => readPeriod(id));
  const [drill, setDrill] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['monitor', 'dashboard', id, period],
    queryFn: () => api.dashboard(id, period),
    placeholderData: keepPreviousData,
    // Страница опрашивает сервер с интервалом дашборда; в скрытой вкладке опрос встает сам.
    refetchInterval: (query) => refreshMs(query.state.data?.refresh ?? '30s'),
  });
  const refresh = useMutation({
    mutationFn: (r: Refresh) => api.setRefresh(id, r),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['monitor'] }),
  });
  const edit = useMonitorEdit(`dashboard:${id}`, { period });
  const choose = (p: Period) => {
    savePeriod(id, p);
    setPeriod(p);
  };
  if (q.isPending) return <Loading text="Собираю дашборд" />;
  if (q.isError) return <ErrorBox error={q.error} title="Дашборд не загрузился" />;
  // Превью правки по запросу: дашборд по черновику агента, файл еще не записан.
  const data = edit.preview?.kind === 'dashboard' ? edit.preview.data : q.data;
  const panel = drill ? data.dashboard.panels.find((p) => p.id === drill) : undefined;
  return (
    <div className="space-y-5">
      <Header data={data} actions={<EditButton edit={edit} />} />
      <PreviewBanner edit={edit} />
      {edit.open && <EditDrawer edit={edit} />}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Период">
          {PERIOD_OPTIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={period === p.id}
              onClick={() => choose(p.id)}
              className={cx(
                'rounded-md px-2.5 py-1 text-sm font-medium',
                period === p.id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <RefreshCw className={cx('size-4', q.isFetching && 'animate-spin')} aria-hidden />
          опрос
          <select
            value={data.refresh}
            onChange={(e) => refresh.mutate(e.target.value as Refresh)}
            disabled={refresh.isPending}
            className="rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            aria-label="Интервал опроса дашборда"
          >
            {REFRESH_OPTIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <Tip text="Когда сервер последний раз собрал данные дашборда">
          <span className="text-xs tabular-nums text-slate-500">обновлено {new Date(data.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </Tip>
        <span className="ml-auto">
          <LoadLine load={data.load} />
        </span>
      </div>
      {refresh.isError && <ErrorBox error={refresh.error} title="Интервал не сохранился" />}
      {data.alerts.length > 0 && (
        <Card className="px-4 py-3">
          <h2 className="mb-2 text-sm font-semibold">Алерты</h2>
          <ul className="space-y-1.5">
            {data.alerts.map((a) => (
              <AlertRow key={a.id} alert={a} />
            ))}
          </ul>
        </Card>
      )}
      <div className={cx('grid gap-4 transition-opacity lg:grid-cols-12', q.isPlaceholderData && 'opacity-60')}>
        {data.dashboard.panels.map((p) => {
          const v = data.panels.find((x) => x.id === p.id);
          if (!v) return null;
          return <PanelCard key={p.id} panel={p} value={v.value} discover={v.discover} range={data.range} bucketMs={data.bucketMs} deploys={data.deploys} onDrill={() => setDrill(p.id)} />;
        })}
      </div>
      {panel && <PanelDialog dashboard={id} panel={panel} period={data.period} range={data.range} onClose={() => setDrill(null)} />}
    </div>
  );
}
