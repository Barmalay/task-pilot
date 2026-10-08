import { ChevronRight } from 'lucide-react';
import type { EventDto } from '@task-pilot/api-types';
import { hasDetails } from '../feed.ts';
import { cx } from '../ui.tsx';

const TYPE_COLOR: Record<string, string> = {
  'approval.requested': 'border-amber-400',
  'approval.decided': 'border-amber-400',
  'approval.stale': 'border-amber-400',
  'question.asked': 'border-amber-500',
  'question.answered': 'border-amber-300 dark:border-amber-700',
  'question.expired': 'border-amber-200 dark:border-amber-800',
  'agent.started': 'border-violet-500',
  'agent.progress': 'border-violet-400 dark:border-violet-600',
  'agent.text': 'border-violet-200 dark:border-violet-900',
  'agent.tool': 'border-slate-100 dark:border-slate-800',
  'agent.finished': 'border-emerald-500',
  'agent.denied': 'border-orange-500',
  'agent.failed': 'border-red-500',
  'run.stopping': 'border-slate-500 dark:border-slate-400',
  'loop.restart': 'border-cyan-500',
  'engine.error': 'border-red-500',
  'step.log': 'border-slate-200 dark:border-slate-700',
};

const TYPE_TEXT: Record<string, string> = {
  'agent.text': 'whitespace-pre-line italic text-slate-600 dark:text-slate-300',
  'agent.denied': 'text-orange-800 dark:text-orange-300',
  'agent.failed': 'text-red-700 dark:text-red-300',
  'question.expired': 'text-slate-500 dark:text-slate-400',
};

// Вызовы инструментов агента идут потоком: одна мелкая строка без шапки, шаг виден в подсказке.
const COMPACT = new Set(['agent.tool']);

function time(ts: string): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Лента событий прогона, новые сверху. Цвет левой границы показывает тип события: подтверждения
 * и вопросы агента янтарные, работа агента фиолетовая, новый круг доработки бирюзовый, сбои и отказы
 * в доступе красные и оранжевые. Вызовы инструментов агента показываются мелкой приглушенной строкой,
 * его мысли курсивом. С onOpen строка открывается кликом, а у событий с подробностями (дифф правки,
 * вывод команды, содержимое подтверждения, вопрос с ответом) справа значок.
 */
export function EventFeed({ events, onOpen, selectedId, className }: { events: EventDto[]; onOpen?: (e: EventDto) => void; selectedId?: number | null; className?: string }) {
  if (!events.length) return <p className="px-4 py-6 text-sm text-slate-500">Событий пока нет</p>;
  return (
    <ol className={cx('space-y-1 overflow-y-auto px-4 py-3 text-sm', className)}>
      {[...events].reverse().map((e) => {
        const border = TYPE_COLOR[e.type] ?? 'border-blue-300 dark:border-blue-800';
        const details = hasDetails(e);
        const open = onOpen
          ? {
              role: 'button',
              tabIndex: 0,
              onClick: () => onOpen(e),
              onKeyDown: (k: { key: string; preventDefault(): void }) => {
                if (k.key !== 'Enter' && k.key !== ' ') return;
                k.preventDefault();
                onOpen(e);
              },
            }
          : {};
        const row = cx(onOpen && 'cursor-pointer rounded-r hover:bg-slate-50 dark:hover:bg-slate-800/60', selectedId === e.id && 'bg-blue-50 dark:bg-blue-950/40');
        const mark = details && onOpen && <ChevronRight className="ml-auto size-3.5 shrink-0 self-center text-slate-400" aria-label="есть подробности" />;
        if (COMPACT.has(e.type)) {
          return (
            <li
              key={e.id}
              data-event={e.type}
              aria-current={selectedId === e.id ? 'true' : undefined}
              className={cx('flex gap-2 border-l-2 pl-2 font-mono text-xs text-slate-400 dark:text-slate-500', border, row)}
              title={e.stepId ?? undefined}
              {...open}
            >
              <span className="shrink-0 tabular-nums">{time(e.ts)}</span>
              <span className="min-w-0 wrap-anywhere">{e.message}</span>
              {mark}
            </li>
          );
        }
        return (
          <li key={e.id} data-event={e.type} aria-current={selectedId === e.id ? 'true' : undefined} className={cx('flex gap-2 border-l-2 py-0.5 pl-2', border, row)} {...open}>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-xs text-slate-400">
                <span className="tabular-nums">{time(e.ts)}</span>
                {e.stepId && <span className="font-mono">{e.stepId}</span>}
              </div>
              <div className={cx('break-words', TYPE_TEXT[e.type] ?? 'text-slate-700 dark:text-slate-200')}>{e.message}</div>
            </div>
            {mark}
          </li>
        );
      })}
    </ol>
  );
}
