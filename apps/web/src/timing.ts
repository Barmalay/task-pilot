import type { RunHistoryDto, RunTimingDto, StepTimingDto, TimeKind } from '@task-pilot/api-types';
import { sortBy, type Sort } from './sort.ts';

/** Длительность по-русски: "45 с", "12 мин 5 с", "1 ч 20 мин". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Время в таблицах: прочерк, если его не было, "<1 с" для мгновенных шагов, иначе длительность. */
export function spent(ms: number): string {
  if (ms <= 0) return '-';
  return ms < 1000 ? '<1 с' : duration(ms);
}

/** Время суток по-русски: "14:05". */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Вид времени на ленте: виды времени шага, пауза прогона и остаток между шагами. */
export type TimeLook = TimeKind | 'pause' | 'other';

/** Подпись, цвет и пояснение каждого вида времени. */
export const TIME_LOOK: Record<TimeLook, { label: string; bar: string; hint: string }> = {
  agent: { label: 'Агент', bar: 'bg-violet-500', hint: 'Агент Claude работает: читает код, пишет, проверяет, ведет QA-браузер' },
  system: { label: 'Сборки и системы', bar: 'bg-sky-500', hint: 'Шаг работает без агента: сборка и тесты, ожидание CI и деплоя, git, Jira' },
  question: { label: 'Ответы агенту', bar: 'bg-amber-400', hint: 'Агент ждет вашего ответа на вопрос: капча, SMS, решение по сценарию' },
  approval: { label: 'Подтверждения', bar: 'bg-orange-500', hint: 'Шаг ждет вашего подтверждения внешнего действия' },
  pause: { label: 'Пауза', bar: 'bg-slate-300 dark:bg-slate-600', hint: 'Прогон стоял: упал шаг или прогон на паузе, пока вы не продолжили' },
  other: { label: 'Между шагами', bar: 'bg-slate-200 dark:bg-slate-700', hint: 'Проверки "уже сделано" и переходы движка между шагами' },
};

/** Время прогона без пауз: сколько он шел на самом деле, пока его не ставили на паузу и не роняли. */
export const activeMs = (t: Pick<RunTimingDto, 'wallMs' | 'pauseMs'>) => Math.max(0, t.wallMs - t.pauseMs);

/** Пауза сворачивается на ленте в узкую метку, если она дольше 5 минут и дольше 5% показанного участка. */
const COLLAPSE_MS = 5 * 60_000;
const COLLAPSE_SHARE = 0.05;
/** Ширина свернутой паузы на оси, в процентах. */
const BREAK_WIDTH = 2;

/** Кусок оси: отрезок реального времени, показанный в масштабе, или свернутая пауза. */
interface AxisPiece {
  from: number;
  to: number;
  left: number;
  width: number;
  collapsed: boolean;
}

/**
 * Ось ленты прогона: показанный участок (весь прогон или выделенный масштабом) без долгих пауз. Свернутая пауза
 * занимает узкую метку с ее длительностью, остальное время делит ось пропорционально, поэтому ночь на паузе не
 * сжимает работу прогона в полоску.
 */
export interface TimeAxis {
  from: number;
  to: number;
  /** Свернутые паузы: положение метки на оси и сколько длилась пауза на показанном участке. */
  breaks: { left: number; width: number; ms: number; from: string; to: string }[];
  /** Положение момента на оси, в процентах. */
  x(ms: number): number;
  /** Момент по положению на оси: из выделения мышью получается участок для масштаба. */
  at(percent: number): number;
}

/** Ось ленты для участка range (по умолчанию весь прогон); у прогона без начала оси нет. */
export function timeAxis(t: RunTimingDto, range?: { from: number; to: number }): TimeAxis | null {
  if (!t.start || !t.end) return null;
  const from = range?.from ?? Date.parse(t.start);
  const to = range?.to ?? Date.parse(t.end);
  if (to <= from) return null;
  const span = to - from;
  let cut = t.pauses
    .map((p) => [Math.max(from, Date.parse(p.from)), Math.min(to, Date.parse(p.to))] as const)
    .filter(([a, b]) => b - a >= COLLAPSE_MS && b - a > span * COLLAPSE_SHARE);
  // Участок целиком из пауз сворачивать не во что: он показывается в масштабе.
  if (cut.reduce((sum, [a, b]) => sum + b - a, 0) >= span) cut = [];
  const active = span - cut.reduce((sum, [a, b]) => sum + b - a, 0);
  const activeWidth = 100 - BREAK_WIDTH * cut.length;
  const pieces: AxisPiece[] = [];
  let cursor = from;
  let left = 0;
  const push = (a: number, b: number, collapsed: boolean) => {
    if (b <= a) return;
    const width = collapsed ? BREAK_WIDTH : ((b - a) / active) * activeWidth;
    pieces.push({ from: a, to: b, left, width, collapsed });
    left += width;
  };
  for (const [a, b] of cut) {
    push(cursor, a, false);
    push(a, b, true);
    cursor = b;
  }
  push(cursor, to, false);
  const x = (ms: number) => {
    const at = Math.min(Math.max(ms, from), to);
    const p = pieces.find((piece) => at <= piece.to) ?? pieces.at(-1)!;
    return p.left + ((at - p.from) / (p.to - p.from)) * p.width;
  };
  const back = (percent: number) => {
    const at = Math.min(Math.max(percent, 0), 100);
    const p = pieces.find((piece) => at <= piece.left + piece.width) ?? pieces.at(-1)!;
    return Math.round(p.from + ((at - p.left) / p.width) * (p.to - p.from));
  };
  const breaks = pieces.filter((p) => p.collapsed).map((p) => ({ left: p.left, width: p.width, ms: p.to - p.from, from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString() }));
  return { from, to, breaks, x, at: back };
}

