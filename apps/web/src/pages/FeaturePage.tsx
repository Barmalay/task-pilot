import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { fmtSeconds, localDay, SECONDS_BUCKETS, type FeatureProfile } from '@task-pilot/step-kit';
import type { FeatureStatsDto, FeatureSummaryDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { Columns, DataTable, StackColumns } from '../components/charts.tsx';
import { EditButton, EditDrawer, PreviewBanner, useMonitorEdit } from '../components/MonitorEdit.tsx';
import { dayBars, dayLabel, dayTable, featureTiles, featureWindows, funnelRows, hourBars, outcomeRows, share, stageOf, timingColumns, type OutcomeRow } from '../features.ts';
import { attemptHref, formatCount } from '../monitor.ts';
import { Button, Card, Chip, cx, ErrorBox, Loading, Tip, type Tone } from '../ui.tsx';

const WINDOW_KEY = 'task-pilot.monitor.feature-window.';
const COLORS = { success: 'var(--viz-series-3)', fail: 'var(--viz-series-4)', skip: 'var(--viz-axis)', main: 'var(--viz-series-1)', bad: 'var(--viz-critical)' };
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function readWindow(id: string): string {
  try {
    return localStorage.getItem(WINDOW_KEY + id) ?? 'week';
  } catch {
    return 'week';
  }
}

function saveWindow(id: string, w: string): void {
  try {
    localStorage.setItem(WINDOW_KEY + id, w);
  } catch {
    // Окно - удобство одной вкладки: без хранилища фича откроется за неделю.
  }
}

const stamp = (t: number, timeZone: string) => new Date(t).toLocaleString('ru-RU', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Section({ title, sub, children, className }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <Card className={cx('space-y-3 px-4 py-3', className)}>
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      </div>
      {children}
    </Card>
  );
}

/** Столбцы по дням с начала фичи: успешные и незавершенные показы, ветка обхода рядом. */
function DailyChart({ profile, summary, timeZone }: { profile: FeatureProfile; summary: FeatureSummaryDto; timeZone: string }) {
  const bars = dayBars(profile, summary.days);
  const entry = stageOf(profile, 'entry')!;
  const shown = stageOf(profile, 'shown');
  const success = stageOf(profile, 'success');
  const skip = stageOf(profile, 'skip');
  const every = Math.max(1, Math.ceil(bars.length / 24));
  return (
    <Section
      title="По дням"
      sub={`Строки логов за сутки (${timeZone}) с ${dayLabel(profile.since)}${profile.sinceNote ? ` (${profile.sinceNote})` : ''}. ${success ? 'Столбец делится на успешные и незавершенные показы' : 'Столбец - показы шага'}${skip ? `, рядом ${skip.label.toLowerCase()}` : ''}. Дни старше срока хранения индекса логов - из истории в базе Task Pilot.`}
    >
      {summary.error && <p className="text-sm text-amber-800 dark:text-amber-300">Дневные итоги не обновились: {summary.error}</p>}
      {bars.length ? (
        <StackColumns
          title="По дням"
          height={240}
          items={bars.map((b) => ({ key: b.day, values: { success: b.success, fail: success ? b.fail : b.shows, skip: b.skip } }))}
          parts={[
            ...(success ? [{ key: 'success', label: success.label.toLowerCase(), color: COLORS.success }] : []),
            { key: 'fail', label: success ? 'показан, не завершен' : (shown ?? entry).label.toLowerCase(), color: COLORS.fail },
          ]}
          side={skip ? { key: 'skip', label: skip.label.toLowerCase(), color: COLORS.skip } : undefined}
          label={(day, i) => (i % every === 0 || day.slice(8) === '01' ? (day.slice(8) === '01' || i === 0 ? `${day.slice(8)} ${MONTHS[Number(day.slice(5, 7)) - 1]}` : day.slice(8)) : null)}
          tip={(i) => {
            const b = bars[i]!;
            return (
              <div className="space-y-0.5 tabular-nums">
                <div className="font-semibold text-slate-900 dark:text-white">
                  {dayLabel(b.day)}
                  {b.note ? ` · ${b.note}` : ''}
                </div>
                <div>
                  {entry.label.toLowerCase()}: {formatCount(b.entry)} из {formatCount(b.baseline)}
                </div>
                {shown && <div>показов: {formatCount(b.shows)}</div>}
                {success && (
                  <div>
                    успехов: {formatCount(b.success)}, не завершено: {formatCount(b.fail)}
                  </div>
                )}
                {skip && (
                  <div>
                    {skip.label.toLowerCase()}: {formatCount(b.skip)}
                  </div>
                )}
              </div>
            );
          }}
        />
      ) : (
        <p className="text-sm text-slate-500">Дневных итогов пока нет: они собираются из логов прода раз в час.</p>
      )}
    </Section>
  );
}

function Tiles({ dto }: { dto: FeatureStatsDto }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {featureTiles(dto).map((t) => (
        <Card key={t.label} className="px-3 py-2.5">
          <div className="text-xl font-semibold tabular-nums">{t.value}</div>
          <div className="text-sm text-slate-700 dark:text-slate-200">{t.label}</div>
          {t.note && <div className="mt-0.5 text-xs text-slate-500">{t.note}</div>}
        </Card>
      ))}
    </div>
  );
}

