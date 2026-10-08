import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, Search } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { RunHistoryDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { BudgetCard } from '../components/BudgetCard.tsx';
import { CacheCard, CacheCell } from '../components/CacheCard.tsx';
import { Columns, Sparkline } from '../components/charts.tsx';
import { dailyStats, filterHistory, historyStatus, NO_FILTER, sortHistory, stepTrend, type HistoryFilter, type HistorySortKey } from '../history.ts';
import { JOURNAL_LOOK, journalChips, journalRows } from '../journal.ts';
import { byRuns, forecastAccuracy } from '../progress.ts';
import { nextSort, type Sort } from '../sort.ts';
import { RUN_LOOK } from '../status.tsx';
import { activeMs, duration, spent as ms, stepStats } from '../timing.ts';
import { Card, Chip, cx, ErrorBox, Loading, PageHeader, Tip } from '../ui.tsx';

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Минуты на оси графика времени: до часа - минуты, дальше - часы. */
const minutes = (m: number) => (m < 60 ? `${Math.round(m)} мин` : `${Number((m / 60).toFixed(1))} ч`);
const dayLabel = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

const PERIODS: { days: number | null; label: string }[] = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
  { days: null, label: 'Все' },
];

const COLUMNS: { key: HistorySortKey | null; label: string; hint?: string; className: string }[] = [
  { key: 'issue', label: 'Задача', className: 'pr-2 pl-7' },
  { key: null, label: 'Пресет', className: 'px-1.5' },
  { key: 'start', label: 'Начало', className: 'px-1.5' },
  { key: 'active', label: 'Всего', hint: 'Время прогона без пауз', className: 'px-1.5' },
  { key: 'work', label: 'Работа', className: 'px-1.5' },
  { key: 'agent', label: 'Агент', className: 'px-1.5' },
  { key: 'owner', label: 'Ждал вас', className: 'px-1.5' },
  { key: 'pause', label: 'Пауза', hint: 'Во время прогона не входит', className: 'px-1.5' },
  { key: 'cost', label: 'Агент, $', className: 'px-1.5' },
  { key: null, label: 'Прогон', className: 'px-1.5' },
  { key: 'problems', label: 'Сбои и правки', className: 'px-1.5' },
];

/** Заголовок столбца: щелчок сортирует, второй меняет направление, третий возвращает порядок по времени начала. */
function SortHeader({ label, hint, active, desc, onClick }: { label: string; hint?: string; active: boolean; desc: boolean; onClick: () => void }) {
  const Arrow = active ? (desc ? ArrowDown : ArrowUp) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${hint ? `${hint}. ` : ''}${active ? 'Щелкните еще раз, чтобы сменить направление или вернуть порядок по началу' : 'Сортировать по этому столбцу'}`}
      className={cx('inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200', active && 'text-slate-800 dark:text-slate-200')}
    >
      {label}
      {Arrow && <Arrow className="size-3" aria-hidden />}
    </button>
  );
}

/** Подробности прогона в раскрытой строке: время шагов, сбои и правки, прогноз против факта и переход к прогону. */
function RunDetails({ h }: { h: RunHistoryDto }) {
  const journal = useQuery({ queryKey: ['journal', h.run.id], queryFn: () => api.journal(h.run.id) });
  const rows = journal.data ? journalRows(journal.data) : [];
  const fact = activeMs(h.timing);
  const steps = h.timing.steps.filter((s) => s.workMs > 0 || s.approvalsMs > 0);
  return (
    <div className="grid gap-5 bg-slate-50/70 px-4 py-3 text-xs whitespace-normal lg:grid-cols-2 dark:bg-slate-800/40">
      <div>
        <h3 className="mb-1 font-medium text-slate-600 dark:text-slate-300">Шаги</h3>
        {steps.length ? (
          <table className="w-full text-left tabular-nums">
            <thead className="text-slate-500">
              <tr>
                <th className="py-0.5 pr-2 font-medium">Шаг</th>
                <th className="py-0.5 pr-2 font-medium">Работа</th>
                <th className="py-0.5 pr-2 font-medium">Агент</th>
                <th className="py-0.5 pr-2 font-medium">Ждал вас</th>
                <th className="py-0.5 pr-2 font-medium">Запусков</th>
                <th className="py-0.5 font-medium">$</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-700/70">
              {steps.map((s) => (
                <tr key={s.stepId}>
                  <td className="py-0.5 pr-2 text-slate-800 dark:text-slate-200">{s.title}</td>
                  <td className="py-0.5 pr-2 font-medium">{ms(s.workMs)}</td>
                  <td className="py-0.5 pr-2">{ms(s.agentMs)}</td>
                  <td className="py-0.5 pr-2">{ms(s.questionsMs + s.approvalsMs)}</td>
                  <td className="py-0.5 pr-2">{s.attempts || '-'}</td>
                  <td className="py-0.5">{s.costUsd > 0 ? s.costUsd.toFixed(2) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-slate-500">Шаги не работали</p>
        )}
        {h.forecast && (
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Прогноз при запуске {duration(h.forecast.totalMs)}, факт без пауз {duration(fact)}
          </p>
        )}
      </div>
      <div>
        <h3 className="mb-1 font-medium text-slate-600 dark:text-slate-300">Сбои и правки, новые сверху</h3>
        {journal.isPending ? (
          <Loading text="Открываю журнал" />
        ) : rows.length ? (
          <ul className="space-y-1">
            {rows.slice(0, 8).map((r) => (
              <li key={`${r.kind}-${r.stepId}-${r.at}`} className="grid grid-cols-[5.5rem_6.5rem_minmax(0,1fr)] items-baseline gap-2">
                <span className="text-slate-500 tabular-nums" title={new Date(r.at).toLocaleString('ru-RU')}>
                  {when(r.at)}
                </span>
                <Chip tone={JOURNAL_LOOK[r.kind].tone} className="justify-self-start">
                  {JOURNAL_LOOK[r.kind].label}
                </Chip>
                <span className="min-w-0 text-slate-800 dark:text-slate-200">
                  <span className="font-medium">{r.step}</span>: <span className="line-clamp-2 break-words">{r.text}</span>
                </span>
              </li>
            ))}
            {rows.length > 8 && <li className="text-slate-500">и еще {rows.length - 8}: все на экране прогона</li>}
          </ul>
        ) : (
          <p className="text-slate-500">Сбоев и правок не было</p>
        )}
        <a href={`#/runs/${h.run.id}`} className="mt-2 inline-flex items-center gap-1 font-medium text-blue-700 hover:underline dark:text-blue-400">
          Открыть прогон
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}

