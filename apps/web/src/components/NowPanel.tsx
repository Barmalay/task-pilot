import { Activity, Hourglass, MessageCircleQuestion } from 'lucide-react';
import type { EventDto, StepDto } from '@task-pilot/api-types';
import { nowLines, silentMinutes, staleQuestion, type WaitingContext } from '../now.ts';
import { ago, Button, cx, useNow } from '../ui.tsx';

/**
 * Строки "сейчас" под главной кнопкой прогона: что делает каждый идущий шаг (его последнее событие и когда оно было) и
 * чего ждет шаг, который ждет события снаружи. Шаг, который молчит дольше десяти минут, помечен: он мог зависнуть, и
 * кнопка "Спросить" подставляет вопрос о нем в карточку вопросов о прогоне. Название шага ведет к его строке, событие -
 * в окно ленты.
 */
export function NowPanel({
  steps,
  events,
  waiting,
  onJump,
  onOpenEvent,
  onAsk,
}: {
  steps: StepDto[];
  events: EventDto[];
  waiting: WaitingContext | undefined;
  onJump: (stepId: string) => void;
  onOpenEvent: (eventId: number) => void;
  onAsk: (question: string) => void;
}) {
  const now = useNow();
  const lines = nowLines(steps, events, waiting, now);
  if (!lines.length) return null;
  return (
    <div className="mt-3 space-y-1.5 text-sm" data-now>
      {lines.map((l) => {
        const Icon = l.kind === 'waiting' ? Hourglass : Activity;
        return (
          <div
            key={l.stepId}
            data-now-step={l.stepId}
            data-stale={l.stale || undefined}
            className={cx('flex min-w-0 items-center gap-2', l.stale ? 'text-amber-800 dark:text-amber-300' : 'text-slate-700 dark:text-slate-200')}
          >
            <Icon className={cx('size-4 shrink-0', l.stale ? 'text-amber-500' : l.kind === 'waiting' ? 'text-sky-500' : 'text-blue-500')} aria-hidden />
            <span className="shrink-0 text-slate-500">Сейчас</span>
            <button type="button" className="shrink-0 font-medium hover:underline" onClick={() => onJump(l.stepId)} title="Перейти к строке шага">
              {l.title}
            </button>
            {l.eventId !== null ? (
              <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => onOpenEvent(l.eventId!)} title={`${l.text}. Открыть событие в ленте`}>
                {l.text}
              </button>
            ) : (
              <span className="min-w-0 truncate" title={l.text}>
                {l.text}
              </span>
            )}
            {l.at && <span className="shrink-0 text-xs tabular-nums text-slate-500">{l.stale ? `молчит ${silentMinutes(l.at, now)} мин` : ago(l.at)}</span>}
            {l.stale && (
              <Button
                variant="ghost"
                size="sm"
                icon={MessageCircleQuestion}
                className="shrink-0"
                onClick={() => onAsk(staleQuestion(l, now))}
                title="Шаг молчит дольше десяти минут и мог зависнуть: подставить вопрос о нем в карточку вопросов о прогоне. Агент только читает ленту, шаги и код"
              >
                Спросить
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
