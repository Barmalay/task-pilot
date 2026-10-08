import type { StepStatus } from '@task-pilot/step-kit';
import type { ForecastDto, RunHistoryDto, StepDto } from '@task-pilot/api-types';

/** Шаг закончен: выполнен, уже был сделан, имитирован пробным прогоном или пропущен. */
export const DONE_STEPS = new Set<StepStatus>(['succeeded', 'already', 'simulated', 'skipped']);

/** Шаги прогона группами для списка: закончены, впереди в плане, не в плане - и шаг, на котором прогон сейчас. */
export interface StepGroups {
  done: StepDto[];
  ahead: StepDto[];
  off: StepDto[];
  /** Идущий или ждущий шаг, а без такого - первый шаг плана впереди; null - план выполнен. */
  current: string | null;
  /** Все идущие и ждущие шаги: шаг цепочки и фоновые шаги рядом с ним; их строки показываются целиком. */
  live: string[];
}

/**
 * Раскладывает шаги прогона по группам в их порядке. Закончившиеся шаги - в своей группе, даже если их потом
 * выключили; не в плане - шаги без отметки, которые не выполнялись.
 */
export function stepGroups(steps: StepDto[]): StepGroups {
  const done = steps.filter((s) => DONE_STEPS.has(s.status));
  const ahead = steps.filter((s) => s.selected && !DONE_STEPS.has(s.status));
  const off = steps.filter((s) => !s.selected && !DONE_STEPS.has(s.status));
  const live = ahead.filter((s) => s.status === 'running' || s.status === 'waiting_owner' || s.status === 'waiting').map((s) => s.stepId);
  const current = live[0] ?? ahead[0]?.stepId ?? null;
  return { done, ahead, off, current, live: live.length ? live : current ? [current] : [] };
}

/** Длительность прогноза по-русски, до минут: "40 с", "12 мин", "1 ч 20 мин". */
export function roughly(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} с`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
}

/** "по 1 прогону", "по 3 прогонам", "по 11 прогонам". */
export function byRuns(n: number): string {
  return `по ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'прогону' : 'прогонам'}`;
}

/** На чем основан прогноз: сколько прогонов истории или что истории пока нет. */
export function basisText(f: Pick<ForecastDto, 'basis'>): string {
  return f.basis ? byRuns(f.basis) : 'истории пока нет, время по видам шагов';
}

/** Расхождение факта с прогнозом в процентах от прогноза, со знаком: "+21%", "-8%". */
export function deviation(factMs: number, forecastMs: number): string {
  const d = Math.round(((factMs - forecastMs) / forecastMs) * 100);
  return `${d > 0 ? '+' : ''}${d}%`;
}

/**
 * Строка прогноза над полосой шагов. До запуска - сколько займет план и из чего, в работе - процент и сколько
 * осталось, после выполнения - за сколько выполнен (время без пауз, factMs) против прогноза при запуске.
 */
export function forecastLine(f: ForecastDto, started: boolean, factMs: number | null): string {
  if (f.percent === 100) {
    const fact = factMs !== null && factMs > 0 ? ` за ${roughly(factMs)}` : '';
    const vs = f.initial && factMs ? `, прогноз при запуске ${roughly(f.initial.totalMs)} (${deviation(factMs, f.initial.totalMs)})` : '';
    return `Выполнено${fact}${vs}`;
  }
  if (!started) {
    const owner = f.ownerMs > 0 ? `, ваши ответы и подтверждения ${roughly(f.ownerMs)}` : '';
    return `Примерно ${roughly(f.totalMs)}: работа ${roughly(f.workMs)}${owner}, ${basisText(f)}`;
  }
  return `${f.percent}%, осталось примерно ${roughly(f.remainingMs)} из ${roughly(f.totalMs)}, ${basisText(f)}`;
}

/**
 * Точность прогноза при запуске по выполненным прогонам истории: медиана отклонения факта (время без пауз) от
 * прогноза в процентах и по скольким последним прогонам она посчитана; null - таких прогонов нет.
 */
export function forecastAccuracy(history: RunHistoryDto[], last = 10): { errorPercent: number; runs: number } | null {
  const errors = history
    .filter((h) => h.run.status === 'completed' && h.forecast && h.forecast.totalMs > 0 && h.timing.wallMs - h.timing.pauseMs > 0)
    .slice(0, last)
    .map((h) => Math.abs(h.timing.wallMs - h.timing.pauseMs - h.forecast!.totalMs) / h.forecast!.totalMs);
  if (!errors.length) return null;
  const sorted = [...errors].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { errorPercent: Math.round(median * 100), runs: errors.length };
}