/** Графики по дням начала прогонов за 30 дней: сколько прогонов, их время без пауз и расход агентов. */
function Daily({ runs }: { runs: RunHistoryDto[] }) {
  const days = dailyStats(runs, Date.now(), 30);
  if (!days.some((d) => d.runs)) return null;
  const bucket = (n: (d: (typeof days)[number]) => number) => days.map((d, i) => ({ x: i, n: n(d) }));
  const label = (i: number) => dayLabel(days[i]?.day ?? '');
  const detail = (i: number) => `${dayLabel(days[i]?.day ?? '')}, прогонов ${days[i]?.runs ?? 0}`;
  return (
    <Card>
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="font-semibold">По дням</h2>
        <p className="text-xs text-slate-500">30 последних дней по началу прогонов, с учетом фильтров выше. Время - без пауз</p>
      </div>
      <div className="grid gap-4 px-4 py-3 lg:grid-cols-3">
        <div>
          <h3 className="text-xs font-medium text-slate-600 dark:text-slate-300">Время прогонов</h3>
          <Columns buckets={bucket((d) => d.activeMs / 60_000)} interval={1} title="Время прогонов по дням" height={150} format={minutes} label={label} detail={(b) => detail(b.x)} />
        </div>
        <div>
          <h3 className="text-xs font-medium text-slate-600 dark:text-slate-300">Расход агентов</h3>
          <Columns buckets={bucket((d) => d.costUsd)} interval={1} title="Расход агентов по дням" height={150} format={(n) => `$${Number(n.toFixed(2))}`} label={label} detail={(b) => detail(b.x)} />
        </div>
        <div>
          <h3 className="text-xs font-medium text-slate-600 dark:text-slate-300">Прогонов</h3>
          <Columns buckets={bucket((d) => d.runs)} interval={1} title="Прогонов по дням" height={150} label={label} detail={(b) => dayLabel(days[b.x]?.day ?? '')} />
        </div>
      </div>
    </Card>
  );
}

