import type { Issue } from '@task-pilot/step-kit';
import type { OwnerWaitDto, RunHistoryDto, RunTimingDto, StepTimingDto, TimeKind, TimeSegmentDto } from '@task-pilot/api-types';
import { journalOf } from './journal.ts';
import type { Redactor } from './lib/redact.ts';
import type { RunRow, Store } from './store/db.ts';

/** Событие прогона, из которого считается время: статусы шагов и прогона, запросы и решения подтверждений. */
export interface TimingEvent {
  ts: string;
  type: string;
  stepId: string | null;
  message: string | null;
  data: unknown;
}

/** Все, из чего складывается время прогона. */
export interface TimingInput {
  now: string;
  /** События прогона по порядку. */
  events: TimingEvent[];
  /** Перезапуски сервера: шаги, которые на этот момент работали, прерваны без события статуса. */
  restarts: string[];
  questions: { stepId: string; question: string; status: string; createdAt: string; answeredAt: string | null }[];
  sessions: { stepId: string; startedAt: string; finishedAt: string | null; costUsd: number }[];
  /** Шаги прогона по порядку: так идут строки времени шагов. */
  order: string[];
  /**
   * Фоновые шаги: их время видно в их строках целиком, а в суммы прогона входит только то, когда не шла цепочка, прогон
   * не стоял на паузе и не шел другой фоновый шаг, иначе время прогона удвоилось бы.
   */
  background?: string[];
  title(stepId: string): string;
}

type Span = [number, number];

/** Статусы, в которых прогон стоит и ждет, что владелец его продолжит. */
const PAUSED = new Set(['paused', 'failed', 'idle']);
const LIVE = new Set(['running', 'waiting_owner', 'waiting']);
/** Статусы шага, время в которых - его работа: ожидание сборки или деплоя идет в системы, как раньше опрос внутри шага. */
const WORKING = new Set(['running', 'waiting']);
const DECISIONS = new Set(['approved', 'rework', 'rejected']);

function merge(list: Span[]): Span[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function total(list: Span[]): number {
  return list.reduce((sum, [a, b]) => sum + b - a, 0);
}

/** Пересечение двух объединенных списков отрезков. */
function intersect(x: Span[], y: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of x) {
    for (const [c, d] of y) {
      const from = Math.max(a, c);
      const to = Math.min(b, d);
      if (to > from) out.push([from, to]);
    }
  }
  return merge(out);
}

/** Отрезки x без отрезков y. */
function subtract(x: Span[], y: Span[]): Span[] {
  let rest = merge(x);
  for (const [c, d] of merge(y)) {
    rest = rest.flatMap(([a, b]): Span[] => (d <= a || c >= b ? [[a, b]] : ([[a, Math.min(b, c)], [Math.max(a, d), b]] as Span[]).filter(([p, q]) => q > p)));
  }
  return rest;
}

function clip(list: Span[], from: number, to: number): Span[] {
  return merge(list.map(([a, b]): Span => [Math.max(a, from), Math.min(b, to)]));
}

const iso = (ms: number) => new Date(ms).toISOString();

function statusOf(e: TimingEvent): string | null {
  const s = (e.data as { status?: unknown } | null)?.status;
  return typeof s === 'string' ? s : null;
}

/** Чем закончился запрос подтверждения: из данных события, а у старых событий - по началу сообщения. */
function decisionOf(e: TimingEvent): string | null {
  if (e.type === 'approval.stale') return 'stale';
  const d = (e.data as { decision?: unknown } | null)?.decision;
  if (typeof d === 'string' && DECISIONS.has(d)) return d;
  const m = e.message ?? '';
  return m.startsWith('Подтверждено') ? 'approved' : m.startsWith('На доработку') ? 'rework' : m.startsWith('Отклонено') ? 'rejected' : null;
}

/**
 * Время прогона по его событиям, вопросам агента и сессиям агента. Работа шага - отрезки, когда он в статусе
 * "выполняется": из них вычитаются вопросы агента (это ответы владельца), в остатке сессии агента - время агента,
 * остальное - работа шага без агента (сборки, ожидание CI и деплоя, git, Jira). Подтверждения считаются от запроса
 * до решения или сгорания, паузы - пока прогон стоит на паузе или упал. Перезапуск сервера закрывает работу шагов,
 * которые на тот момент выполнялись: прерванный шаг статуса в событиях не оставляет.
 */
