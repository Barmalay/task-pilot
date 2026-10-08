import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChartLine, ExternalLink, Info, Minus, Search, Table2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeployMark, Panel, PanelValue, Period, TimeRange } from '@task-pilot/step-kit';
import { api } from '../api.ts';
import { breakdownOptions, deltaOf, formatCount, formatPoint, formatRatio, formatSpan, PERIOD_OPTIONS } from '../monitor.ts';
import { Button, Card, cx, ErrorBox, Loading, Tip } from '../ui.tsx';
import { BarList, Columns, DataTable, TimeChart, type ChartSeries } from './charts.tsx';
import { LogLines } from './MonitorBits.tsx';

/** Где панель занимает место в сетке дашборда: числа узкие, строки лога во всю ширину. */
export function panelSpan(p: Panel): string {
  if (p.type === 'stat') return 'lg:col-span-3';
  if (p.type === 'lines') return 'lg:col-span-12';
  return 'lg:col-span-6';
}

const at = (t: number, periodMs: number) => formatPoint(t, periodMs);

/** Таблица значений панели: тот же смысл, что у графика, без цвета. */
function PanelTable({ value, periodMs }: { value: PanelValue; periodMs: number }) {
  switch (value.type) {
    case 'timeseries':
      return (
        <DataTable
          head={['Время', ...value.series.map((s) => s.label)]}
          rows={(value.series[0]?.points ?? []).map((p, i) => [at(p.t, periodMs), ...value.series.map((s) => formatCount(s.points[i]?.n ?? 0))])}
        />
      );
    case 'share':
      return <DataTable head={['Время', 'Строк', 'Из них', 'Доля']} rows={value.points.map((p) => [at(p.t, periodMs), formatCount(p.of), formatCount(p.part), formatRatio(p.ratio)])} />;
    case 'top':
      return <DataTable head={['Значение', 'Строк']} rows={[...value.items.map((x) => [x.key, formatCount(x.n)]), ...(value.other ? [['остальные', formatCount(value.other)]] : [])]} />;
    case 'numbers':
      return <DataTable head={['Корзина', 'Строк']} rows={value.buckets.map((b) => [String(b.x), formatCount(b.n)])} />;
    default:
      return null;
  }
}

/** Подпись у значений, посчитанных по случайной выборке строк: разбор текста по всем строкам слишком дорог кластеру. */
function Sampled({ sample }: { sample?: number }) {
  if (sample === undefined) return null;
  return (
    <Tip text="Разбор текста строк дорог для общего кластера: значения оценены по случайной выборке и пересчитаны на все строки">
      <p className="mt-2 text-xs text-slate-500">оценка по случайной выборке {formatRatio(sample)} строк</p>
    </Tip>
  );
}

function Delta({ value, previous }: { value: number; previous: number }) {
  const d = deltaOf(value, previous);
  const Icon = d.direction === 'up' ? ArrowUp : d.direction === 'down' ? ArrowDown : Minus;
  return (
    <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
      <Icon className="size-3.5" aria-hidden />
      {d.text}
      <span className="tabular-nums">({formatCount(previous)})</span>
    </div>
  );
}

