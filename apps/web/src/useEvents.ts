import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { EventDto } from '@task-pilot/api-types';
import { changesAttention } from './attention.ts';
import { noticeOf, show } from './notify.ts';
import { batchRefresh, refreshKeysOf } from './refresh.ts';

const RECONNECT_MS = 3000;
/** Сколько копятся перечитывания экрана прогона, прежде чем уйти одной пачкой. */
const REFRESH_MS = 150;

/**
 * Подписка на поток SSE с переподключением. Браузер сам переподключается только после обрыва;
 * если сервер ответил не потоком (например, прокси вернул 502, пока сервер перезапускается),
 * EventSource закрывается навсегда, поэтому он пересоздается по таймеру.
 */
function subscribe(url: string, onMessage: (e: EventDto) => void, onOpen: () => void): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const connect = () => {
    source = new EventSource(url);
    source.onopen = onOpen;
    source.onmessage = (m: MessageEvent<string>) => onMessage(JSON.parse(m.data) as EventDto);
    source.onerror = () => {
      if (stopped || source?.readyState !== EventSource.CLOSED) return;
      source.close();
      timer = setTimeout(connect, RECONNECT_MS);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}

/**
 * Живая лента событий прогона: хранит последние события и перечитывает то, что они сделали устаревшим (сам
 * прогон и его время, стенды после деплоя, галерею после шагов с артефактами, см. `refreshKeysOf`). Перечитывания копятся
 * и уходят одной пачкой не позже чем через REFRESH_MS: при подключении сервер отдает историю прогона, и так она
 * дает одно перечитывание, а не по одному на событие. После переподключения (например, сервер перезапустился)
 * прогон перечитывается целиком той же пачкой, а с закрытием экрана ожидающая пачка отменяется.
 */
export function useRunEvents(runId: string): EventDto[] {
  const qc = useQueryClient();
  const [events, setEvents] = useState<EventDto[]>([]);
  useEffect(() => {
    setEvents([]);
    const refresh = batchRefresh((keys) => {
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    }, REFRESH_MS);
    const stop = subscribe(
      `/api/runs/${runId}/events`,
      (e) => {
        setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev.slice(-299), e]));
        refresh.add(refreshKeysOf(e, runId));
      },
      () => refresh.add([['run', runId]]),
    );
    return () => {
      stop();
      refresh.cancel();
    };
  }, [runId, qc]);
  return events;
}

/**
 * Общие события сервера: каталог и профили перечитываются при перезагрузке каталога и после переподключения,
 * задачи и прогоны - после удаления прогона. События прогонов, где нужен владелец, превращаются в уведомления и
 * пополняют их историю, а запросы и закрытия подтверждений и вопросов обновляют "Ждут вас" в шапке.
 */
export function useGlobalEvents(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribe(
        '/api/events',
        (e) => {
          const notice = noticeOf(e);
          if (notice) {
            show(notice);
            void qc.invalidateQueries({ queryKey: ['notifications'] });
          }
          if (changesAttention(e.type)) void qc.invalidateQueries({ queryKey: ['attention'] });
          if (e.type === 'catalog.updated') void qc.invalidateQueries({ queryKey: ['catalog'] });
          // Алерт сработал или снят: обзор и дашборды показывают новое состояние сразу, не дожидаясь опроса.
          if (e.type === 'monitor.alert') void qc.invalidateQueries({ queryKey: ['monitor'] });
          // Агент потратил, лимит поменяли или он кончился: шапка и экран "История" показывают расход сразу.
          if (e.type === 'agent.finished' || e.type === 'agent.failed' || e.type.startsWith('budget.')) void qc.invalidateQueries({ queryKey: ['budget'] });
          // Доступ к интеграции сменился, возможно в другой вкладке: экран интеграций и шапка перечитываются, а после смены
          // аккаунта Jira - и доска: "мои" задачи теперь другого человека.
          if (e.type === 'integration.changed') {
            void qc.invalidateQueries({ queryKey: ['integrations'] });
            void qc.invalidateQueries({ queryKey: ['account'] });
            if ((e.data as { integration?: unknown } | null)?.integration === 'jira') {
              void qc.invalidateQueries({ queryKey: ['tasks'] });
              void qc.invalidateQueries({ queryKey: ['sprints'] });
            }
          }
          // Стенды перечитаны из Bamboo: выбор стенда в прогоне и экран "Стенды" показывают новый список.
          if (e.type === 'stands.updated') {
            void qc.invalidateQueries({ queryKey: ['profiles'] });
            void qc.invalidateQueries({ queryKey: ['stands'] });
          }
          // Прогон удалили, возможно в другой вкладке: карточки задач и переключатели прогонов перечитываются, а с ним
          // ушли и его файлы.
          if (e.type === 'run.deleted') {
            void qc.invalidateQueries({ queryKey: ['tasks'] });
            void qc.invalidateQueries({ queryKey: ['runs'] });
            void qc.invalidateQueries({ queryKey: ['cache'] });
          }
          // Кэш очистили, возможно в другой вкладке: колонка "Кэш" и карточка места на диске показывают новые размеры.
          if (e.type === 'cache.cleared') void qc.invalidateQueries({ queryKey: ['cache'] });
        },
        () => {
          // После переподключения (например, сервер перезапустился) то, что могло прийти мимо потока, перечитывается.
          for (const queryKey of [['catalog'], ['profiles'], ['me'], ['attention'], ['notifications']]) void qc.invalidateQueries({ queryKey });
        },
      ),
    [qc],
  );
}