export function runTiming(input: TimingInput): RunTimingDto {
  const at = (s: string) => Date.parse(s);
  const marks = [
    ...input.events.map((e, i) => ({ t: at(e.ts), i, e })),
    ...input.restarts.map((r, i) => ({ t: at(r), i: input.events.length + i, e: null })),
  ].sort((a, b) => a.t - b.t || a.i - b.i);

  let start: number | null = null;
  let runStatus: string | null = null;
  let runSince = 0;
  let lastRunEvent = 0;
  const runSpans: { status: string; span: Span }[] = [];
  const steps = new Map<string, { status: string; since: number }>();
  const work = new Map<string, Span[]>();
  const attempts = new Map<string, number>();
  const openApproval = new Map<string, { from: number; label: string }>();
  const approvals: { stepId: string; label: string; from: number; to: number | null; outcome: string | null }[] = [];
  const push = <T>(m: Map<string, T[]>, key: string, v: T) => m.set(key, [...(m.get(key) ?? []), v]);
  const setRun = (status: string, t: number) => {
    if (runStatus !== null) runSpans.push({ status: runStatus, span: [runSince, t] });
    runStatus = status;
    runSince = t;
  };

  for (const { t, e } of marks) {
    if (!e) {
      // Перезапуск: выполнявшиеся шаги прерваны, прогон встал на паузу, а событий об этом нет. Ждущий шаг ждет дальше.
      for (const [stepId, s] of steps) {
        if (s.status !== 'running') continue;
        push(work, stepId, [s.since, t] as Span);
        steps.set(stepId, { status: 'failed', since: t });
      }
      if (runStatus === 'running') setRun('paused', t);
      continue;
    }
    const status = statusOf(e);
    if (e.type === 'run.status' && status) {
      setRun(status, t);
      lastRunEvent = t;
      if (status === 'running' && start === null) start = t;
    } else if (e.type === 'step.status' && status && e.stepId) {
      const prev = steps.get(e.stepId);
      if (prev && WORKING.has(prev.status)) push(work, e.stepId, [prev.since, t] as Span);
      // Запуск шага начинается с работы или, у шага с подтверждением без черновика, с ожидания подтверждения.
      if (LIVE.has(status) && !(prev && LIVE.has(prev.status))) attempts.set(e.stepId, (attempts.get(e.stepId) ?? 0) + 1);
      steps.set(e.stepId, { status, since: t });
    } else if (e.type === 'approval.requested' && e.stepId) {
      const open = openApproval.get(e.stepId);
      if (open) approvals.push({ stepId: e.stepId, label: open.label, from: open.from, to: t, outcome: 'stale' });
      openApproval.set(e.stepId, { from: t, label: e.message ?? input.title(e.stepId) });
    } else if ((e.type === 'approval.decided' || e.type === 'approval.stale') && e.stepId) {
      const open = openApproval.get(e.stepId);
      if (!open) continue;
      approvals.push({ stepId: e.stepId, label: open.label, from: open.from, to: t, outcome: decisionOf(e) });
      openApproval.delete(e.stepId);
    }
  }

  const now = at(input.now);
  const live = runStatus !== null && LIVE.has(runStatus);
  const empty: RunTimingDto = {
    start: null,
    end: null,
    live,
    wallMs: 0,
    workMs: 0,
    agentMs: 0,
    systemMs: 0,
    questionsMs: 0,
    approvalsMs: 0,
    pauseMs: 0,
    otherMs: 0,
    costUsd: 0,
    steps: [],
    pauses: [],
    waits: [],
  };
  if (start === null) return empty;
  const from = start;
  const end = live ? Math.max(now, from) : Math.max(lastRunEvent, from);
  if (runStatus !== null) runSpans.push({ status: runStatus, span: [runSince, end] });
  for (const [stepId, s] of steps) if (WORKING.has(s.status)) push(work, stepId, [s.since, end] as Span);
  for (const [stepId, open] of openApproval) approvals.push({ stepId, label: open.label, from: open.from, to: null, outcome: null });

  const pauses = clip(
    runSpans.filter((r) => PAUSED.has(r.status)).map((r) => r.span),
    from,
    end,
  );
  const questionSpans = new Map<string, Span[]>();
  for (const q of input.questions) {
    const to = q.answeredAt ? at(q.answeredAt) : q.status === 'open' ? end : at(q.createdAt);
    push(questionSpans, q.stepId, [at(q.createdAt), to] as Span);
  }
  const agentSpans = new Map<string, Span[]>();
  const cost = new Map<string, number>();
  for (const s of input.sessions) {
    push(agentSpans, s.stepId, [at(s.startedAt), s.finishedAt ? at(s.finishedAt) : end] as Span);
    cost.set(s.stepId, (cost.get(s.stepId) ?? 0) + s.costUsd);
  }
  const approvalSpans = new Map<string, Span[]>();
  for (const a of approvals) push(approvalSpans, a.stepId, [a.from, a.to ?? end] as Span);

  const ids = [...new Set([...input.order, ...work.keys(), ...approvalSpans.keys()])];
  const spansOf = new Map<string, Record<TimeKind, Span[]>>();
  const stepTimings = ids
    .map((stepId): StepTimingDto => {
      const running = clip(work.get(stepId) ?? [], from, end);
      const questions = intersect(running, merge(questionSpans.get(stepId) ?? []));
      const agent = subtract(intersect(running, merge(agentSpans.get(stepId) ?? [])), questions);
      const system = subtract(subtract(running, questions), agent);
      const waiting = clip(approvalSpans.get(stepId) ?? [], from, end);
      spansOf.set(stepId, { question: questions, agent, system, approval: waiting });
      const segments: TimeSegmentDto[] = (
        [
          ['question', questions],
          ['agent', agent],
          ['system', system],
          ['approval', waiting],
        ] as [TimeKind, Span[]][]
      )
        .flatMap(([kind, list]) => list.map(([a, b]) => ({ kind, from: iso(a), to: iso(b) })))
        .sort((x, y) => x.from.localeCompare(y.from));
      return {
        stepId,
        title: input.title(stepId),
        attempts: attempts.get(stepId) ?? 0,
        workMs: total(running),
        agentMs: total(agent),
        systemMs: total(system),
        questionsMs: total(questions),
        approvalsMs: total(waiting),
        costUsd: cost.get(stepId) ?? 0,
        segments,
      };
    })
    .filter((s) => s.workMs > 0 || s.approvalsMs > 0);

  // Суммы прогона: шаги цепочки целиком, фоновые шаги - только время, когда больше ничего не шло и прогон не стоял на
  // паузе. Фоновый шаг, который шел, пока цепочка ждала мерж, время прогона не удлиняет, а шедший после конца цепочки -
  // удлиняет. Расход агентов входит весь.
  const background = new Set(input.background ?? []);
  const counted: Record<TimeKind, number> = { question: 0, agent: 0, system: 0, approval: 0 };
  let covered = pauses;
  for (const s of [...stepTimings.filter((t) => !background.has(t.stepId)), ...stepTimings.filter((t) => background.has(t.stepId))]) {
    const spans = spansOf.get(s.stepId)!;
    for (const kind of Object.keys(counted) as TimeKind[]) counted[kind] += total(background.has(s.stepId) ? subtract(spans[kind], covered) : spans[kind]);
    covered = merge([...covered, ...Object.values(spans).flat()]);
  }
  const wallMs = end - from;
  const workMs = counted.question + counted.agent + counted.system;
  const approvalsMs = counted.approval;
  const pauseMs = total(pauses);
  const waits: OwnerWaitDto[] = [
    ...approvals.map((a) => ({
      kind: 'approval' as const,
      stepId: a.stepId,
      label: a.label,
      from: iso(a.from),
      to: a.to === null ? null : iso(a.to),
      ms: (a.to ?? end) - a.from,
      outcome: a.outcome,
    })),
    ...input.questions.map((q) => {
      const to = q.answeredAt ? at(q.answeredAt) : null;
      return {
        kind: 'question' as const,
        stepId: q.stepId,
        label: q.question.length > 160 ? `${q.question.slice(0, 157)}...` : q.question,
        from: q.createdAt,
        to: to === null ? null : iso(to),
        ms: (to ?? (q.status === 'open' ? end : at(q.createdAt))) - at(q.createdAt),
        outcome: q.status === 'open' ? null : q.status,
      };
    }),
  ].sort((x, y) => x.from.localeCompare(y.from));

  return {
    start: iso(from),
    end: iso(end),
    live,
    wallMs,
    workMs,
    agentMs: counted.agent,
    systemMs: counted.system,
    questionsMs: counted.question,
    approvalsMs,
    pauseMs,
    otherMs: Math.max(0, wallMs - workMs - approvalsMs - pauseMs),
    costUsd: stepTimings.reduce((acc, s) => acc + s.costUsd, 0),
    steps: stepTimings,
    pauses: pauses.map(([a, b]) => ({ from: iso(a), to: iso(b) })),
    waits,
  };
}