const FINDING_TONE: Record<FeatureStatsDto['stats']['findings'][number]['tone'], { tone: Tone; label: string }> = {
  good: { tone: 'green', label: 'норма' },
  warn: { tone: 'amber', label: 'внимание' },
  bad: { tone: 'red', label: 'проблема' },
  neutral: { tone: 'slate', label: 'к сведению' },
};

function Findings({ dto }: { dto: FeatureStatsDto }) {
  if (!dto.stats.findings.length) return null;
  return (
    <Section title="Выводы" sub="По цифрам окна, теми же правилами, что в отчете скилла feature-stats">
      <ul className="space-y-2">
        {dto.stats.findings.map((f) => (
          <li key={f.title} className="flex gap-2 text-sm">
            <Chip tone={FINDING_TONE[f.tone].tone} className="mt-0.5 h-fit shrink-0">
              {FINDING_TONE[f.tone].label}
            </Chip>
            <div>
              <div className="font-medium">{f.title}</div>
              <p className="text-slate-600 dark:text-slate-300">{f.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Воронка окна: полоса ступени от первой, доля от предыдущей и без автоматов в подсказке. */
function Funnel({ dto }: { dto: FeatureStatsDto }) {
  const rows = funnelRows(dto.stats);
  const max = Math.max(1, rows[0]?.sessions ?? 1);
  const entry = stageOf(dto.profile, 'entry')!;
  const a = dto.stats.automation;
  return (
    <Section
      title="Воронка окна"
      sub={`От "${entry.label.toLowerCase()}" до последней ступени, уникальные сессии окна.${a.count ? ` Сессии с ${a.threshold} и более показами (автоматы: ${formatCount(a.count)}) вынесены ниже, цифра "без автоматов" - без них.` : ''}`}
    >
      <ul className="space-y-2.5">
        {rows.map((r, i) => (
          <li key={r.label} className="grid grid-cols-[minmax(8rem,16rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <span className="truncate text-slate-700 dark:text-slate-200" title={r.label}>
              {r.label}
            </span>
            <div className="h-6 rounded bg-slate-100 dark:bg-slate-800">
              <div
                className="flex h-6 items-center rounded px-2 text-[11px] text-white"
                style={{ width: `${Math.max(1, (r.sessions / max) * 100)}%`, background: i === rows.length - 1 ? COLORS.success : COLORS.main, opacity: i === rows.length - 1 ? 1 : Math.max(0.55, 1 - i * 0.12) }}
              >
                {r.ofPrevious && r.sessions / max > 0.3 ? `${r.ofPrevious} от предыдущей` : ''}
              </div>
            </div>
            <Tip text={a.count ? `без автоматов: ${formatCount(r.normal)}` : undefined}>
              <span className="tabular-nums font-medium">{formatCount(r.sessions)}</span>
            </Tip>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const OUTCOME_COLOR: Record<OutcomeRow['tone'], string> = { good: COLORS.success, bad: COLORS.bad, neutral: COLORS.main, other: COLORS.skip };

function Outcomes({ dto }: { dto: FeatureStatsDto }) {
  const ds = dto.stats.downstream;
  const rows = outcomeRows(dto.profile, dto.stats);
  if (!ds || !rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const from = dto.profile.stages.find((s) => s.key === ds.from)?.label ?? ds.from;
  const unit = ds.by === 'trace' ? 'запросов' : 'сессий';
  return (
    <Section title={ds.title} sub={`${unit[0]!.toUpperCase()}${unit.slice(1)} с шагом "${from.toLowerCase()}": ${formatCount(ds.total)}. Исход - по строкам ${ds.by === 'trace' ? 'той же трассы запроса' : 'с той же сессией'}.`}>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
            <span className={cx('truncate', r.tone === 'other' ? 'italic text-slate-500' : 'text-slate-700 dark:text-slate-200')} title={r.label}>
              {r.label}
            </span>
            <span className="tabular-nums text-slate-600 dark:text-slate-300">
              {formatCount(r.n)}
              <span className="ml-1.5 text-xs text-slate-400">{share(r.n, ds.total)}</span>
            </span>
            <div className="col-span-2 h-2.5 rounded-r bg-slate-100 dark:bg-slate-800">
              <div className="h-2.5 rounded-r" style={{ width: `${(r.n / max) * 100}%`, background: OUTCOME_COLOR[r.tone] }} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Timing({ dto }: { dto: FeatureStatsDto }) {
  const t = dto.stats.timing;
  const login = dto.stats.login;
  if (!t?.n && !login?.reached) return null;
  return (
    <Section title="Время шага" sub={t?.n ? `${t.label}, обычные сессии без автоматов, измерений: ${formatCount(t.n)}` : undefined}>
      {t?.n ? (
        <>
          <Columns
            buckets={timingColumns(dto.stats)}
            interval={1}
            title="Время шага"
            height={170}
            label={(x) => SECONDS_BUCKETS[x] ?? ''}
            detail={(b) => `${SECONDS_BUCKETS[b.x]}, ${share(b.n, t.n)}`}
          />
          <p className="text-xs text-slate-500 tabular-nums">
            медиана {fmtSeconds(t.median)}, p75 {fmtSeconds(t.p75)}, p90 {fmtSeconds(t.p90)}, p95 {fmtSeconds(t.p95)}
          </p>
        </>
      ) : null}
      {login?.reached ? (
        <p className="text-xs text-slate-500 tabular-nums">
          {login.label}: медиана {fmtSeconds(login.median)}, p75 {fmtSeconds(login.p75)}, p90 {fmtSeconds(login.p90)} после шага "{dto.profile.stages.find((s) => s.key === login.from)?.label.toLowerCase()}"
        </p>
      ) : null}
    </Section>
  );
}

function Hourly({ dto }: { dto: FeatureStatsDto }) {
  const p = dto.profile;
  const now = dto.window.toPartial ? `${localDay(dto.generatedAt, dto.timeZone)}T${new Date(dto.generatedAt).toLocaleString('ru-RU', { timeZone: dto.timeZone, hour: '2-digit', hourCycle: 'h23' })}` : undefined;
  const hours = hourBars(p, dto.stats, dto.window.from, dto.window.to, now);
  const shown = stageOf(p, 'shown') ?? stageOf(p, 'entry')!;
  const success = stageOf(p, 'success');
  const every = Math.max(1, Math.ceil(hours.length / 16));
  return (
    <Section title="По часам внутри окна" sub={`Строки "${shown.label.toLowerCase()}"${success ? ` и "${success.label.toLowerCase()}"` : ''} по часам (${dto.timeZone}): видно, когда шаг не показывался совсем`}>
      <StackColumns
        title="По часам"
        height={200}
        items={hours.map((h) => ({ key: h.hour, values: { success: h.success, rest: Math.max(0, h.shows - h.success) } }))}
        parts={[...(success ? [{ key: 'success', label: success.label.toLowerCase(), color: COLORS.success }] : []), { key: 'rest', label: success ? 'показ без успеха' : shown.label.toLowerCase(), color: COLORS.main }]}
        label={(hour, i) => (hour.endsWith('T00') ? dayLabel(hour.slice(0, 10)) : i % every === 0 && hours.length <= 48 ? hour.slice(11) : null)}
        tip={(i) => {
          const h = hours[i]!;
          return (
            <div className="space-y-0.5 tabular-nums">
              <div className="font-semibold text-slate-900 dark:text-white">
                {dayLabel(h.hour.slice(0, 10))} {h.hour.slice(11)}:00
              </div>
              <div>показов: {formatCount(h.shows)}</div>
              {success && <div>успехов: {formatCount(h.success)}</div>}
            </div>
          );
        }}
      />
    </Section>
  );
}

function Automation({ dto }: { dto: FeatureStatsDto }) {
  const a = dto.stats.automation;
  if (!a.count) return null;
  const stage = dto.profile.stages.find((s) => s.key === a.stage)?.label ?? a.stage ?? '';
  return (
    <Section
      title="Повторные сессии"
      sub={`Сессии, где шаг "${stage.toLowerCase()}" повторился ${a.threshold} и более раз: ${formatCount(a.count)}, показов в них ${formatCount(a.shownLines)}, успехов ${formatCount(a.successLines)}. Один человек столько не делает: это автоматы или зависший клиент. Сессия открывает путь попытки.`}
    >
      <div className="max-h-80 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-800">
            <tr>
              {['Сессия', 'Показов', 'Успехов', 'Первый', 'Последний', 'Дошла до входа'].map((h) => (
                <th key={h} className="px-2.5 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
            {a.rows.map((r) => (
              <tr key={r.session}>
                <td className="px-2.5 py-1 font-mono">
                  <a href={attemptHref(r.session, r.first)} className="text-blue-700 hover:underline dark:text-blue-300">
                    {r.session}
                  </a>
                </td>
                <td className="px-2.5 py-1">{formatCount(r.shows)}</td>
                <td className="px-2.5 py-1">{formatCount(r.success)}</td>
                <td className="px-2.5 py-1">{stamp(r.first, dto.timeZone)}</td>
                <td className="px-2.5 py-1">{stamp(r.last, dto.timeZone)}</td>
                <td className="px-2.5 py-1">{r.login ? 'да' : 'нет'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Footer({ dto }: { dto: FeatureStatsDto }) {
  const marks = dto.profile.stages.map((s) => `${s.label}: "${s.any.join('" | "')}"${s.all.length ? ` + "${s.all.join('" + "')}"` : ''}${s.not.length ? ` без "${s.not.join('", "')}"` : ''}`);
  const versions = dto.stats.versions.map((v) => `${v.version} (${stamp(v.first, dto.timeZone)} - ${stamp(v.last, dto.timeZone)})`);
  return (
    <p className="text-xs text-slate-500">
      Сервис {dto.profile.service}. Маркеры: {marks.join('. ')}. Версии в окне: {versions.join(', ') || '-'}. Строк без сессии: {formatCount(dto.stats.unparsed)}.
    </p>
  );
}

/**
 * Воронка одной фичи входа по логам прода, как отчет скилла feature-stats: дни из базы показываются сразу,
 * цифры окна собираются сервером по строкам окна (до минуты) и живут у него 10 минут.
 */
export function FeaturePage({ id }: { id: string }) {
  const [win, setWin] = useState(() => readWindow(id));
  const list = useQuery({ queryKey: ['monitor', 'features'], queryFn: api.monitorFeatures, refetchInterval: 5 * 60_000 });
  const summary = list.data?.features.find((f) => f.profile.id === id);
  const timeZone = list.data?.timeZone ?? 'UTC';
  const windows = featureWindows(localDay(Date.now(), timeZone));
  const w = windows.find((x) => x.id === win) ?? windows[2]!;
  const stats = useQuery({
    queryKey: ['monitor', 'feature', id, w.from, w.to],
    queryFn: () => api.monitorFeature(id, w.from, w.to),
    enabled: Boolean(summary),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
  const edit = useMonitorEdit(`feature:${id}`, { from: w.from, to: w.to });
  const choose = (next: string) => {
    saveWindow(id, next);
    setWin(next);
  };
  if (list.isPending) return <Loading text="Читаю профили фич" />;
  if (list.isError) return <ErrorBox error={list.error} title="Фичи не загрузились" />;
  if (!summary) {
    const broken = list.data.errors.find((e) => e.file === `features/${id}.yaml`);
    return <ErrorBox error={new Error(broken ? `${broken.file}: ${broken.message}` : `Фичи ${id} нет в features/ пакета команды`)} title="Фича не открылась" />;
  }
  // Превью правки по запросу: цифры окна по черновику профиля, файл еще не записан.
  const shown = edit.preview?.kind === 'feature' ? edit.preview.stats : stats.data;
  const p = shown?.profile ?? summary.profile;
  const table = dayTable(p, summary.days);
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <nav aria-label="Путь" className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
          <a href="#/monitor" className="hover:underline">
            Мониторинг
          </a>
          <ChevronRight className="size-3.5" aria-hidden />
          <span>Фичи входа</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {p.title}
            <Chip>{p.short}</Chip>
          </h1>
          <EditButton edit={edit} />
        </div>
        <p className="max-w-4xl text-sm text-slate-600 dark:text-slate-300">{p.intro}</p>
        <p className="text-xs text-slate-500">
          с {dayLabel(p.since)}.{p.since.slice(0, 4)}
          {p.sinceNote ? ` (${p.sinceNote})` : ''}, сервис {p.service}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Окно статистики">
          {windows.map((x) => (
            <button
              key={x.id}
              type="button"
              role="radio"
              aria-checked={w.id === x.id}
              onClick={() => choose(x.id)}
              className={cx(
                'rounded-md px-2.5 py-1 text-sm font-medium',
                w.id === x.id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
        <span className="text-xs tabular-nums text-slate-500">
          {dayLabel(w.from)} - {dayLabel(w.to)}
          {stats.data && !stats.isPlaceholderData ? `, собрано ${stamp(stats.data.generatedAt, timeZone)}` : ''}
        </span>
        <span className="ml-auto">
          <Button variant="ghost" size="sm" icon={RefreshCw} spin={stats.isFetching} disabled={stats.isFetching} onClick={() => void stats.refetch()} title="Цифры окна живут на сервере 10 минут: раньше кнопка вернет те же">
            Обновить
          </Button>
        </span>
      </div>
      <PreviewBanner edit={edit} />
      {edit.open && <EditDrawer edit={edit} />}
      {stats.isPending ? (
        <Loading text="Собираю цифры окна по логам прода: для недели это до минуты" />
      ) : stats.isError ? (
        <ErrorBox error={stats.error} title="Цифры окна не собрались" />
      ) : (
        <div className={cx('space-y-5 transition-opacity', stats.isPlaceholderData && 'opacity-60')}>
          {shown!.truncated && (
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              В каком-то получасе окна строк больше предела одного поиска: взяты первые, цифры окна занижены.
            </p>
          )}
          <Tiles dto={shown!} />
          <Findings dto={shown!} />
        </div>
      )}
      <DailyChart profile={p} summary={summary} timeZone={timeZone} />
      {shown && (
        <div className={cx('space-y-5 transition-opacity', stats.isPlaceholderData && 'opacity-60')}>
          <Funnel dto={shown} />
          <div className="grid gap-5 lg:grid-cols-2">
            <Outcomes dto={shown} />
            <Timing dto={shown} />
          </div>
          <Hourly dto={shown} />
          <Automation dto={shown} />
        </div>
      )}
      <Section title="Таблица по дням" sub={`Строки логов за сутки (${timeZone}), новые сверху. Индекс логов хранит около двух недель, более старые дни - из истории в базе.`}>
        <DataTable head={table.head} rows={table.rows} />
      </Section>
      {shown && <Footer dto={shown} />}
    </div>
  );
}
