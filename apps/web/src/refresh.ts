import type { QueryKey } from '@tanstack/react-query';
import type { EventDto } from '@task-pilot/api-types';

/** События, которые не меняют состояние прогона: из-за них экран не перечитывается. */
const QUIET = new Set(['step.log', 'agent.tool', 'agent.text', 'agent.progress', 'ask.asked', 'ask.answered', 'ask.failed']);

/**
 * Какие запросы экрана прогона устарели после события: сам прогон, его время, журнал сбоев и правок и прогноз, а
 * когда шаг закончился - то, что он по манифесту меняет: стенды после деплоя, галерею после шагов с артефактами.
 * Список закончившегося шага движок кладет в данные события `step.status` (`refresh`). Вопрос владельца о прогоне и
 * ответ на него перечитывают только список вопросов.
 */
export function refreshKeysOf(e: Pick<EventDto, 'type' | 'data'>, runId: string): QueryKey[] {
  const keys: QueryKey[] = [];
  if (!QUIET.has(e.type)) keys.push(['run', runId], ['timing', runId], ['journal', runId], ['forecast', runId]);
  if (e.type.startsWith('ask.')) keys.push(['asks', runId]);
  const refresh = e.type === 'step.status' ? (e.data as { refresh?: unknown } | null)?.refresh : undefined;
  if (Array.isArray(refresh)) {
    if (refresh.includes('stands')) keys.push(['stands']);
    if (refresh.includes('artifacts')) keys.push(['artifacts', runId]);
  }
  return keys;
}

/** Пачка перечитываний: копит ключи запросов и отдает их разом. */
export interface RefreshBatch {
  add(keys: QueryKey[]): void;
  /** Отменяет ожидающую пачку, например когда экран закрыт. */
  cancel(): void;
}

/**
 * Копит ключи запросов и отдает их одной пачкой через delayMs после первого ключа, одинаковые ключи - один раз.
 * Следующие ключи таймер не откладывают: всплеск событий (история прогона при подключении) дает одно
 * перечитывание, а при непрерывном потоке событий экран все равно обновляется не реже раза в delayMs.
 */
export function batchRefresh(flush: (keys: QueryKey[]) => void, delayMs: number): RefreshBatch {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    add(keys) {
      for (const key of keys) pending.set(JSON.stringify(key), key);
      if (timer !== undefined || !pending.size) return;
      timer = setTimeout(() => {
        timer = undefined;
        const batch = [...pending.values()];
        pending.clear();
        flush(batch);
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
