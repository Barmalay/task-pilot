import type { EventDto } from '@task-pilot/api-types';
import { noticeOf, type Notice } from './notify.ts';

/** Уведомление истории: то же, что показывает браузер, с событием и временем. */
export interface NoticeItem extends Notice {
  id: number;
  at: string;
}

/** Уведомления одного дня в истории: подпись дня и уведомления от новых к старым. */
export interface NoticeDay {
  label: string;
  items: NoticeItem[];
}

/** История уведомлений из событий: только те, о которых вкладка уведомляет, в том же порядке. */
export function noticeItems(events: EventDto[]): NoticeItem[] {
  return events.flatMap((e) => {
    const n = noticeOf(e);
    return n ? [{ ...n, id: e.id, at: e.ts }] : [];
  });
}

/**
 * Сколько уведомлений новее просмотренного. Без отметки просмотра - ни одного: история, которая была до первого
 * открытия списка, считается прочитанной, и счетчик растет только от новых уведомлений.
 */
export function unreadCount(items: Pick<NoticeItem, 'id'>[], seen: number | null): number {
  return seen === null ? 0 : items.filter((i) => i.id > seen).length;
}

/** Самое новое уведомление: его отметка значит, что просмотрено все; null - уведомлений нет. */
export function newestId(items: Pick<NoticeItem, 'id'>[]): number | null {
  return items.reduce<number | null>((max, i) => (max === null || i.id > max ? i.id : max), null);
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Подпись дня уведомления: сегодня, вчера или дата. */
export function dayLabel(iso: string, now: number): string {
  const day = new Date(iso);
  const today = new Date(now);
  if (dayKey(day) === dayKey(today)) return 'Сегодня';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(day) === dayKey(yesterday)) return 'Вчера';
  return day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

/** История по дням: уведомления идут от новых к старым, дни - тоже. */
export function noticeDays(items: NoticeItem[], now: number): NoticeDay[] {
  const days: NoticeDay[] = [];
  for (const item of items) {
    const label = dayLabel(item.at, now);
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }
  return days;
}

/** Время уведомления в списке: часы и минуты. */
export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Где хранится последнее просмотренное уведомление: у каждого браузера свое. */
export const SEEN_KEY = 'task-pilot.notices-seen';

/**
 * Последнее просмотренное уведомление в этом браузере: 0 - уведомлений еще не было; null - история в этом браузере
 * еще не загружалась или хранилище недоступно.
 */
export function loadSeen(): number | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const v = raw === null ? NaN : Number(raw);
    return Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

/** Запоминает последнее просмотренное уведомление. */
export function saveSeen(id: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(id));
  } catch {
    // Хранилище недоступно (приватный режим): счетчик просто не запомнится.
  }
}