/** Время прогона из хранилища на момент now; background говорит, какие шаги фоновые. */
export function timingOf(store: Store, run: RunRow, title: (stepId: string) => string, now = new Date(), background: (stepId: string) => boolean = () => false): RunTimingDto {
  const order = store.getSteps(run.id).map((s) => s.stepId);
  return runTiming({
    now: now.toISOString(),
    events: store.timingEvents(run.id),
    restarts: store.restartTimes(),
    questions: store.questionsOf(run.id),
    sessions: store.agentSessionsOf(run.id),
    order,
    background: order.filter(background),
    title,
  });
}

/** Прогноз при первом запуске прогона из его ленты (`run.forecast`); null - прогноза не было. */
function forecastAtStart(store: Store, runId: string): { totalMs: number } | null {
  const totalMs = (store.firstEventOf(runId, 'run.forecast')?.data as { totalMs?: unknown } | null | undefined)?.totalMs;
  return typeof totalMs === 'number' ? { totalMs } : null;
}

/** Кругов всех петель доработки прогона по записи `loops` контекста: сумма по шагам петель. */
export function loopRoundsOf(loops: unknown): number {
  if (!loops || typeof loops !== 'object') return 0;
  return Object.values(loops).reduce((sum: number, n) => sum + (typeof n === 'number' ? n : 0), 0);
}

