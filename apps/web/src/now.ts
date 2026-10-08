import type { WaitEvent } from '@task-pilot/step-kit';
import type { EventDto, StepDto } from '@task-pilot/api-types';
import { waitWords } from './waiting.ts';

/** Сколько идущий шаг может молчать, прежде чем экран предупредит, что он мог зависнуть. */
export const STALE_MS = 10 * 60_000;

/** Что сейчас делает шаг, который идет или ждет события: последнее событие шага и когда оно было. */
export interface NowLine {
  stepId: string;
  title: string;
  kind: 'running' | 'waiting';
  text: string;
  /** Когда было последнее событие шага или началось ожидание; null - неизвестно. */
  at: string | null;
  /** Событие, которое показано: по нему строка открывает ленту. */
  eventId: number | null;
  /** Идущий шаг молчит дольше STALE_MS: мог зависнуть. Ждущий события шаг не молчит, а ждет, и так не помечается. */
  stale: boolean;
}

/** Ожидание события из контекста прогона. */
export interface WaitingContext {
  stepId?: string;
  event?: WaitEvent;
  since?: string;
}

/**
 * Строки "сейчас" прогона: по одной на идущий шаг (шаги цепочки первыми, затем фоновые) и на шаг, который ждет события
 * снаружи. У идущего шага - его последнее событие в живой ленте, без событий - начало шага; у ждущего - чего он ждет и
 * с какого времени.
 */
export function nowLines(steps: StepDto[], events: EventDto[], waiting: WaitingContext | undefined, now: number): NowLine[] {
  const active = steps.filter((s) => s.status === 'running' || s.status === 'waiting').sort((a, b) => Number(a.background) - Number(b.background));
  return active.map((s): NowLine => {
    if (s.status === 'waiting') {
      const own = waiting?.stepId === s.stepId ? waiting : undefined;
      return { stepId: s.stepId, title: s.title, kind: 'waiting', text: own?.event ? `ждет ${waitWords(own.event).of}` : 'ждет события', at: own?.since ?? s.startedAt, eventId: null, stale: false };
    }
    const last = events.findLast((e) => e.stepId === s.stepId);
    const at = last?.ts ?? s.startedAt;
    return {
      stepId: s.stepId,
      title: s.title,
      kind: 'running',
      text: last?.message ?? (last ? last.type : 'шаг начался'),
      at,
      eventId: last?.id ?? null,
      stale: at !== null && now - Date.parse(at) > STALE_MS,
    };
  });
}

/** Сколько минут шаг молчит с момента at. */
export const silentMinutes = (at: string, now: number) => Math.max(0, Math.round((now - Date.parse(at)) / 60_000));

/** Вопрос агенту о шаге, который молчит: его подставляет кнопка "Спросить" строки "сейчас". */
export function staleQuestion(line: Pick<NowLine, 'title' | 'at'>, now: number): string {
  return `Шаг "${line.title}" молчит${line.at ? ` ${silentMinutes(line.at, now)} мин` : ''}. Что он сейчас делает, не завис ли он и что мне сделать?`;
}