/** Значение панели: число, график, полосы, распределение или строки лога. */
function PanelBody({ panel, value, range, bucketMs, deploys, table }: { panel: Panel; value: PanelValue; range: TimeRange; bucketMs: number; deploys: DeployMark[]; table: boolean }) {
  const periodMs = range.to - range.from;
  if (value.type === 'error') return <ErrorBox error={value.message} title="Панель не загрузилась" />;
  if (table && value.type !== 'stat' && value.type !== 'lines') return <PanelTable value={value} periodMs={periodMs} />;
  switch (value.type) {
    case 'stat':
      return (
        <div>
          <div className="text-3xl font-semibold">{formatCount(value.value)}</div>
          <Delta value={value.value} previous={value.previous} />
        </div>
      );
    case 'timeseries': {
      const series: ChartSeries[] = value.series.map((s) => ({ label: s.label, total: formatCount(s.total), points: s.points.map((p) => ({ t: p.t, v: p.n })) }));
      return (
        <div className="space-y-2">
          {value.series.length === 1 && (
            <div className="text-sm text-slate-600 dark:text-slate-300">
              <span className="text-xl font-semibold text-slate-900 dark:text-white">{formatCount(value.series[0]!.total)}</span> строк за период
            </div>
          )}
          <TimeChart series={series} range={range} bucketMs={bucketMs} kind="count" deploys={deploys} title={panel.title} />
        </div>
      );
    }
    case 'share':
      return (
        <div className="space-y-2">
          <div className="text-sm text-slate-600 dark:text-slate-300">
            <span className="text-xl font-semibold text-slate-900 dark:text-white">{formatRatio(value.ratio)}</span>
            <span className="ml-1.5 tabular-nums">
              {formatCount(value.part)} из {formatCount(value.of)}
            </span>
          </div>
          <TimeChart series={[{ label: panel.title, points: value.points.map((p) => ({ t: p.t, v: p.ratio })) }]} range={range} bucketMs={bucketMs} kind="ratio" deploys={deploys} title={panel.title} />
        </div>
      );
    case 'top':
      return (
        <>
          <BarList items={value.items} other={value.other} />
          <Sampled sample={value.sample} />
        </>
      );
    case 'numbers':
      return value.buckets.length ? (
        <>
          <Columns buckets={value.buckets} interval={panel.type === 'numbers' ? panel.interval : 1} title={panel.title} />
          <Sampled sample={value.sample} />
        </>
      ) : (
        <p className="text-sm text-slate-500">Строк за период нет</p>
      );
    case 'lines':
      return (
        <div className="max-h-[28rem] overflow-y-auto">
          <LogLines lines={value.lines} />
        </div>
      );
  }
}

/** Карточка панели: заголовок с подсказкой, переключатель графика и таблицы, провал и ссылка в Kibana. */
export function PanelCard({
  panel,
  value,
  discover,
  range,
  bucketMs,
  deploys,
  onDrill,
}: {
  panel: Panel;
  value: PanelValue;
  discover: string | null;
  range: TimeRange;
  bucketMs: number;
  deploys: DeployMark[];
  onDrill: () => void;
}) {
  const [table, setTable] = useState(false);
  const tabular = value.type !== 'stat' && value.type !== 'lines' && value.type !== 'error';
  return (
    <Card className={cx('flex flex-col', panelSpan(panel))}>
      <div className="flex items-center gap-1 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
        <h3 className="mr-auto flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <span className="truncate">{panel.title}</span>
          {panel.hint && (
            <Tip text={panel.hint}>
              <Info className="size-3.5 shrink-0 text-slate-400" aria-label="Что показывает панель" />
            </Tip>
          )}
        </h3>
        {tabular && (
          <Button variant="ghost" size="sm" icon={table ? ChartLine : Table2} onClick={() => setTable(!table)} title={table ? 'Показать график' : 'Показать значения таблицей'} aria-label={table ? 'График' : 'Таблица'} />
        )}
        <Button variant="ghost" size="sm" icon={Search} onClick={onDrill} title="Разбивка по полю, сравнение до и после деплоя и строки лога этой панели" aria-label="Подробнее" />
        {discover && (
          <a href={discover} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="Те же строки в Discover Kibana прода">
            <ExternalLink className="size-4" aria-label="Открыть в Kibana" />
          </a>
        )}
      </div>
      <div className="flex-1 p-4">
        <PanelBody panel={panel} value={value} range={range} bucketMs={bucketMs} deploys={deploys} table={table} />
      </div>
    </Card>
  );
}