/** Полоса на ленте: левый край и ширина в процентах оси. */
export interface GanttBar {
  kind: TimeLook;
  left: number;
  width: number;
  from: string;
  to: string;
}

/** Строка ленты: шаг или паузы прогона. */
export interface GanttRow {
  key: string;
  title: string;
  bars: GanttBar[];
}

/** Самая узкая видимая полоса: секундный вопрос на часовом прогоне иначе не разглядеть. */
const MIN_WIDTH = 0.4;

/**
 * Лента прогона по оси axis (по умолчанию весь прогон со свернутыми долгими паузами): сверху паузы, если они были,
 * ниже шаги по порядку с отрезками их времени. Отрезки вне показанного участка не показываются, на краю
 * обрезаются; свернутые паузы вместо полосы показывают метки оси. Виды из hidden скрыты.
 */
export function ganttRows(t: RunTimingDto, axis: TimeAxis | null = timeAxis(t), hidden: ReadonlySet<TimeLook> = new Set()): GanttRow[] {
  if (!axis) return [];
  // Пауза, от которой на оси осталась метка, полосой не рисуется: и целиком, и обрезанная краем участка.
  const collapsed = (from: string, to: string) => axis.breaks.some((b) => Date.parse(b.from) < Date.parse(to) && Date.parse(b.to) > Date.parse(from));
  const bar = (kind: TimeLook, from: string, to: string): GanttBar | null => {
    if (hidden.has(kind) || Date.parse(to) <= axis.from || Date.parse(from) >= axis.to) return null;
    const left = axis.x(Date.parse(from));
    const width = Math.max(axis.x(Date.parse(to)) - left, MIN_WIDTH);
    return { kind, left: Math.min(left, 100 - MIN_WIDTH), width: Math.min(width, 100 - Math.min(left, 100 - MIN_WIDTH)), from, to };
  };
  const bars = (list: { kind: TimeLook; from: string; to: string }[]) => list.map((g) => bar(g.kind, g.from, g.to)).filter((b): b is GanttBar => b !== null);
  const pauses = bars(t.pauses.filter((p) => !collapsed(p.from, p.to)).map((p) => ({ kind: 'pause' as const, ...p })));
  const pauseRow: GanttRow[] = t.pauses.length ? [{ key: 'pause', title: 'Прогон стоял', bars: pauses }] : [];
  return [...pauseRow, ...t.steps.map((s) => ({ key: s.stepId, title: s.title, bars: bars(s.segments) }))];
}

/**
 * Доли видов времени во времени прогона без пауз, в процентах, для сводной полосы: пауза в учет не идет, ее длительность
 * показывается отдельно.
 */
export function shares(t: RunTimingDto): { kind: TimeLook; ms: number; percent: number }[] {
  const parts: [TimeLook, number][] = [
    ['agent', t.agentMs],
    ['system', t.systemMs],
    ['question', t.questionsMs],
    ['approval', t.approvalsMs],
    ['other', t.otherMs],
  ];
  const total = activeMs(t);
  return parts.filter(([, ms]) => ms > 0).map(([kind, ms]) => ({ kind, ms, percent: total > 0 ? (ms / total) * 100 : 0 }));
}

/** Столбец таблицы шагов, по которому она сортируется; без сортировки шаги идут по порядку прогона. */
export type StepSortKey = 'title' | 'workMs' | 'agentMs' | 'systemMs' | 'questionsMs' | 'approvalsMs' | 'attempts' | 'costUsd';

/** Сортировка таблицы шагов. */
export type StepSort = Sort<StepSortKey>;

/** Шаги таблицы времени в порядке сортировки: без нее - как в прогоне, числа по значению, названия по алфавиту. */
export function sortSteps<T extends Pick<StepTimingDto, StepSortKey>>(steps: T[], sort: StepSort | null): T[] {
  return sortBy(steps, sort, (s, key) => s[key]);
}

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Шаг в истории прогонов: сколько раз выполнялся и медианы его времени. */
export interface StepStat {
  stepId: string;
  title: string;
  runs: number;
  workMs: number;
  agentMs: number;
  ownerMs: number;
  attempts: number;
}

/**
 * Медианы времени шагов по истории прогонов: в скольких прогонах шаг работал, сколько обычно длится его работа,
 * агент и ожидание владельца (ответы агенту и подтверждения). Медиана, а не среднее: один прогон, где вопрос
 * провисел час, не должен сдвигать типичное время шага. Порядок - по первому появлению шага в истории.
 */
export function stepStats(history: RunHistoryDto[]): StepStat[] {
  const byStep = new Map<string, { title: string; rows: { workMs: number; agentMs: number; ownerMs: number; attempts: number }[] }>();
  for (const h of history) {
    for (const s of h.timing.steps) {
      const entry = byStep.get(s.stepId) ?? { title: s.title, rows: [] };
      entry.rows.push({ workMs: s.workMs, agentMs: s.agentMs, ownerMs: s.questionsMs + s.approvalsMs, attempts: s.attempts });
      byStep.set(s.stepId, entry);
    }
  }
  return [...byStep].map(([stepId, e]) => ({
    stepId,
    title: e.title,
    runs: e.rows.length,
    workMs: median(e.rows.map((r) => r.workMs)),
    agentMs: median(e.rows.map((r) => r.agentMs)),
    ownerMs: median(e.rows.map((r) => r.ownerMs)),
    attempts: median(e.rows.map((r) => r.attempts)),
  }));
}
