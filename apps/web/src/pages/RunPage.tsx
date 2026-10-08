import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Plus, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Issue, RepoChoice, StepStatus } from '@task-pilot/step-kit';
import type { EventDto, RunDto, RunViewDto, StepDto } from '@task-pilot/api-types';
import { acView, analysisAhead } from '../ac.ts';
import { api, type RunOptions } from '../api.ts';
import { ArtifactsCard } from '../components/ArtifactsPanel.tsx';
import { AskCard } from '../components/AskCard.tsx';
import { ContextPanel } from '../components/ContextPanel.tsx';
import { FeedCard } from '../components/FeedCard.tsx';
import { FeedDialog } from '../components/FeedDialog.tsx';
import { GateDialog } from '../components/GateDialog.tsx';
import { IssueChangedBanner } from '../components/IssueChangedBanner.tsx';
import { IssueMeta } from '../components/IssueMeta.tsx';
import { QuestionCard } from '../components/QuestionCard.tsx';
import { RunSwitcher } from '../components/RunSwitcher.tsx';
import { StandNow } from '../components/StandNow.tsx';
import { RunProgress } from '../components/RunProgress.tsx';
import { StepFold, StepRow } from '../components/StepRow.tsx';
import { JournalPanel } from '../components/JournalPanel.tsx';
import { MainAction } from '../components/MainAction.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { NowPanel } from '../components/NowPanel.tsx';
import { TimingPanel } from '../components/TimingPanel.tsx';
import type { FeedTarget } from '../feed.ts';
import type { WaitingContext } from '../now.ts';
import { stepGroups } from '../progress.ts';
import { issueReworkStep, REWORK_PRESET } from '../rework.ts';
import { go } from '../router.ts';
import { standsFor } from '../stands.ts';
import { RUN_LOOK } from '../status.tsx';
import { Button, Card, Chip, ErrorBox, Loading, Tip } from '../ui.tsx';
import { useRunEvents } from '../useEvents.ts';

/** Статусы шагов, которые ничего не сделали: пока все шаги в них, репозиторий можно сменить. */
const UNTOUCHED: StepStatus[] = ['pending', 'skipped', 'blocked'];

/**
 * Экран задачи: данные из Jira, выбор репозитория и стенда, степпер шагов, строка "сейчас" об идущих шагах, вопросы
 * агента, вопросы владельца о прогоне, контекст и лента.
 */
