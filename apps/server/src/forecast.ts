import type { StepManifest, StepStatus } from '@task-pilot/step-kit';
import type { EventBus } from './engine/events.ts';
import type { ForecastDto } from '@task-pilot/api-types';
import type { EventRow } from './store/rows.ts';
import type { Store } from './store/db.ts';
import { timingOf } from './timing.ts';

/** Обычное время шага: медианы по прогонам, где шаг выполнился, или время по виду шага, пока истории нет. */
export interface StepNorm {
  /** Прогоны истории, в которых шаг выполнился; пусто - время взято по виду шага. */
  runIds: string[];
  /** Работа Task Pilot: агент, сборки и системы. */
  workMs: number;
  /** Ожидание владельца: ответы агенту и подтверждения. */
  ownerMs: number;
}

/** Выполнение шага в прошлом прогоне: образец обычного времени шага. */
export interface StepSample {
  runId: string;
  stepId: string;
  workMs: number;
  ownerMs: number;
}

/** Шаг плана прогона: что нужно прогнозу о шаге. */
export interface PlanStep {
  stepId: string;
  selected: boolean;
  status: StepStatus;
  startedAt: string | null;
  kind: StepManifest['kind'];
  gate: StepManifest['gate'];
  /** Фоновый шаг идет рядом с цепочкой: время прогона он удлиняет, только если кончается позже нее. */
  background?: boolean;
}

/** Время шага без истории по его виду; шаг с подтверждением добавляет минуту ожидания владельца. */
const KIND_MS: Record<StepManifest['kind'], { workMs: number; ownerMs: number }> = {
  code: { workMs: 30_000, ownerMs: 0 },
  agent: { workMs: 5 * 60_000, ownerMs: 0 },
  hybrid: { workMs: 3 * 60_000, ownerMs: 0 },
  manual: { workMs: 0, ownerMs: 2 * 60_000 },
};
const GATE_OWNER_MS = 60_000;

/** Шаг закончен: его ожидаемое время целиком в сделанном. */
const DONE = new Set<StepStatus>(['succeeded', 'already', 'simulated', 'skipped']);
/** Шаг идет: в сделанное идет прошедшее время, но не больше этой доли ожидаемого, пока шаг не кончится. */
const CURRENT = new Set<StepStatus>(['running', 'waiting_owner', 'waiting']);
const CURRENT_CAP = 0.9;

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Обычное время шагов по образцам: медиана работы и медиана ожидания владельца по прогонам, где шаг выполнился.
 * Медиана, а не среднее: один прогон, где вопрос провисел час, не сдвигает типичное время шага.
 */
export function stepNorms(samples: StepSample[]): Map<string, StepNorm> {
  const byStep = new Map<string, StepSample[]>();
  for (const s of samples) byStep.set(s.stepId, [...(byStep.get(s.stepId) ?? []), s]);
  return new Map(
    [...byStep].map(([stepId, list]) => [
      stepId,
      { runIds: [...new Set(list.map((s) => s.runId))], workMs: median(list.map((s) => s.workMs)), ownerMs: median(list.map((s) => s.ownerMs)) },
    ]),
  );
}

/**
 * Прогноз прогона по плану: ожидаемое время отмеченных шагов из их обычного времени (без истории - по виду шага),
 * сделанное и оставшееся время и процент сделанного по ожидаемому времени шагов, а не по их числу. Закончившийся
 * шаг идет в сделанное целиком, идущий - прошедшим временем, но не больше 90% своего ожидаемого, поэтому пока план
 * не выполнен, процент не доходит до 100. Паузы прогона в прогноз не входят. Фоновый шаг идет рядом с цепочкой и входит
 * в прогноз только тем, насколько кончается позже нее (`backgroundWeights`).
 */
