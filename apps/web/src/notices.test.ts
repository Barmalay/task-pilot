import { describe, expect, it } from 'vitest';
import type { EventDto } from '@task-pilot/api-types';
import { dayLabel, newestId, noticeDays, noticeItems, unreadCount } from './notices.ts';

const event = (id: number, over: Partial<EventDto>): EventDto => ({ id, runId: 'r1', stepId: null, ts: '2026-09-30T10:00:00', type: 'step.log', message: null, data: null, issueKey: 'TEAM-7', ...over });
const NOW = new Date(2026, 8, 30, 18, 0).getTime();

describe('history of notices', () => {
  it('keeps only the events the tab notifies about, with their id and time, in the given order', () => {
    const items = noticeItems([
      event(9, { type: 'question.asked', message: 'Какой стенд?' }),
      event(8, { type: 'run.status', data: { status: 'running' } }),
      event(7, { type: 'monitor.alert', runId: null, message: 'Алерт: доля ошибок', data: { state: 'firing', dashboard: 'team-1' } }),
    ]);
    expect(items.map((i) => [i.id, i.title, i.href, i.at])).toEqual([
      [9, 'Агент спрашивает', '/runs/r1', '2026-09-30T10:00:00'],
      [7, 'Алерт мониторинга', '/monitor/team-1', '2026-09-30T10:00:00'],
    ]);
  });

  it('counts only notices newer than the one seen last, and none before the list was ever opened', () => {
    const items = [{ id: 12 }, { id: 11 }, { id: 5 }];
    expect(unreadCount(items, 11)).toBe(1);
    expect(unreadCount(items, 12)).toBe(0);
    expect(unreadCount(items, null)).toBe(0);
    expect(newestId(items)).toBe(12);
    expect(newestId([])).toBeNull();
  });

  it('names the day of a notice: today, yesterday or the date, with the year only for another year', () => {
    expect(dayLabel(new Date(2026, 8, 30, 9, 5).toISOString(), NOW)).toBe('Сегодня');
    expect(dayLabel(new Date(2026, 8, 29, 23, 59).toISOString(), NOW)).toBe('Вчера');
    expect(dayLabel(new Date(2026, 8, 3, 12).toISOString(), NOW)).toBe('3 сентября');
    expect(dayLabel(new Date(2025, 11, 31, 12).toISOString(), NOW)).toBe('31 декабря 2025 г.');
  });

  it('groups notices by day keeping them newest first', () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();
    const item = (id: number, iso: string) => ({ id, at: iso, title: 't', body: 'b', href: '/', tag: `t${id}` });
    const days = noticeDays([item(3, at(30, 12)), item(2, at(30, 8)), item(1, at(29, 20))], NOW);
    expect(days.map((d) => [d.label, d.items.map((i) => i.id)])).toEqual([
      ['Сегодня', [3, 2]],
      ['Вчера', [1]],
    ]);
  });
});
