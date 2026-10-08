import { describe, expect, it } from 'vitest';
import type { EventDto } from '@task-pilot/api-types';
import { FEED_FILTERS, findTarget, hasDetails, historyBehind, matchesFeed, mergeFeed, numberedLines, toolOf } from './feed.ts';

const ev = (id: number, type: string, message: string, data: unknown = null, stepId: string | null = 'code.implement'): EventDto => ({ id, runId: 'r1', stepId, ts: '2026-09-23T10:00:00.000Z', type, message, data });

const EDIT = ev(1, 'agent.tool', 'Edit: src/A.java', { tool: 'Edit', session: 's', toolUseId: 't1' });
const OLD_WRITE = ev(2, 'agent.tool', 'Write: src/B.java');
const BASH = ev(3, 'agent.tool', 'Bash: mvn -o test', { tool: 'Bash', session: 's', toolUseId: 't2' });
const APPROVAL = ev(4, 'approval.requested', 'Коммит, пуш и PR', { approvalId: 'a1' });
const QUESTION = ev(5, 'question.asked', 'Агент спрашивает: какой стенд?', { questionId: 'q1' });
const FAILED = ev(6, 'step.status', 'Сборка ветки: упал. Сборка упала', { status: 'failed', error: 'Сборка упала' }, 'ci.wait');
const DENIED = ev(7, 'agent.denied', 'Агент "план": отказано в 1 вызовах', { denials: ['Bash(curl x)'] });
const DONE = ev(8, 'step.status', 'Ветка: готово', { status: 'succeeded' }, 'git.prepare');
const ASK = ev(12, 'ask.answered', 'Ответ на вопрос: шаг ждет сборку', { askId: 'k1', costUsd: 0.1 }, null);

describe('target of the feed window', () => {
  const logOf = (id: number, stepId: string | null, second: number): EventDto => ({
    id,
    runId: 'r',
    stepId,
    ts: `2026-09-25T06:00:${String(second).padStart(2, '0')}.000Z`,
    type: 'step.log',
    message: null,
    data: null,
  });
  const events = [logOf(1, 'deploy.stand', 1), logOf(2, 'qa.stand', 5), logOf(3, 'deploy.stand', 9), logOf(4, 'deploy.stand', 20)];

  it('finds an event by id or the first event of the step from the start of a time segment', () => {
    expect(findTarget(events, { eventId: 2 })?.id).toBe(2);
    expect(findTarget(events, { stepId: 'deploy.stand', at: '2026-09-25T06:00:05.000Z' })?.id).toBe(3);
    expect(findTarget(events, { stepId: 'deploy.stand', at: '2026-09-25T06:00:01.000Z' })?.id).toBe(1);
  });

  it('finds nothing yet when the event is not among the loaded ones, so older history is loaded', () => {
    expect(findTarget(events, { eventId: 99 })).toBeUndefined();
    expect(findTarget(events, { stepId: 'qa.stand', at: '2026-09-25T06:00:06.000Z' })).toBeUndefined();
  });
});

describe('feed of a run', () => {
  it('tells the tool of an agent call from its data and, for old events, from the message', () => {
    expect([EDIT, OLD_WRITE, BASH, APPROVAL].map(toolOf)).toEqual(['Edit', 'Write', 'Bash', null]);
  });

  it('filters file changes, agent actions, approvals, questions and failures and searches the text', () => {
    const all = [EDIT, OLD_WRITE, BASH, APPROVAL, QUESTION, FAILED, DENIED, DONE];
    const ids = (filter: (typeof FEED_FILTERS)[number]['id'], q = '') => all.filter((e) => matchesFeed(e, filter, q)).map((e) => e.id);
    expect(ids('all')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ids('file')).toEqual([1, 2]);
    expect(ids('agent')).toEqual([1, 2, 3]);
    expect(ids('approval')).toEqual([4]);
    expect(ids('question')).toEqual([5]);
    expect(ids('problem')).toEqual([6, 7]);
    expect(matchesFeed(ev(9, 'backup.failed', 'Резервная копия базы не сделана: нет места', null, null), 'problem')).toBe(true);
    expect(matchesFeed(ev(10, 'budget.exceeded', 'Лимит расхода агентов на день исчерпан'), 'problem')).toBe(true);
    expect(matchesFeed(ev(11, 'budget.warning', 'Расход агентов за день больше 80% лимита'), 'problem')).toBe(false);
    expect(ids('all', 'MVN')).toEqual([3]);
    expect(ids('all', 'ci.wait')).toEqual([6]);
    // Вопросы владельца о прогоне идут вместе с вопросами агента.
    expect(matchesFeed(ASK, 'question')).toBe(true);
  });

  it('opens details only where there is something to show', () => {
    expect([EDIT, OLD_WRITE, BASH, APPROVAL, QUESTION, FAILED, DENIED, DONE].map(hasDetails)).toEqual([true, false, true, true, true, false, true, false]);
    // Вопрос о прогоне и ответ целиком - в карточке вопросов.
    expect(hasDetails(ASK)).toBe(false);
  });

  it('merges pages of history with the live stream once and in order', () => {
    expect(mergeFeed([BASH, APPROVAL], [EDIT, BASH], [QUESTION]).map((e) => e.id)).toEqual([1, 3, 4, 5]);
  });

  it('tells that the history fell behind the live stream only when the stream is entirely newer than its first page', () => {
    const ids = (...list: number[]) => list.map((id) => ({ id }));
    expect(historyBehind(undefined, ids(5, 6))).toBe(false);
    expect(historyBehind(ids(3, 4, 5), ids(5, 6))).toBe(false);
    expect(historyBehind(ids(3, 4), ids(5, 6))).toBe(true);
    expect(historyBehind([], ids(5))).toBe(true);
    expect(historyBehind(ids(3, 4), [])).toBe(false);
    expect(historyBehind([], [])).toBe(false);
  });

  it('numbers the lines of a diff in the old and the new file', () => {
    expect(numberedLines({ oldStart: 10, newStart: 10, lines: [' class A {', '-  int x;', '+  int x = 1;', '+  int y;', ' }', '\\ No newline at end of file'] })).toEqual([
      { kind: ' ', old: 10, new: 10, text: 'class A {' },
      { kind: '-', old: 11, new: null, text: '  int x;' },
      { kind: '+', old: null, new: 11, text: '  int x = 1;' },
      { kind: '+', old: null, new: 12, text: '  int y;' },
      { kind: ' ', old: 12, new: 13, text: '}' },
      { kind: ' ', old: null, new: null, text: '\\ No newline at end of file' },
    ]);
  });
});