/**
 * История прогонов: сколько шел каждый прогон без пауз, сколько работали шаги и агент, сколько он ждал вас и стоял на
 * паузе, сколько было падений шагов, ваших правок на подтверждениях, кругов петель и отказов агенту, и медианы
 * времени каждого шага по всем прогонам, где он работал, с трендом по последним прогонам. Фильтры по задаче, пресету,
 * статусу и периоду действуют на таблицу, графики по дням и медианы; щелчок по столбцу сортирует, по строке -
 * раскрывает подробности прогона. По этой истории и признакам задач из API (`GET /api/timing`) строится прогноз времени
 * новой задачи. Рядом расход агентов с лимитами и место на диске: файлы каждого прогона в колонке "Кэш" и их очистка.
 */
export function HistoryPage() {
  const history = useQuery({ queryKey: ['history'], queryFn: () => api.history(200) });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: api.catalog });
  const [filter, setFilter] = useState<HistoryFilter>(NO_FILTER);
  const [sort, setSort] = useState<Sort<HistorySortKey> | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (history.isPending) return <Loading text="Считаю время прогонов" />;
  if (history.isError) return <ErrorBox error={history.error} />;
  const all = history.data.filter((h) => h.timing.start);
  const presets = new Map((catalog.data?.presets ?? []).map((p) => [p.id, p.title]));
  const usedPresets = [...new Set(all.map((h) => h.run.presetId))];
  const usedStatuses = [...new Set(all.map(historyStatus))];
  const runs = filterHistory(all, filter, Date.now());
  const shown = sortHistory(runs, sort);
  const stats = stepStats(runs);
  const accuracy = forecastAccuracy(runs);
  const set = (patch: Partial<HistoryFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const select = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900';
  return (
    <div className="space-y-5">
      <PageHeader
        title="История прогонов"
        help="Сколько шел каждый прогон и на что ушло время: работа, ожидание вас, паузы, расход агентов, сбои и правки. Прогоны, которые не запускали, сюда не попадают. Здесь же лимиты расхода агентов и место на диске с очисткой кэша"
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <BudgetCard />
        <CacheCard />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900">
          <Search className="size-3.5 text-slate-400" aria-hidden />
          <input value={filter.query} onChange={(e) => set({ query: e.target.value })} placeholder="Задача или описание" className="w-48 bg-transparent outline-none" aria-label="Поиск по задаче и описанию прогона" />
        </label>
        <select className={select} value={filter.preset ?? ''} onChange={(e) => set({ preset: e.target.value || null })} aria-label="Пресет">
          <option value="">Все пресеты</option>
          {usedPresets.map((p) => (
            <option key={p} value={p}>
              {presets.get(p) ?? p}
            </option>
          ))}
        </select>
        <select className={select} value={filter.status ?? ''} onChange={(e) => set({ status: e.target.value || null })} aria-label="Статус прогона">
          <option value="">Все статусы</option>
          {usedStatuses.map((s) => (
            <option key={s} value={s}>
              {RUN_LOOK[s as keyof typeof RUN_LOOK]?.label ?? s}
            </option>
          ))}
        </select>
        <div className="flex rounded-md border border-slate-300 p-0.5 dark:border-slate-700" role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <button
              key={p.label}
              type="button"
              aria-pressed={filter.days === p.days}
              onClick={() => set({ days: p.days })}
              className={cx('rounded px-2 py-0.5 text-sm', filter.days === p.days ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-sm text-slate-500 tabular-nums">
          прогонов {runs.length}
          {runs.length !== all.length ? ` из ${all.length}` : ''}
        </span>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap tabular-nums">
            <thead className="border-b border-slate-100 text-xs text-slate-500 dark:border-slate-800">
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.label} className={cx(c.className, 'py-2 font-medium')} aria-sort={c.key && sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                    {c.key ? (
                      <SortHeader label={c.label} hint={c.hint} active={sort?.key === c.key} desc={sort?.desc ?? false} onClick={() => setSort((s) => nextSort(s, c.key!, ['issue']))} />
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
                <th className="px-1.5 py-2 font-medium">
                  <Tip text="Файлы прогона на диске: журналы агентов и логи сборок. Очистить можно у завершенного прогона">Кэш</Tip>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {shown.map((h) => {
                const look = RUN_LOOK[h.run.status];
                const expanded = open.has(h.run.id);
                return (
                  <Fragment key={h.run.id}>
                    <tr className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => toggle(h.run.id)} aria-expanded={expanded} title={expanded ? 'Свернуть подробности' : 'Показать время шагов, сбои и правки'}>
                      <td className="max-w-56 py-2 pr-2 pl-2">
                        <div className="flex items-start gap-1">
                          <ChevronRight className={cx('mt-0.5 size-4 shrink-0 text-slate-400 transition-transform', expanded && 'rotate-90')} aria-hidden />
                          <div className="min-w-0">
                            <a href={`#/runs/${h.run.id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium text-blue-700 hover:underline dark:text-blue-400">
                              {h.run.issueKey}
                            </a>
                            {h.summary && <p className="truncate text-xs text-slate-500" title={h.summary}>{h.summary}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-1.5 py-2 text-xs whitespace-normal">{presets.get(h.run.presetId) ?? h.run.presetId}</td>
                      <td className="px-1.5 py-2 text-xs whitespace-nowrap">{when(h.timing.start!)}</td>
                      <td className="px-1.5 py-2 font-medium" title={`Без пауз. С паузами ${duration(h.timing.wallMs)}`}>
                        {ms(activeMs(h.timing))}
                      </td>
                      <td className="px-1.5 py-2">{ms(h.timing.workMs)}</td>
                      <td className="px-1.5 py-2">{ms(h.timing.agentMs)}</td>
                      <td className="px-1.5 py-2" title={`вопросов ${h.timing.questions}, подтверждений ${h.timing.approvals}`}>
                        {ms(h.timing.questionsMs + h.timing.approvalsMs)}
                      </td>
                      <td className="px-1.5 py-2">{ms(h.timing.pauseMs)}</td>
                      <td className="px-1.5 py-2">{h.timing.costUsd > 0 ? h.timing.costUsd.toFixed(2) : '-'}</td>
                      <td className="px-1.5 py-2">
                        <Chip tone={look.tone}>{h.timing.live ? 'идет' : look.label}</Chip>
                      </td>
                      <td className="min-w-32 px-1.5 py-2 whitespace-normal">
                        <span className="flex flex-wrap gap-1">
                          {journalChips(h.journal).map((c) => (
                            <Chip key={c.label} tone={c.tone}>
                              {c.label}
                            </Chip>
                          ))}
                        </span>
                      </td>
                      <td className="px-1.5 py-2" onClick={(e) => e.stopPropagation()}>
                        <CacheCell runId={h.run.id} issueKey={h.run.issueKey} />
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={COLUMNS.length + 1} className="p-0">
                          <RunDetails h={h} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!shown.length && <p className="px-4 py-6 text-sm text-slate-500">{all.length ? 'Под фильтры не попал ни один прогон' : 'Запущенных прогонов пока нет'}</p>}
        </div>
      </Card>
      <Daily runs={runs} />
      {stats.length > 0 && (
        <Card>
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <h2 className="font-semibold">Шаги: обычное время</h2>
            <p className="text-xs text-slate-500">
              Медианы по прогонам, где шаг работал: один прогон с долгим ожиданием их не сдвигает. По ним считается прогноз нового прогона, и каждый
              выполненный прогон его уточняет. Тренд - работа шага в последних прогонах по порядку
              {accuracy ? `. Прогноз при запуске обычно расходится с фактом на ${accuracy.errorPercent}%, ${byRuns(accuracy.runs)}` : ''}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Шаг</th>
                  <th className="px-2 py-2 font-medium">Прогонов</th>
                  <th className="px-2 py-2 font-medium">Работа</th>
                  <th className="px-2 py-2 font-medium">Агент</th>
                  <th className="px-2 py-2 font-medium">Ждал вас</th>
                  <th className="px-2 py-2 font-medium">Запусков</th>
                  <th className="px-4 py-2 font-medium">Тренд</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {stats.map((s) => {
                  const trend = stepTrend(runs, s.stepId);
                  return (
                    <tr key={s.stepId}>
                      <td className="px-4 py-2">{s.title}</td>
                      <td className="px-2 py-2">{s.runs}</td>
                      <td className="px-2 py-2 font-medium">{ms(s.workMs)}</td>
                      <td className="px-2 py-2">{ms(s.agentMs)}</td>
                      <td className="px-2 py-2">{ms(s.ownerMs)}</td>
                      <td className="px-2 py-2">{s.attempts}</td>
                      <td className="px-4 py-1">
                        {trend.length > 1 ? (
                          <Tip text={`Работа шага в ${trend.length} последних прогонах: ${trend.map((v) => ms(v)).join(', ')}`}>
                            <Sparkline values={trend} label={`Тренд шага ${s.title}`} />
                          </Tip>
                        ) : (
                          <span className="text-xs text-slate-400">{trend.length ? 'один прогон' : '-'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
