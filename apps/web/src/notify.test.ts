import { describe, expect, it } from 'vitest';
import type { EventDto } from '@task-pilot/api-types';
import { noticeOf } from './notify.ts';

const event = (over: Partial<EventDto>): EventDto => ({ id: 7, runId: 'r1', stepId: null, ts: '2026-09-23T10:00:00.000Z', type: 'step.log', message: null, data: null, issueKey: 'TEAM-2799', ...over });

describe('notification of an event', () => {
  it('asks for an approval and relays a question of the agent with the task key first', () => {
    expect(noticeOf(event({ type: 'approval.requested', message: 'Деплой на stable' }))).toEqual({
      title: 'Нужно ваше подтверждение',
      body: 'TEAM-2799: Деплой на stable',
      href: '/runs/r1',
      tag: 'task-pilot-7',
    });
    expect(noticeOf(event({ type: 'question.asked', message: 'Агент спрашивает: Войдите\nтестовым   номером' }))?.body).toBe('TEAM-2799: Агент спрашивает: Войдите тестовым номером');
  });

  it('names the task once when the event text already starts with its key', () => {
    expect(noticeOf(event({ type: 'approval.requested', message: 'TEAM-2799: коммит, пуш и PR' }))?.body).toBe('TEAM-2799: коммит, пуш и PR');
  });

  it('tells that the agent answered the question of the owner about the run', () => {
    expect(noticeOf(event({ type: 'ask.answered', message: 'Ответ на вопрос: шаг ждет сборку' }))).toMatchObject({ title: 'Ответ на ваш вопрос о прогоне', body: 'TEAM-2799: Ответ на вопрос: шаг ждет сборку' });
  });

  it('tells about a failed or finished run and not about other run statuses', () => {
    expect(noticeOf(event({ type: 'run.status', data: { status: 'failed' } }))).toMatchObject({ title: 'Шаг упал', body: 'TEAM-2799: Прогон остановлен на ошибке' });
    expect(noticeOf(event({ type: 'run.status', data: { status: 'completed' } }))?.title).toBe('Прогон выполнен');
    expect(noticeOf(event({ type: 'run.status', data: { status: 'running' } }))).toBeNull();
  });

  it('keeps quiet about events without a run and about ordinary events', () => {
    expect(noticeOf(event({ runId: null, type: 'approval.requested' }))).toBeNull();
    expect(noticeOf(event({ type: 'step.status' }))).toBeNull();
  });

  it('tells about a firing monitoring alert and opens its dashboard, but not about a resolved one', () => {
    const alert = (state: string) => event({ runId: null, issueKey: undefined, type: 'monitor.alert', message: 'Алерт: RBA: ни одной строки за 15m', data: { dashboard: 'rba', state } });
    expect(noticeOf(alert('firing'))).toEqual({ title: 'Алерт мониторинга', body: 'Алерт: RBA: ни одной строки за 15m', href: '/monitor/rba', tag: 'task-pilot-7' });
    expect(noticeOf(alert('ok'))).toBeNull();
  });

  it('cuts a long text so the notification stays readable', () => {
    const n = noticeOf(event({ type: 'issue.changed', message: 'x'.repeat(400) }));
    expect(n!.body.length).toBe(180);
    expect(n!.body.endsWith('...')).toBe(true);
  });
});