export function forecastRun(steps: PlanStep[], norms: Map<string, StepNorm>, now: number): Omit<ForecastDto, 'initial'> {
  const plan = steps.filter((s) => s.selected);
  const usual = plan.map((s) => {
    const kind = KIND_MS[s.kind];
    const norm = norms.get(s.stepId);
    return { norm, workMs: norm?.workMs ?? kind.workMs, ownerMs: norm?.ownerMs ?? kind.ownerMs + (s.gate === 'none' ? 0 : GATE_OWNER_MS) };
  });
  const weights = backgroundWeights(plan, usual.map((u) => u.workMs + u.ownerMs));
  const rows = plan.map((s, i) => {
    const { norm, ...time } = usual[i]!;
    const workMs = time.workMs * weights[i]!;
    const ownerMs = time.ownerMs * weights[i]!;
    const expectedMs = workMs + ownerMs;
    const elapsed = s.startedAt ? Math.max(0, now - Date.parse(s.startedAt)) : 0;
    const doneMs = DONE.has(s.status) ? expectedMs : CURRENT.has(s.status) ? Math.min(elapsed, expectedMs * CURRENT_CAP) : 0;
    return { stepId: s.stepId, expectedMs, runs: norm?.runIds.length ?? 0, doneMs, workMs, ownerMs, runIds: norm?.runIds ?? [] };
  });
  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + pick(r), 0);
  const totalMs = sum((r) => r.expectedMs);
  const doneMs = sum((r) => r.doneMs);
  const finished = plan.length > 0 && plan.every((s) => DONE.has(s.status));
  return {
    basis: new Set(rows.flatMap((r) => r.runIds)).size,
    totalMs,
    workMs: sum((r) => r.workMs),
    ownerMs: sum((r) => r.ownerMs),
    doneMs: finished ? totalMs : doneMs,
    remainingMs: finished ? 0 : totalMs - doneMs,
    percent: finished ? 100 : totalMs > 0 ? Math.min(99, Math.floor((doneMs / totalMs) * 100)) : 0,
    steps: rows.map(({ stepId, expectedMs, runs }) => ({ stepId, expectedMs, runs })),
  };
}

/**
 * Доля обычного времени каждого шага плана, которая удлиняет прогон: критический путь без графа зависимостей. Шаг цепочки
 * входит целиком. Фоновый шаг стартует, когда закончены шаги цепочки выше него, и идет рядом со следующими, поэтому
 * удлиняет прогон, только если кончается позже цепочки; из фоновых шагов, которые выходят за ее конец, в прогноз идет
 * самый поздний и только своим выходом за конец, остальные идут рядом с ним.
 */
function backgroundWeights(plan: Pick<PlanStep, 'background'>[], expectedMs: number[]): number[] {
  let chain = 0;
  let last: { i: number; end: number } | null = null;
  for (const [i, s] of plan.entries()) {
    if (!s.background) chain += expectedMs[i]!;
    else if (!last || chain + expectedMs[i]! > last.end) last = { i, end: chain + expectedMs[i]! };
  }
  return plan.map((s, i) => {
    if (!s.background) return 1;
    return last?.i === i && expectedMs[i]! > 0 ? Math.max(0, last.end - chain) / expectedMs[i]! : 0;
  });
}