/** История прогонов, новые сверху: время каждого, сбои и правки владельца и признаки задачи для будущего прогноза. */
export function historyOf(store: Store, title: (stepId: string) => string, redact: Redactor, limit: number, now = new Date(), background: (stepId: string) => boolean = () => false): RunHistoryDto[] {
  return store
    .listRuns(limit)
    .map((run): RunHistoryDto => {
      const t = timingOf(store, run, title, now, background);
      const j = journalOf(store, run.id, title, redact);
      const ctx = store.getContext(run.id);
      const issue = ctx.issue as Issue | undefined;
      const ac = ctx.ac;
      const files = (ctx.changes as { files?: unknown } | undefined)?.files;
      const { steps, pauses: _pauses, waits, ...totals } = t;
      return {
        run,
        summary: issue?.summary ?? (ctx.stepRequest as { description?: string } | undefined)?.description ?? null,
        timing: {
          ...totals,
          steps: steps.map(({ segments: _segments, ...rest }) => rest),
          questions: waits.filter((w) => w.kind === 'question').length,
          approvals: waits.filter((w) => w.kind === 'approval').length,
        },
        features: {
          labels: issue?.labels ?? [],
          components: issue?.components ?? [],
          type: issue?.type ?? null,
          acCount: Array.isArray(ac) ? ac.length : null,
          files: Array.isArray(files) ? files.length : null,
          loops: loopRoundsOf(ctx.loops),
        },
        journal: {
          failures: j.failures.length,
          reworks: j.corrections.filter((x) => x.decision === 'rework').length,
          rejects: j.corrections.filter((x) => x.decision === 'rejected').length,
          loops: j.loops.length,
          denials: j.denials.length,
        },
        forecast: forecastAtStart(store, run.id),
      };
    });
}
