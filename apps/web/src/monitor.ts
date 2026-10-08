import type { Breakdown, Panel, Period, Refresh } from '@task-pilot/step-kit';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Периоды дашборда по порядку показа. */
export const PERIOD_OPTIONS: { id: Period; label: string; short: string }[] = [
  { id: '15m', label: '15 минут', short: '15 мин' },
  { id: '1h', label: 'час', short: '1 ч' },
  { id: '6h', label: '6 часов', short: '6 ч' },
  { id: '24h', label: 'сутки', short: '24 ч' },
  { id: '7d', label: 'неделя', short: '7 дн' },
];

/** Интервалы опроса по порядку показа. */
export const REFRESH_OPTIONS: { id: Refresh; label: string }[] = [
  { id: '15s', label: '15 с' },
  { id: '30s', label: '30 с' },
  { id: '1m', label: '1 мин' },
  { id: '5m', label: '5 мин' },
  { id: 'off', label: 'выключен' },
];

/** Интервал опроса в миллисекундах; false - опрос выключен. */
export function refreshMs(r: Refresh): number | false {
  if (r === 'off') return false;
  const n = Number(r.slice(0, -1));
  return r.endsWith('s') ? n * 1000 : n * MINUTE;
}

const plain = new Intl.NumberFormat('ru-RU');
const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

/** Число строк для людей: с разрядами, от 10 тысяч - коротко. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return Math.abs(n) >= 10_000 ? compact.format(n) : plain.format(Math.round(n));
}

/** Доля в процентах: мелкие доли точнее, чтобы fail-open в десятые доли процента не превращался в ноль. */
export function formatRatio(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '-';
  const p = x * 100;
  const digits = p === 0 ? 0 : p < 1 ? 2 : p < 10 ? 1 : 0;
  return `${p.toFixed(digits).replace('.', ',')}%`;
}

/** Величина панели по ее виду: доля у share, число строк у остальных. */
export function formatValue(v: number | null | undefined, kind: 'count' | 'ratio'): string {
  return kind === 'ratio' ? formatRatio(v) : formatCount(v);
}

/** Изменение к прошлому периоду: направление и подпись; без прошлого значения сравнивать не с чем. */
export function deltaOf(value: number, previous: number): { direction: 'up' | 'down' | 'flat'; text: string } {
  if (previous === 0) return value === 0 ? { direction: 'flat', text: 'как в прошлом периоде' } : { direction: 'up', text: 'в прошлом периоде строк не было' };
  const change = (value - previous) / previous;
  if (Math.abs(change) < 0.005) return { direction: 'flat', text: 'как в прошлом периоде' };
  const pct = Math.abs(change * 100);
  const text = `${change > 0 ? '+' : '−'}${pct >= 10 ? Math.round(pct) : pct.toFixed(1).replace('.', ',')}% к прошлому периоду`;
  return { direction: change > 0 ? 'up' : 'down', text };
}

const TICK_STEPS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

/** Шаг делений оси времени: не теснее одного деления на minGap пикселей. */
export function tickStep(from: number, to: number, width: number, minGap = 80): number {
  const most = Math.max(1, Math.floor(width / minGap));
  return TICK_STEPS.find((s) => (to - from) / s <= most) ?? DAY * Math.ceil((to - from) / DAY / most);
}

/** Деления оси времени: круглые моменты по местному времени внутри окна. */
export function timeTicks(from: number, to: number, width: number): { ticks: number[]; step: number } {
  const step = tickStep(from, to, width);
  const offset = new Date(from).getTimezoneOffset() * MINUTE;
  const ticks: number[] = [];
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) ticks.push(t);
  return { ticks, step };
}

/** Подпись деления: часы и минуты, у суточного шага - дата. */
export function formatTick(t: number, step: number): string {
  const d = new Date(t);
  if (step >= DAY) return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Время точки в подсказке: у недели с датой. */
export function formatPoint(t: number, periodMs: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return periodMs > DAY ? `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}` : time;
}

/** Верх оси значений: круглое число не меньше максимума (1, 2, 2.5, 5 и 10 на порядок). */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= max) ?? 10;
  return step * pow;
}

/**
 * Деления оси значений: ноль, середина и верх. Доля без единой строки рисуется до 1%, а не до 100%, иначе нулевая линия
 * fail-open ничего не говорит; у счетчика дробная середина (12,5 строки) не показывается.
 */
export function valueTicks(max: number, kind: 'count' | 'ratio'): number[] {
  if (kind === 'ratio') {
    const top = max > 0 ? Math.min(1, niceMax(max)) : 0.01;
    return [0, top / 2, top];
  }
  const top = niceMax(max);
  return Number.isInteger(top / 2) ? [0, top / 2, top] : [0, top];
}

/** Цвет серии по порядку: слоты палитры в фиксированном порядке, больше восьми серий панель не рисует. */
export function seriesColor(i: number): string {
  return `var(--viz-series-${(i % 8) + 1})`;
}

/** Идентификаторы попытки входа в тексте строки: по ним открывается экран одной попытки. */
export function attemptIdsIn(message: string): string[] {
  const found = new Set<string>();
  for (const m of message.matchAll(/(?:\bstate|flowState|correlationId|correlation id)\s*[=:]?\s*'?([A-Za-z0-9_-]{16,64})/gi)) if (m[1]) found.add(m[1]);
  return [...found];
}

/** Разбивки, которые предлагает провал до панели: поля сервиса и слова из текста, которые разбирает сама панель. */
export function breakdownOptions(panel: Panel): { value: string; label: string }[] {
  const options = [
    { value: 'level', label: 'уровень' },
    { value: 'logger', label: 'логгер' },
    { value: 'version', label: 'версия' },
    { value: 'pod', label: 'под' },
  ];
  const extract = (b: Breakdown | undefined) => (b && typeof b === 'object' ? b.extract : null);
  const prefixes = [panel.type === 'top' ? extract(panel.by) : null, panel.type === 'numbers' ? panel.extract : null].filter((p): p is string => !!p);
  for (const p of new Set(prefixes)) options.push({ value: `extract:${p}`, label: `"${p.trim()}"` });
  return options;
}

/** Длина отрезка для людей: до двух часов в минутах, дальше в часах. */
export function formatSpan(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  return minutes < 120 ? `${minutes} мин` : `${Math.round(ms / HOUR)} ч`;
}

/** Адрес экрана одной попытки. */
export function attemptHref(value: string, at?: number): string {
  return `#/monitor/attempt/${encodeURIComponent(value)}${at ? `/${at}` : ''}`;
}