/** Длительность прогноза по-русски, до минут: "40 с", "12 мин", "1 ч 20 мин". */
export function roughly(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} с`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
}

/** "по 1 прогону", "по 3 прогонам", "по 11 прогонам". */
function byRuns(n: number): string {
  return `по ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'прогону' : 'прогонам'}`;
}

/** Строка ленты о прогнозе при первом запуске прогона. */
export function forecastMessage(f: Pick<ForecastDto, 'totalMs' | 'ownerMs' | 'basis'>): string {
  const owner = f.ownerMs > 0 ? `, из них ваши ответы и подтверждения ${roughly(f.ownerMs)}` : '';
  return `Прогноз прогона: примерно ${roughly(f.totalMs)}${owner}, ${f.basis ? byRuns(f.basis) : 'истории пока нет, время по видам шагов'}`;
}

/** Зависимости прогноза: база прогонов, лента и шаги каталога. */
export interface ForecastDeps {
  store: Store;
  bus: EventBus;
  manifestOf: (stepId: string) => StepManifest | undefined;
  /** Сколько последних прогонов берется в историю. */
  limit?: number;
}

/** Сколько живет посчитанное обычное время шагов, если в ленте не было повода пересчитать его раньше. */
const NORMS_TTL_MS = 5 * 60_000;

/**
 * Прогноз времени прогонов по истории. Обычное время шагов считается по последним прогонам и пересчитывается,
 * когда шаг выполнился или прогон удалили, так что каждый новый прогон уточняет прогноз следующих; прогноз прогона
 * не учится на нем самом. При первом запуске прогона прогноз пишется в его ленту событием `run.forecast`: после конца
 * прогона с ним сравнивается факт.
 */
export class ForecastService {
  private readonly d: ForecastDeps;
  private cache: { at: number; samples: StepSample[] } | null = null;

  constructor(deps: ForecastDeps) {
    this.d = deps;
    deps.bus.on('event', (e: EventRow) => this.onEvent(e));
  }

  private onEvent(e: EventRow): void {
    const status = (e.data as { status?: unknown } | null)?.status;
    if (e.type === 'run.deleted' || (e.type === 'step.status' && status === 'succeeded')) this.cache = null;
    if (e.type === 'run.status' && status === 'running' && e.runId) this.remember(e.runId);
  }

  /** Выполнения шагов в последних прогонах: образцы обычного времени - шаги, которые выполнились. */
  private samples(): StepSample[] {
    if (this.cache && Date.now() - this.cache.at < NORMS_TTL_MS) return this.cache.samples;
    const samples: StepSample[] = [];
    for (const run of this.d.store.listRuns(this.d.limit ?? 500)) {
      const statuses = new Map(this.d.store.getSteps(run.id).map((s) => [s.stepId, s.status]));
      for (const s of timingOf(this.d.store, run, (id) => id).steps) {
        if (statuses.get(s.stepId) === 'succeeded') samples.push({ runId: run.id, stepId: s.stepId, workMs: s.agentMs + s.systemMs, ownerMs: s.questionsMs + s.approvalsMs });
      }
    }
    this.cache = { at: Date.now(), samples };
    return samples;
  }

  /** Обычное время шагов по истории без прогона exclude: прогноз прогона не учится на нем самом. */
  norms(exclude?: string): Map<string, StepNorm> {
    return stepNorms(this.samples().filter((s) => s.runId !== exclude));
  }

  /** Прогноз прогона на момент now и прогноз, сделанный при его первом запуске; null - прогона нет. */
  of(runId: string, now = Date.now()): ForecastDto | null {
    if (!this.d.store.getRun(runId)) return null;
    const plan = this.d.store.getSteps(runId).map((s): PlanStep => {
      const m = this.d.manifestOf(s.stepId);
      return { stepId: s.stepId, selected: s.selected, status: s.status, startedAt: s.startedAt, kind: m?.kind ?? 'code', gate: m?.gate ?? 'none', background: m?.background === true };
    });
    const first = this.d.store.firstEventOf(runId, 'run.forecast');
    const data = first?.data as { totalMs?: number; workMs?: number; ownerMs?: number; basis?: number } | null | undefined;
    const initial =
      first && typeof data?.totalMs === 'number' ? { totalMs: data.totalMs, workMs: data.workMs ?? 0, ownerMs: data.ownerMs ?? 0, basis: data.basis ?? 0, at: first.ts } : null;
    return { ...forecastRun(plan, this.norms(runId), now), initial };
  }

  /** Прогноз при первом запуске прогона: пишется в ленту один раз, повторные запуски его не меняют. */
  private remember(runId: string): void {
    if (this.d.store.firstEventOf(runId, 'run.forecast')) return;
    const f = this.of(runId);
    if (!f) return;
    this.d.bus.emitEvent({ runId, type: 'run.forecast', message: forecastMessage(f), data: { totalMs: f.totalMs, workMs: f.workMs, ownerMs: f.ownerMs, basis: f.basis } });
  }
}