export function RunPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const events = useRunEvents(id);
  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.run(id) });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles, staleTime: Infinity });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: api.catalog });
  const repoId = run.data?.run.repoId;
  // Что сейчас на стендах контура репозитория: релиз рядом со стендом в селекторе и предупреждение под ним.
  const stands = useQuery({ queryKey: ['stands', repoId], queryFn: () => api.stands(repoId), enabled: !!repoId, staleTime: 60_000 });
  // Открытое подтверждение: главная кнопка открывает первое, строка шага - свое.
  const [gateId, setGateId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Окно всей ленты: его открывают карточка ленты, журнал сбоев и правок и карточка времени, закрывает переход к другому прогону.
  const [feed, setFeed] = useState<{ initial: EventDto | null; target?: FeedTarget } | undefined>(undefined);
  // Черновик вопроса о прогоне: его подставляет строка "сейчас", а поле карточки вопросов редактирует.
  const [askDraft, setAskDraft] = useState('');
  const askRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setFeed(undefined);
    setAskDraft('');
  }, [id]);
  // Замечания и ответы на вопросы к подтверждениям по id запроса: закрытое по ошибке окно не теряет написанное.
  const [comments, setComments] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const questionsRef = useRef<HTMLDivElement>(null);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['run', id] }),
  });
  // Значение берется из события сразу, а экран показывает его до ответа сервера; отказ сервера возвращает прежнее.
  const options = useMutation({
    mutationFn: (patch: RunOptions) => api.setOptions(id, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['run', id] });
      const previous = qc.getQueryData<RunViewDto>(['run', id]);
      if (previous) qc.setQueryData<RunViewDto>(['run', id], { ...previous, run: { ...previous.run, ...patch } });
      return { previous };
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.previous) qc.setQueryData(['run', id], ctx.previous);
    },
    onSuccess: (view) => qc.setQueryData(['run', id], view),
    onSettled: () => qc.invalidateQueries({ queryKey: ['run', id] }),
  });
  // Новый прогон той же задачи с тем же пресетом, репозиторием и стендом: только по кнопке "Новый прогон".
  const fresh = useMutation({
    mutationFn: (r: RunDto) => api.newRun(r.issueKey, { presetId: r.presetId, repoId: r.repoId, standId: r.standId }),
    onSuccess: (r, from) => {
      void qc.invalidateQueries({ queryKey: ['runs', from.issueKey] });
      go(`/runs/${r.id}`);
    },
  });

  // Удаление насовсем; после него экран переходит к самому свежему из оставшихся прогонов задачи или к задачам.
  const remove = useMutation({
    mutationFn: () => api.deleteRun(id),
    onSuccess: ({ next }) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.removeQueries({ queryKey: ['run', id] });
      go(next ? `/runs/${next}` : '/');
    },
  });

  const approvalId = run.data?.approval?.id;
  useEffect(() => {
    if (approvalId) setGateId(approvalId);
  }, [approvalId]);
  // Выполненные шаги и шаги не в плане свернуты; раскрывает их владелец или переход с полосы шагов.
  const [expanded, setExpanded] = useState({ done: false, off: false });
  const [flash, setFlash] = useState<string | null>(null);
  const current = run.data ? stepGroups(run.data.steps).current : null;
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    // Экран открывается на шаге, где прогон сейчас: один раз на прогон, дальше страница сама не прокручивается.
    if (!current || scrolledFor.current === id) return;
    scrolledFor.current = id;
    document.querySelector(`[data-step="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [id, current]);
  const jump = useCallback(
    (stepId: string) => {
      const groups = run.data ? stepGroups(run.data.steps) : null;
      // Группа шага раскрывается до прокрутки: иначе строки шага еще нет на странице.
      flushSync(() => {
        if (groups?.done.some((s) => s.stepId === stepId)) setExpanded((e) => ({ ...e, done: true }));
        if (groups?.off.some((s) => s.stepId === stepId)) setExpanded((e) => ({ ...e, off: true }));
        setFlash(stepId);
      });
      document.querySelector(`[data-step="${CSS.escape(stepId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => setFlash((f) => (f === stepId ? null : f)), 1600);
    },
    [run.data],
  );
  const closeGate = useCallback(() => setGateId(null), []);
  const showQuestions = useCallback(() => {
    questionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    questionsRef.current?.querySelector('textarea')?.focus();
  }, []);
  const askAbout = useCallback((question: string) => {
    setAskDraft(question);
    askRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    askRef.current?.focus();
  }, []);

  if (run.isLoading) return <Loading text="Загружаю задачу" />;
  // Ошибка во весь экран только когда показывать нечего: сбой фонового обновления не прячет прогон.
  if (!run.data) return <ErrorBox error={run.error ?? 'Прогон не найден'} title="Не удалось открыть задачу" />;

  const view = run.data;
  const issue = view.context.issue as Issue | undefined;
  // Прогон мастера "Новый шаг": задачи Jira, репозитория и стенда у него нет, вместо задачи - описание шага.
  const stepRequest = view.context.stepRequest as { description?: string } | undefined;
  const pilot = stepRequest !== undefined;
  const ac = acView(view.context, analysisAhead(view.steps));
  // Шаги переводят задачу по доске и кладут новый статус в контекст: он свежее загруженного при открытии.
  const jiraStatus = (typeof view.context.status === 'string' ? view.context.status : undefined) ?? issue?.status;
  const choice = view.context.repoChoice as RepoChoice | null | undefined;
  const running = view.active || view.run.status === 'running';
  const locked = running || options.isPending;
  const repoLocked = locked || view.steps.some((s) => !UNTOUCHED.includes(s.status));
  const preset = catalog.data?.presets.find((p) => p.id === view.run.presetId);
  const reworkStep = issueReworkStep(view, catalog.data);
  const repo = profiles.data?.repos.find((r) => r.id === view.run.repoId);
  const stand = profiles.data?.stands.find((s) => s.id === view.run.standId);
  const standNow = stands.data?.find((s) => s.id === view.run.standId);
  const releaseOn = (standId: string) => stands.data?.find((s) => s.id === standId)?.release?.name;
  const gate = view.approvals.find((a) => a.id === gateId) ?? null;
  const gateStep = view.steps.find((s) => s.stepId === gate?.stepId);
  // Отказ шагу цепочки не принимается, пока идет цепочка; фоновые шаги ему не мешают, а фоновый шаг, который ждет
  // подтверждения, сам не идет, и отказ ему принимается всегда.
  const chainRunning = view.steps.some((s) => !s.background && s.status === 'running');
  const repoContour = profiles.data?.contours.find((c) => c.id === repo?.contour);
  const stepTitle = (stepId: string) => view.steps.find((s) => s.stepId === stepId)?.title ?? stepId;
  // Показывается самая свежая ошибка: старая ошибка одного действия не заслоняет новую ошибку другого.
  const error = [act, options, fresh, remove].filter((m) => m.isError).sort((a, b) => b.submittedAt - a.submittedAt)[0]?.error;
  const gateVisible = !!gate;
  const groups = stepGroups(view.steps);
  const position = new Map(view.steps.map((s, i) => [s.stepId, i + 1]));
  // Пояснение видно у шагов, которые идут или ждут сейчас (шаг цепочки и фоновые рядом с ним); у остальных оно в
  // подсказке к названию. Шаг с открытым запросом подтверждения открывает его кнопкой в своей строке.
  const stepRow = (s: StepDto) => {
    const approval = view.approvals.find((a) => a.stepId === s.stepId);
    return (
      <StepRow
        key={s.stepId}
        step={s}
        index={position.get(s.stepId)!}
        locked={running}
        busy={act.isPending}
        compact={!groups.live.includes(s.stepId)}
        flash={flash === s.stepId}
        onToggle={(selected) => act.mutate(() => api.select(id, s.stepId, selected))}
        onRetry={(note) => act.mutate(() => api.retry(id, s.stepId, note))}
        onSkip={() => act.mutate(() => api.skip(id, s.stepId))}
        onOpenGate={approval ? () => setGateId(approval.id) : undefined}
        onSettings={(patch) => act.mutate(() => api.setParams(id, s.stepId, patch))}
      />
    );
  };

  return (
    <>
      {/* Путь: откуда пришли и куда вернуться в один клик; прогон мастера шагов живет в каталоге шагов. */}
      <nav aria-label="Путь" className="mb-3 flex min-w-0 items-center gap-1 text-sm text-slate-500" inert={gateVisible}>
        <a href={pilot ? '#/catalog' : '#/'} className="shrink-0 hover:underline">
          {pilot ? 'Каталог шагов' : 'Задачи'}
        </a>
        <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-mono text-slate-700 dark:text-slate-200">{view.run.issueKey}</span>
        {!pilot && issue?.summary && <span className="min-w-0 truncate">{issue.summary}</span>}
      </nav>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]" inert={gateVisible}>
        <div className="space-y-5">
          {run.error && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <ErrorBox error={run.error} title="Не удалось обновить данные прогона" />
              </div>
              <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void run.refetch()} title="Загрузить данные прогона заново">
                Повторить
              </Button>
            </div>
          )}
          <IssueChangedBanner
            value={view.context.issueChanged}
            busy={act.isPending || options.isPending}
            canRework={!running}
            onRework={
              reworkStep
                ? () =>
                    act.mutate(async () => {
                      // Доработка идет в этом же прогоне: пресет "Доработка", и его шаг по изменению задачи запускается заново.
                      const next = view.run.presetId === REWORK_PRESET ? view : await api.setOptions(id, { presetId: REWORK_PRESET });
                      const stepId = issueReworkStep(next, catalog.data);
                      if (!stepId) throw new Error('В пресете "Доработка" нет шага, который запускается по изменению задачи');
                      await api.retry(id, stepId);
                    })
                : undefined
            }
            onDismiss={() => act.mutate(() => api.dismissIssueChanges(id))}
          />
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{view.run.issueKey}</span>
                  {issue?.type && <Chip>{issue.type}</Chip>}
                  {jiraStatus && (
                    <Tip text="Статус задачи в Jira">
                      <Chip tone="blue">{jiraStatus}</Chip>
                    </Tip>
                  )}
                  <Tip text="Состояние этого прогона Task Pilot">
                    <Chip tone={RUN_LOOK[view.run.status].tone}>прогон: {RUN_LOOK[view.run.status].label}</Chip>
                  </Tip>
                  {view.run.dryRun && (
                    <Tip text="Пробный прогон: шаги, которые что-то меняют снаружи, только показывают, что сделали бы">
                      <Chip tone="violet">пробный прогон</Chip>
                    </Tip>
                  )}
                </div>
                <h1 className="mt-1.5 text-lg font-semibold leading-snug">{pilot ? 'Новый шаг Task Pilot' : (issue?.summary ?? 'Задача еще не загружена из Jira')}</h1>
                {pilot && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{stepRequest.description}</p>}
                {issue && (
                  <div className="mt-2">
                    <IssueMeta labels={issue.labels} components={issue.components} sprint={issue.sprint} />
                  </div>
                )}
                {ac && (
                  <details className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800" open={ac.items.length > 0 && ac.items.length <= 5}>
                    <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">Критерии приемки: {ac.label}</summary>
                    {ac.items.length > 0 && (
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-700 dark:text-slate-300">
                        {/* Критерии из доков и описания пишутся в markdown: код и выделение видны как есть. */}
                        {ac.items.map((item, i) => (
                          <li key={i}>
                            <Markdown text={item} />
                          </li>
                        ))}
                      </ol>
                    )}
                    {ac.planFile && (
                      <p className="mt-2 text-xs text-slate-500">
                        Раздел "Критерии приемки" плана, утвержден вместе с ним: <span className="font-mono wrap-anywhere">{ac.planFile}</span>
                      </p>
                    )}
                  </details>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {issue?.url && (
                  <Tip text="Открыть задачу в Jira в новой вкладке">
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-600 dark:hover:bg-slate-800"
                    >
                      <ExternalLink className="size-4" aria-hidden />
                      Jira
                    </a>
                  </Tip>
                )}
                {!pilot && (
                  <Button variant="secondary" size="sm" icon={RefreshCw} disabled={running || act.isPending} onClick={() => act.mutate(() => api.refreshIssue(id))} title={running ? 'Недоступно, пока прогон выполняется' : 'Перечитать из Jira описание, критерии приемки, метки и спринт задачи'}>
                    Обновить из Jira
                  </Button>
                )}
                {!pilot && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Plus}
                    disabled={fresh.isPending}
                    onClick={() => fresh.mutate(view.run)}
                    title="Начать цикл по задаче заново в отдельном прогоне с тем же пресетом, репозиторием и стендом. Этот прогон сохранится, вернуться к нему можно переключателем прогонов"
                  >
                    Новый прогон
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  disabled={running || remove.isPending}
                  onClick={() => setConfirmDelete(true)}
                  title={running ? 'Выполняющийся прогон удалить нельзя: сначала остановите его' : 'Удалить этот прогон насовсем. Сначала спросит подтверждение'}
                >
                  Удалить
                </Button>
              </div>
            </div>
            {confirmDelete && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/40" role="alertdialog" aria-label="Удалить прогон">
                <p className="text-red-800 dark:text-red-300">
                  Удалить этот прогон насовсем? Удалятся его шаги, лента, подтверждения и результаты шагов. Ветки, рабочие папки и доки задачи останутся.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button variant="danger" size="sm" icon={Trash2} disabled={running || remove.isPending} onClick={() => remove.mutate()}>
                    Удалить насовсем
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Отмена
                  </Button>
                </div>
              </div>
            )}

            {!pilot && (
              <>
                <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
                  <RunSwitcher issueKey={view.run.issueKey} current={view.run} repoTitle={(id) => profiles.data?.repos.find((r) => r.id === id)?.title ?? id} />
                  <Tip text="Набор шагов цикла. Смена пресета меняет шаги этого прогона: выполненные шаги и их результаты остаются, ожидающее подтверждение сгорает">
                    <label className="flex items-center gap-2">
                      <span className="text-slate-500">Пресет:</span>
                      <select
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                        value={view.run.presetId}
                        disabled={locked}
                        onChange={(e) => options.mutate({ presetId: e.target.value })}
                      >
                        {catalog.data && !preset && <option value={view.run.presetId}>{view.run.presetId} (нет в каталоге)</option>}
                        {!catalog.data && <option value={view.run.presetId}>{view.run.presetId}</option>}
                        {catalog.data?.presets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  </Tip>
                  <Tip text="Репозиторий, в котором агент работает с кодом задачи. Подбирается по метке repo:, компонентам и стороне задачи (метка frontend или backend, без нее префикс [Front] или [Back] в названии) и меняется только до первого выполненного шага">
                    <label className="flex items-center gap-2">
                      <span className="text-slate-500">Репозиторий:</span>
                      <select
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                        value={view.run.repoId}
                        disabled={repoLocked}
                        onChange={(e) => options.mutate({ repoId: e.target.value })}
                      >
                        {profiles.data && !repo && <option value={view.run.repoId}>{view.run.repoId} (нет профиля)</option>}
                        {profiles.data?.repos.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.title}
                            {r.connected ? '' : ' (контур не подключен)'}
                          </option>
                        ))}
                      </select>
                    </label>
                  </Tip>
                  <Tip text="Стенд для деплоя и тестирования. Рядом со стендом его текущий релиз по Bamboo. Смена стенда гасит ожидающие подтверждения">
                    <label className="flex items-center gap-2">
                      <span className="text-slate-500">Стенд:</span>
                      <select
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                        value={view.run.standId ?? ''}
                        disabled={locked}
                        onChange={(e) => options.mutate({ standId: e.target.value || null })}
                      >
                        <option value="">без стенда</option>
                        {profiles.data && view.run.standId && !stand && <option value={view.run.standId}>{view.run.standId} (нет профиля)</option>}
                        {profiles.data && standsFor(profiles.data, view.run.repoId).map((s) => (
                          <option key={s.id} value={s.id} disabled={!s.deployable}>
                            {s.title}
                            {s.deployable ? '' : ' (выключен)'}
                            {releaseOn(s.id) ? ` · ${releaseOn(s.id)}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  </Tip>
                  <Tip text="Пробный прогон: шаги, которые меняют что-то снаружи (Jira, git, Bitbucket), только показывают, что сделали бы, а их агенты не запускаются">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-violet-600"
                        checked={view.run.dryRun}
                        disabled={locked}
                        onChange={(e) => options.mutate({ dryRun: e.target.checked })}
                      />
                      Пробный прогон, без внешних действий
                    </label>
                  </Tip>
                </div>
                <div className="mt-2 space-y-1 text-xs text-slate-500">
                  {choice?.unsure && choice.repoId === view.run.repoId ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      <span>
                        Репозиторий {choice.reason}. Стоит {repo?.title ?? view.run.repoId} по умолчанию: выберите репозиторий задачи в списке выше или
                        оставьте этот, до выбора прогон не запустится
                      </span>
                      <Button variant="secondary" size="sm" disabled={locked} onClick={() => options.mutate({ repoId: view.run.repoId })}>
                        Оставить {repo?.title ?? view.run.repoId}
                      </Button>
                    </div>
                  ) : (
                    choice &&
                    choice.repoId === view.run.repoId && (
                      <p>
                        Репозиторий выбран {choice.reason}
                        {choice.candidates.length > 1 ? `; подходят также: ${choice.candidates.filter((c) => c !== choice.repoId).join(', ')}` : ''}
                      </p>
                    )
                  )}
                  {repoContour && !repoContour.connected && (
                    <p className="text-amber-700 dark:text-amber-400">
                      Контур {repoContour.title} еще не подключен: шаги с git и Bamboo для этого репозитория пока не выполнятся
                    </p>
                  )}
                  {standNow && <StandNow s={standNow} issueKey={view.run.issueKey} />}
                  {stand?.notes.length ? (
                    <p>
                      Стенд {stand.title}: {stand.notes.join('; ')}
                    </p>
                  ) : null}
                </div>
              </>
            )}

            <RunProgress view={view} onJump={jump} />

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <MainAction view={view} busy={act.isPending} onStart={() => act.mutate(() => api.start(id))} onOpenGate={() => setGateId(view.approval?.id ?? null)} onAnswer={showQuestions} />
              {running && (
                <Button variant="danger" icon={Square} disabled={act.isPending} onClick={() => act.mutate(() => api.stop(id))} title="Остановить агента и сборку текущего шага. Шаг упадет с ошибкой Остановлено владельцем, его можно повторить">
                  Остановить
                </Button>
              )}
            </div>
            <NowPanel
              steps={view.steps}
              events={events}
              waiting={view.context.waiting as WaitingContext | undefined}
              onJump={jump}
              onOpenEvent={(eventId) => setFeed({ initial: null, target: { eventId } })}
              onAsk={askAbout}
            />
            {error && (
              <div className="mt-3">
                <ErrorBox error={error} title="Действие не выполнено" />
              </div>
            )}
          </Card>

          {view.questions.length > 0 && (
            <div ref={questionsRef} className="space-y-3">
              {view.questions.map((q) => (
                <QuestionCard key={q.id} question={q} stepTitle={stepTitle(q.stepId)} busy={act.isPending} onAnswer={(answer) => act.mutate(() => api.answer(q.id, answer))} />
              ))}
            </div>
          )}

          <Card>
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="font-semibold">Шаги цикла</h2>
              <span className="text-xs text-slate-500">Отметка - план: что выполнять из шагов, которые еще не начинались. Серые шаги появятся на следующих этапах</span>
            </div>
            <ol className="divide-y divide-slate-100 dark:divide-slate-800">
              {groups.done.length > 0 && (
                <StepFold label={`Выполнено: ${groups.done.length}`} steps={groups.done} open={expanded.done} onToggle={() => setExpanded((e) => ({ ...e, done: !e.done }))} />
              )}
              {expanded.done && groups.done.map(stepRow)}
              {groups.ahead.map(stepRow)}
              {groups.off.length > 0 && (
                <StepFold label={`Не в плане: ${groups.off.length}`} steps={groups.off} open={expanded.off} onToggle={() => setExpanded((e) => ({ ...e, off: !e.off }))} />
              )}
              {expanded.off && groups.off.map(stepRow)}
            </ol>
          </Card>
          <TimingPanel
            runId={id}
            live={view.run.status === 'running' || view.run.status === 'waiting_owner' || view.run.status === 'waiting'}
            onJump={jump}
            onOpenFeed={(target) => setFeed({ initial: null, target })}
          />
          <JournalPanel runId={id} onOpen={(eventId) => setFeed({ initial: null, target: { eventId } })} onJump={jump} />
        </div>

        <div className="space-y-5">
          <FeedCard key={id} events={events} onOpen={(initial) => setFeed({ initial })} />
          <AskCard runId={id} draft={askDraft} onDraft={setAskDraft} inputRef={askRef} />
          <Card>
            <h2 className="border-b border-slate-100 px-4 py-3 font-semibold dark:border-slate-800">Контекст</h2>
            <ContextPanel context={view.context} steps={view.steps} />
          </Card>
          {/* Пока идет шаг с QA-браузером, кадры появляются в папке артефактов, и галерея перечитывается сама. */}
          <ArtifactsCard runId={id} live={view.steps.some((s) => s.browser && s.status === 'running')} />
        </div>

      </div>
        {feed && <FeedDialog runId={id} live={events} initial={feed.initial} target={feed.target} onClose={() => setFeed(undefined)} />}
        {gate && (
          <GateDialog
            runId={id}
            approval={gate}
            stepTitle={gateStep?.title ?? ''}
            canRework={gateStep?.canRework === true}
            running={!gateStep?.background && chainRunning}
            busy={act.isPending}
            comment={comments[gate.id] ?? ''}
            onComment={(text) => setComments((prev) => ({ ...prev, [gate.id]: text }))}
            answers={answers[gate.id] ?? []}
            onAnswers={(list) => setAnswers((prev) => ({ ...prev, [gate.id]: list }))}
            settings={gateStep?.settings ?? []}
            onSettings={(patch) => {
              // Подтверждение на прежние настройки сгорает, а новое откроется само, когда шаг спросит его заново.
              setGateId(null);
              act.mutate(() => api.setParams(id, gate.stepId, patch));
            }}
            onClose={closeGate}
            onApprove={() => {
              setGateId(null);
              act.mutate(() => api.decide(gate.id, 'approve'));
            }}
            onReject={(comment) => {
              setGateId(null);
              act.mutate(() => api.decide(gate.id, 'reject', comment || undefined));
            }}
            onRework={(comment) => {
              setGateId(null);
              act.mutate(() => api.decide(gate.id, 'rework', comment));
            }}
          />
        )}
    </>
  );
}
