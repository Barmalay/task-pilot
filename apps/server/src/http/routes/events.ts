import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventDto } from '@task-pilot/api-types';
import type { EventRow } from '../../store/db.ts';
import { type ServerDeps, stream } from '../support.ts';

/** Смены статуса прогона, о которых владелец узнает уведомлением: прогон упал или закончился. */
const NOTIFY_RUN_STATUS = new Set(['failed', 'completed']);
/** События наблюдателя: мерж PR, замечания ревьюеров, изменения задачи в Jira. */
const WATCH_EVENTS = new Set(['pr.merged', 'pr.review', 'issue.changed']);
/** Прогон ждет владельца: запрос подтверждения, вопрос агента, ответ на вопрос владельца о прогоне. */
const OWNER_EVENTS = new Set(['approval.requested', 'question.asked', 'ask.answered']);
/** Владельца прогон больше не ждет: подтверждение решено или сгорело, вопрос агента отвечен или истек. */
const SETTLED_EVENTS = new Set(['approval.decided', 'approval.stale', 'question.answered', 'question.expired']);
/** Типы событий, из которых бывают уведомления: события прогонов для владельца и алерты мониторинга. */
const NOTICE_TYPES = [...OWNER_EVENTS, ...WATCH_EVENTS, 'run.status', 'monitor.alert'];
/** Сколько событий за раз читает история уведомлений: смен статуса прогона много, уведомлений среди них мало. */
const NOTICE_BATCH = 500;

/**
 * События прогонов, которые идут и в общий поток: из них вкладка Task Pilot показывает уведомления, на каком бы
 * экране ни был владелец. Это все, где нужен владелец или что он ждал: подтверждение, вопрос агента, ответ на его
 * вопрос о прогоне, упавший и законченный прогон, находки наблюдателя.
 */
export function notable(e: Pick<EventRow, 'runId' | 'type' | 'data'>): boolean {
  if (!e.runId) return false;
  if (OWNER_EVENTS.has(e.type) || WATCH_EVENTS.has(e.type)) return true;
  const status = (e.data as { status?: unknown } | null)?.status;
  return e.type === 'run.status' && typeof status === 'string' && NOTIFY_RUN_STATUS.has(status);
}

/** Уведомление ли это для истории уведомлений: событие прогона для владельца или сработавший алерт мониторинга. */
export function noticeable(e: Pick<EventRow, 'runId' | 'type' | 'data'>): boolean {
  if (e.runId) return notable(e);
  return e.type === 'monitor.alert' && (e.data as { state?: unknown } | null)?.state === 'firing';
}

/**
 * Событие прогона, после которого список того, что ждет владельца, стал другим: подтверждение и вопрос появились,
 * решены, отвечены или сгорели. Такие события тоже идут в общий поток: шапка обновляет "Ждут вас" сразу.
 */
export function settles(e: Pick<EventRow, 'runId' | 'type'>): boolean {
  return e.runId !== null && SETTLED_EVENTS.has(e.type);
}

const noticesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * Общий поток и история уведомлений: события без прогона, события прогонов для уведомлений и смены того, что ждет
 * владельца, с ключом задачи для текста уведомления.
 */
export function eventsRoutes(app: FastifyInstance, d: ServerDeps): void {
  const withKey = (e: EventRow): EventDto => (e.runId ? { ...e, issueKey: d.store.getRun(e.runId)?.issueKey ?? null } : e);
  app.get('/api/events', (req, reply) => {
    stream(req, reply, d.bus, [], (e) => e.runId === null || notable(e) || settles(e), withKey);
  });
  // История уведомлений, от новых к старым: те же события, что вкладка показывает уведомлениями.
  app.get('/api/notifications', async (req): Promise<EventDto[]> => {
    const { limit } = noticesQuery.parse(req.query);
    const found: EventRow[] = [];
    let before: number | null = null;
    for (;;) {
      const rows = d.store.eventsOfTypes(NOTICE_TYPES, before, NOTICE_BATCH);
      found.push(...rows.filter(noticeable));
      if (found.length >= limit || rows.length < NOTICE_BATCH) break;
      before = rows[rows.length - 1]!.id;
    }
    return d.redact.deep(found.slice(0, limit).map(withKey));
  });
}
