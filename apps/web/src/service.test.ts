import { describe, expect, it } from 'vitest';
import type { ServiceDocDto } from '@task-pilot/api-types';
import { dirtyText, docsShown, restartBlock, restarted, restartNeed, uptimeText } from './service.ts';

const START = '2026-09-28T10:00:00.000Z';
const at = (minutes: number) => Date.parse(START) + minutes * 60_000;

describe('service screen', () => {
  it('lets restart only a server started by the app while no run is executing', () => {
    expect(restartBlock({ launchedByApp: true, runs: [{ id: 'r1', issueKey: 'TEAM-1', status: 'waiting_owner' }] })).toBeNull();
    expect(restartBlock({ launchedByApp: true, runs: [{ id: 'r1', issueKey: 'TEAM-1', status: 'running' }, { id: 'r2', issueKey: 'TEAM-2', status: 'running' }] })).toBe(
      'Выполняется прогонов: 2 (TEAM-1, TEAM-2). Перезапуск прервал бы их шаги',
    );
    expect(restartBlock({ launchedByApp: false, runs: [] })).toContain('запущен не приложением Task Pilot');
  });

  it('says a restart is needed only when files read at start changed after it', () => {
    expect(restartNeed({ changed: ['apps/server/src/app.ts', 'profiles/contours/core.yaml'] })).toEqual({
      needed: true,
      text: 'Нужен перезапуск: после запуска изменились файлы, которые сервер читает только при запуске (2)',
    });
    expect(restartNeed({ changed: [] }).needed).toBe(false);
  });

  it('writes the uptime in minutes, hours and days', () => {
    expect(uptimeText(START, at(0.5))).toBe('меньше минуты');
    expect(uptimeText(START, at(12))).toBe('12 мин');
    expect(uptimeText(START, at(185))).toBe('3 ч 5 мин');
    expect(uptimeText(START, at(120))).toBe('2 ч');
    expect(uptimeText(START, at(52 * 60))).toBe('2 д 4 ч');
  });

  it('sees the new server by its start time', () => {
    expect(restarted(START, undefined)).toBe(false);
    expect(restarted(START, { startedAt: START })).toBe(false);
    expect(restarted(START, { startedAt: '2026-09-28T10:05:00.000Z' })).toBe(true);
  });

  it('hides accepted docs until asked', () => {
    const doc = (path: string, accepted: boolean): ServiceDocDto => ({ path, title: path, kind: 'acceptance', modified: START, questions: false, accepted });
    const docs = [doc('a/acceptance.md', false), doc('b/acceptance.md', true)];
    expect(docsShown(docs, false).map((d) => d.path)).toEqual(['a/acceptance.md']);
    expect(docsShown(docs, true)).toHaveLength(2);
  });

  it('reads the two-letter git status code: index first, working folder second', () => {
    expect(dirtyText('??')).toBe('новый, не в git');
    expect(dirtyText(' M')).toBe('изменен');
    expect(dirtyText('M ')).toBe('изменен, в индексе');
    expect(dirtyText('AM')).toBe('добавлен в индексе и изменен после этого');
    expect(dirtyText(' D')).toBe('удален');
    expect(dirtyText('UU')).toBe('конфликт слияния');
  });
});
