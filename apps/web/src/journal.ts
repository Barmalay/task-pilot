import type { RunHistoryDto, RunJournal } from '@task-pilot/api-types';
import type { Tone } from './ui.tsx';

/** Вид записи журнала на экране. */
export type JournalKind = 'rework' | 'rejected' | 'retry' | 'failure' | 'loop' | 'denial';

/** Строка журнала прогона: когда, какой шаг, что случилось и событие ленты с подробностями. */
export interface JournalRow {
  at: string;
  stepId: string;
  step: string;
  kind: JournalKind;
  text: string;
  eventId?: number;
}

/** Как показывать виды записей: подпись и цвет. */
export const JOURNAL_LOOK: Record<JournalKind, { label: string; tone: Tone }> = {
  failure: { label: 'Упал', tone: 'red' },
  rework: { label: 'Переделать', tone: 'amber' },
  rejected: { label: 'Отклонено', tone: 'amber' },
  retry: { label: 'Повтор с замечанием', tone: 'blue' },
  loop: { label: 'Круг петли', tone: 'violet' },
  denial: { label: 'Отказ агенту', tone: 'slate' },
};

/**
 * Сбои, правки владельца, круги петель и отказы агенту одним списком, новые сверху: свежий сбой виден сразу. Ответы
 * агенту показывает панель времени.
 */
export function journalRows(j: RunJournal): JournalRow[] {
  const base = (x: { at: string; stepId: string; step: string; eventId?: number }) => ({ at: x.at, stepId: x.stepId, step: x.step, ...(x.eventId !== undefined ? { eventId: x.eventId } : {}) });
  return [
    ...j.corrections.map(
      (x): JournalRow => ({
        ...base(x),
        kind: x.decision,
        // У повтора заголовок - ошибка прошлой попытки: впереди то, что владелец сказал агенту.
        text: x.decision === 'retry' ? `${x.comment ?? ''}${x.title ? ` (после ошибки: ${x.title})` : ''}` : x.comment ? `${x.title}: ${x.comment}` : x.title,
      }),
    ),
    ...j.failures.map((x): JournalRow => ({ ...base(x), kind: 'failure', text: x.error })),
    ...j.loops.map((x): JournalRow => ({ ...base(x), kind: 'loop', text: `круг ${x.round} из ${x.max}` })),
    ...j.denials.map((x): JournalRow => ({ ...base(x), kind: 'denial', text: x.tools.join(', ') })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

/** Плашки истории: сколько было падений, правок владельца, кругов петель и отказов агенту; нули не показываются. */
export function journalChips(c: RunHistoryDto['journal']): { label: string; tone: Tone }[] {
  return [
    { n: c.failures, label: 'падения', tone: JOURNAL_LOOK.failure.tone },
    { n: c.reworks, label: 'переделать', tone: JOURNAL_LOOK.rework.tone },
    { n: c.rejects, label: 'отклонено', tone: JOURNAL_LOOK.rejected.tone },
    { n: c.loops, label: 'круги петель', tone: JOURNAL_LOOK.loop.tone },
    { n: c.denials, label: 'отказы агенту', tone: JOURNAL_LOOK.denial.tone },
  ]
    .filter((x) => x.n > 0)
    .map((x) => ({ label: `${x.label}: ${x.n}`, tone: x.tone }));
}