function Breakdown({ dashboard, panel, period }: { dashboard: string; panel: Panel; period: Period }) {
  const options = breakdownOptions(panel);
  const [by, setBy] = useState(options[0]!.value);
  const q = useQuery({ queryKey: ['monitor', 'breakdown', dashboard, panel.id, period, by], queryFn: () => api.breakdown(dashboard, panel.id, period, by) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Разбивка по полю">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={by === o.value}
            onClick={() => setBy(o.value)}
            className={cx(
              'rounded-md px-2 py-1 text-xs font-medium',
              by === o.value ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <Loading text="Считаю разбивку" />
      ) : q.isError ? (
        <ErrorBox error={q.error} title="Разбивка не посчиталась" />
      ) : (
        <>
          {q.data.error ? <ErrorBox error={q.data.error} title="Разбивка не посчиталась" /> : <BarList items={q.data.items} other={q.data.other} />}
          {q.data.deploy ? (
            <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
              <div className="font-medium">
                Деплой {q.data.deploy.version} в {new Date(q.data.deploy.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </div>
              <div className="mt-1 tabular-nums text-slate-600 dark:text-slate-300">
                до: {formatCount(q.data.deploy.before)}, после: {formatCount(q.data.deploy.after)} строк за равные {formatSpan(q.data.deploy.spanMs)}
                {q.data.deploy.before > 0 && ` (${deltaOf(q.data.deploy.after, q.data.deploy.before).text.replace(' к прошлому периоду', '')})`}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">Деплоев сервиса за период не было</p>
          )}
        </>
      )}
    </div>
  );
}

function Lines({ dashboard, panel, range }: { dashboard: string; panel: Panel; range: TimeRange }) {
  const pages = useInfiniteQuery({
    queryKey: ['monitor', 'lines', dashboard, panel.id, range.from, range.to],
    queryFn: ({ pageParam }) => api.monitorLines(dashboard, { panel: panel.id, from: range.from, to: range.to, before: pageParam }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.before,
  });
  const lines = pages.data?.pages.flatMap((p) => p.lines) ?? [];
  const discover = pages.data?.pages[0]?.discover ?? null;
  const error = pages.data?.pages.find((p) => p.error)?.error;
  return (
    <div className="space-y-2">
      {discover && (
        <a href={discover} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline dark:text-blue-300">
          <ExternalLink className="size-3.5" aria-hidden />
          Те же строки в Discover Kibana прода
        </a>
      )}
      {pages.isPending ? <Loading text="Беру строки" /> : pages.isError ? <ErrorBox error={pages.error} title="Строки не загрузились" /> : error ? <ErrorBox error={error} title="Строки не загрузились" /> : <LogLines lines={lines} />}
      {pages.hasNextPage && (
        <Button variant="secondary" size="sm" className="w-full" spin={pages.isFetchingNextPage} disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
          Показать раньше
        </Button>
      )}
    </div>
  );
}

/** Провал до панели: разбивка по полю с деплоем и строки лога за период дашборда. */
export function PanelDialog({ dashboard, panel, period, range, onClose }: { dashboard: string; panel: Panel; period: Period; range: TimeRange; onClose: () => void }) {
  const [tab, setTab] = useState<'breakdown' | 'lines'>(panel.type === 'lines' ? 'lines' : 'breakdown');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const label = PERIOD_OPTIONS.find((p) => p.id === period)?.label ?? period;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="panel-title" className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900">
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 id="panel-title" className="font-semibold">
            {panel.title}
          </h2>
          <span className="text-xs text-slate-500">за {label}</span>
          <Button variant="ghost" size="sm" icon={X} className="ml-auto" onClick={onClose} aria-label="Закрыть" />
        </div>
        <div className="flex gap-1 border-b border-slate-100 px-5 py-2 dark:border-slate-800" role="tablist">
          {(['breakdown', 'lines'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx('rounded-md px-2.5 py-1 text-sm font-medium', tab === t ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}
            >
              {t === 'breakdown' ? 'Разбивка и деплой' : 'Строки лога'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'breakdown' ? <Breakdown dashboard={dashboard} panel={panel} period={period} /> : <Lines dashboard={dashboard} panel={panel} range={range} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
