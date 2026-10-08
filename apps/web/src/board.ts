import type { RunStatus } from '@task-pilot/step-kit';
import type { TransitionDto } from '@task-pilot/api-types';

/**
 * Колонки доски: статусы с задачами в порядке доски, затем незнакомые доске статусы в порядке появления.
 * Пока карточку тянут, к ним добавляются статусы, куда ее можно перевести, даже если в них пока нет задач.
 */
export function boardColumns(order: string[], present: string[], targets: string[]): string[] {
  const wanted = new Set([...present, ...targets]);
  const known = new Set(order);
  return [...order.filter((s) => wanted.has(s)), ...[...wanted].filter((s) => !known.has(s))];
}

/**
 * Куда можно перетащить задачу из статуса from: статус и переходы, которые в него ведут. Переход в тот же
 * статус и переход с неизвестным статусом колонки не дают.
 */
export function dropTargets(transitions: TransitionDto[], from: string): Map<string, TransitionDto[]> {
  const targets = new Map<string, TransitionDto[]>();
  for (const t of transitions) {
    if (t.to && t.to !== from) targets.set(t.to, [...(targets.get(t.to) ?? []), t]);
  }
  return targets;
}

/** Фильтр доски по прогону задачи. */
export type RunFilter = 'all' | 'active' | 'started' | 'done';

/** Значения фильтра по прогону по порядку: подпись и пояснение. */
export const RUN_FILTERS: { id: RunFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'Все', hint: 'Все задачи, с прогоном и без' },
  { id: 'active', label: 'Идет', hint: 'Прогон выполняется, ждет события (сборки, деплоя, мержа PR) или вас: подтверждения или ответа агенту' },
  { id: 'started', label: 'Запускался', hint: 'Прогон запускали, и он остановился: стоит на паузе или упал шаг' },
  { id: 'done', label: 'Выполнен', hint: 'Все выбранные шаги прогона выполнены' },
];

/**
 * Подходит ли задача под фильтр по статусу ее последнего прогона. Задача без прогона и с прогоном, который еще не
 * запускали, видна только без фильтра.
 */
export function matchesRun(filter: RunFilter, status: RunStatus | null): boolean {
  if (filter === 'active') return status === 'running' || status === 'waiting_owner' || status === 'waiting';
  if (filter === 'started') return status === 'paused' || status === 'failed';
  if (filter === 'done') return status === 'completed';
  return true;
}
