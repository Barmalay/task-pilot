import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Activity, ExternalLink, LayoutDashboard } from 'lucide-react';
import type { FeatureSummaryDto, MonitorCardDto, MonitorOverviewDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { AttemptSearch } from '../components/AttemptSearch.tsx';
import { Sparkline } from '../components/charts.tsx';
import { AlertRow, CardStatus, LoadLine } from '../components/MonitorBits.tsx';
import { dayBars, dayLabel, lastDayOf, stageOf } from '../features.ts';
import { formatCount, formatValue } from '../monitor.ts';
import { go } from '../router.ts';
import { Button, Card, Chip, cx, ErrorBox, Loading, PageHeader, Tip } from '../ui.tsx';

/** Обзор обновляется раз в минуту: карточкам не нужна частота дашборда, а общий кластер бережем. */
const OVERVIEW_REFRESH = 60_000;

function DashboardCard({ card }: { card: MonitorCardDto }) {
  const d = card.dashboard!;
  const firing = card.alerts.filter((a) => a.state === 'firing');
  return (
    <a
      href={`#/monitor/${d.id}`}
      className={cx(
        'block rounded-xl border bg-white p-4 shadow-sm transition-colors hover:border-blue-300 focus-visible:outline-2 focus-visible:outline-blue-500 dark:bg-slate-900 dark:hover:border-blue-700',
        card.status === 'alert' ? 'border-red-300 dark:border-red-800' : 'border-slate-200 dark:border-slate-800',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <CardStatus status={card.status} />
        <span className="font-mono text-xs text-slate-600 dark:text-slate-300">{card.task.key}</span>
        {card.task.status && <span className="ml-auto text-xs text-slate-500">{card.task.status}</span>}
      </div>
      <div className="mt-2 font-medium">{d.title}</div>
      {card.task.summary && <div className="mt-0.5 line-clamp-1 text-xs text-slate-500">{card.task.summary}</div>}
      <div className="mt-3 space-y-3">
        {card.headlines.map((h) => (
          <div key={h.panel} className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs text-slate-500">{h.title}</div>
              {h.error ? (
                <div className="text-xs text-amber-700 dark:text-amber-300">запрос не прошел</div>
              ) : (
                <div className="text-sm">
                  <span className="text-lg font-semibold">{formatValue(h.hour, h.kind)}</span>
                  <span className="ml-1 text-xs text-slate-500">за час</span>
                  <span className="ml-2 tabular-nums text-slate-600 dark:text-slate-300">{formatValue(h.day, h.kind)}</span>
                  <span className="ml-1 text-xs text-slate-500">за сутки</span>
                </div>
              )}
            </div>
            <Sparkline values={h.spark} label={`${h.title}: по часам за сутки`} />
          </div>
        ))}
      </div>
      {firing.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
          {firing.map((a) => (
            <AlertRow key={a.id} alert={a} />
          ))}
        </ul>
      )}
    </a>
  );
}

/** Карточка фичи входа: итоги последнего дня из базы, доля успеха от показов и ход успехов за две недели. */
function FeatureCard({ summary }: { summary: FeatureSummaryDto }) {
  const p = summary.profile;
  const last = lastDayOf(p, summary.days);
  const bars = dayBars(p, summary.days).slice(-14);
  const success = stageOf(p, 'success');
  const shown = stageOf(p, 'shown') ?? stageOf(p, 'entry')!;
  return (
    <a
      href={`#/monitor/features/${p.id}`}
      className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-blue-300 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-700"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="blue">{p.short}</Chip>
        <span className="text-xs text-slate-500">{p.service}</span>
        {last && <span className="ml-auto text-xs text-slate-500">{last.bar.note ? `${dayLabel(last.bar.day)}, ${last.bar.note}` : dayLabel(last.bar.day)}</span>}
      </div>
      <div className="mt-2 font-medium">{p.title}</div>
      {summary.error && <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">дневные итоги не обновились</div>}
      {last ? (
        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="text-sm">
            <span className="text-lg font-semibold tabular-nums">{formatCount(last.bar.shows)}</span>
            <span className="ml-1 text-xs text-slate-500">{shown.label.toLowerCase()}</span>
            {success && (
              <div className="tabular-nums text-slate-600 dark:text-slate-300">
                {formatCount(last.bar.success)} <span className="text-xs text-slate-500">{success.label.toLowerCase()},</span> {last.rate}
              </div>
            )}
          </div>
          <Sparkline values={bars.map((b) => (success ? b.success : b.shows))} label={`${p.title}: ${(success ?? shown).label.toLowerCase()} по дням за две недели`} />
        </div>
      ) : (
        <div className="mt-3 text-xs text-slate-500">дневных итогов пока нет</div>
      )}
    </a>
  );
}

/** Фичи входа из features/ пакета команды: карточки с итогами дня, ошибки профилей отдельно. */
function Features() {
  const q = useQuery({ queryKey: ['monitor', 'features'], queryFn: api.monitorFeatures, refetchInterval: 5 * 60_000 });
  if (!q.data || (!q.data.features.length && !q.data.errors.length)) return null;
  return (
    <section aria-label="Фичи входа" className="space-y-2">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        Фичи входа
        <span className="text-xs font-normal text-slate-500">воронки по логам прода, как в скилле feature-stats</span>
      </h2>
      {q.data.errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-800 dark:text-amber-300">
          {q.data.errors.map((e) => (
            <li key={e.file} className="wrap-anywhere">
              <span className="font-mono">{e.file}</span>: {e.message}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {q.data.features.map((f) => (
          <FeatureCard key={f.profile.id} summary={f} />
        ))}
      </div>
    </section>
  );
}

function TaskCard({ card, onBuild, building }: { card: MonitorCardDto; onBuild: () => void; building: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-4 dark:border-slate-700 dark:bg-slate-900/60">
      <div className="flex flex-wrap items-center gap-2">
        <CardStatus status="empty" />
        <a href={card.task.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-blue-700 hover:underline dark:text-blue-300">
          {card.task.key}
          <ExternalLink className="size-3" aria-hidden />
        </a>
        {card.task.status && <span className="ml-auto text-xs text-slate-500">{card.task.status}</span>}
      </div>
      {card.task.summary && <div className="mt-2 line-clamp-2 text-sm text-slate-700 dark:text-slate-200">{card.task.summary}</div>}
      <Button
        variant="secondary"
        size="sm"
        icon={LayoutDashboard}
        className="mt-3"
        spin={building}
        disabled={building}
        onClick={onBuild}
        title='Новый прогон задачи с шагом "Дашборд задачи": агент по коду и описанию предложит строки лога, панели и алерты, сохраняете вы'
      >
        Собрать дашборд
      </Button>
    </div>
  );
}

function Overview({ data }: { data: MonitorOverviewDto }) {
  const build = useMutation({ mutationFn: (key: string) => api.newRun(key, { presetId: 'monitor' }), onSuccess: (r) => go(`/runs/${r.id}`) });
  if (!data.configured) {
    return (
      <Card className="p-5 text-sm">
        Панель не настроена: нет файла <code className="font-mono">monitor.yaml</code> с источником логов прода и сервисами ни в пакете команды, ни в слое компании.
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <Features />
      {build.isError && <ErrorBox error={build.error} title="Не удалось открыть прогон для дашборда" />}
      {data.errors.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <div className="font-medium">Дашборды с ошибками в файле не показываются</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {data.errors.map((e) => (
              <li key={e.file} className="wrap-anywhere">
                <span className="font-mono">{e.file}</span>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.tasksError && <p className="text-sm text-amber-800 dark:text-amber-300">{data.tasksError}: задачи на мониторинге не показаны</p>}
      {!data.groups.length && <Card className="p-5 text-sm text-slate-500">Дашбордов пока нет, и задач на мониторинге тоже</Card>}
      {data.groups.map((g) => (
        <section key={g.epic?.key ?? 'none'} aria-label={g.epic ? `Эпик ${g.epic.key}` : 'Задачи без эпика'}>
          <h2 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
            {g.epic ? (
              <>
                <a href={g.epic.url} target="_blank" rel="noreferrer" className="font-mono text-blue-700 hover:underline dark:text-blue-300">
                  {g.epic.key}
                </a>
                <span>{g.epic.summary ?? 'Эпик'}</span>
              </>
            ) : (
              <span>Без эпика</span>
            )}
            <span className="text-xs font-normal text-slate-500">задач {g.cards.length}</span>
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {g.cards.map((c) =>
              c.dashboard ? <DashboardCard key={c.dashboard.id} card={c} /> : <TaskCard key={c.task.key} card={c} onBuild={() => build.mutate(c.task.key)} building={build.isPending && build.variables === c.task.key} />,
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Экран "Мониторинг": сверху поиск попыток входа, под ним воронки фич входа, ниже задачи с дашбордами и задачи на
 * мониторинге (tasksJql профиля), сгруппированные по эпикам.
 */
export function MonitorPage() {
  const q = useQuery({ queryKey: ['monitor', 'overview'], queryFn: api.monitorOverview, refetchInterval: OVERVIEW_REFRESH, placeholderData: keepPreviousData });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Мониторинг"
        icon={<Activity className="size-5 text-blue-600" aria-hidden />}
        help="Логи прода: сверху поиск попыток входа и путь одной попытки по всем сервисам, ниже воронки фич входа по дням, дашборды задач с цифрами за час и сутки и алерты. Задачи на мониторинге (фильтр панели в monitor.yaml) появляются здесь сами"
        actions={
          <div className="flex shrink-0 flex-col items-end gap-1">
            {q.data && (
              <div className="flex items-center gap-2">
                <LoadLine load={q.data.load} />
                <Tip text="Обзор обновляется раз в минуту">
                  <Chip>{new Date(q.data.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Chip>
                </Tip>
              </div>
            )}
          </div>
        }
      />
      <AttemptSearch />
      {q.isPending ? <Loading text="Собираю обзор" /> : q.isError ? <ErrorBox error={q.error} title="Обзор не загрузился" /> : <div className={cx('transition-opacity', q.isPlaceholderData && 'opacity-60')}><Overview data={q.data} /></div>}
    </div>
  );
}
