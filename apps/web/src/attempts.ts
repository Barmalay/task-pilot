import { formatPhone, HOUR, type AttemptOutcome, type AttemptStep, type AttemptSummary } from '@task-pilot/step-kit';
import type { Tone } from './ui.tsx';

/** Значения идентификаторов из поля ввода: через пробел, запятую, точку с запятой или с новой строки, без повторов. */
export function splitIds(input: string): string[] {
  return [...new Set(input.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))];
}

/** Длительность для людей: 850 мс, 4,2 с, 28 с, 2 мин 13 с, 1 ч 5 мин. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1).replace('.', ',')} с`;
  if (s < 60) return `${Math.round(s)} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${Math.round(s - m * 60)} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Окна поиска попыток: от последнего часа до недели. */
export const SEARCH_WINDOWS = [
  { id: '1h', label: 'последний час', ms: HOUR },
  { id: '6h', label: '6 часов', ms: 6 * HOUR },
  { id: '24h', label: 'сутки', ms: 24 * HOUR },
  { id: '3d', label: '3 дня', ms: 72 * HOUR },
  { id: '7d', label: 'неделя', ms: 168 * HOUR },
] as const;

/** Итог попытки для экрана. */
export const OUTCOME_VIEW: Record<AttemptOutcome, { label: string; tone: Tone }> = {
  success: { label: 'успех', tone: 'green' },
  failure: { label: 'отказ', tone: 'red' },
  unknown: { label: 'итог не найден', tone: 'slate' },
};

/** Что показывает хронология: главное (шаги, действия, ошибки и итоги) или все строки со служебными. */
export type StepsMode = 'main' | 'all';

/** Главная строка хронологии: ошибка или строка с разбором, кроме служебных. */
export function isMainStep(s: AttemptStep): boolean {
  return s.error || (s.event !== null && s.event.kind !== 'info');
}

/** Строки хронологии под фильтрами: режим, сервисы (null - все) и текст в строке или ее подписи. */
export function visibleSteps(steps: AttemptStep[], mode: StepsMode, services: ReadonlySet<string> | null, text: string): AttemptStep[] {
  const q = text.trim().toLowerCase();
  return steps.filter(
    (s) =>
      (mode === 'all' || isMainStep(s)) &&
      (!services || services.has(s.service)) &&
      (!q || s.message.toLowerCase().includes(q) || (s.event?.label.toLowerCase().includes(q) ?? false) || (s.event?.detail?.toLowerCase().includes(q) ?? false)),
  );
}

/** Значение идентификатора для экрана: телефон в виде +7 916 123-45-67, остальное как есть. */
export function idText(value: string): string {
  return /^7\d{10}$/.test(value) ? formatPhone(value) : value;
}

/** Значения идентификатора сводки по ключу; пусто, если его нет. */
export function idValues(summary: Pick<AttemptSummary, 'ids'>, key: string): string[] {
  return summary.ids.find((i) => i.key === key)?.values ?? [];
}

/** Время строки: 12:01:38.250; с днем - 01.10 12:01:38. */
export function clock(t: number, withDay = false): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return withDay ? `${two(d.getDate())}.${two(d.getMonth() + 1)} ${time}` : `${time}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
