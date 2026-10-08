import { describe, expect, it } from 'vitest';
import { journalChips, journalRows } from './journal.ts';

const at = (m: number) => `2026-09-23T10:${String(m).padStart(2, '0')}:00.000Z`;

describe('journal of a run on the screen', () => {
  it('puts failures, owner corrections, loop rounds and denials in one list, newest first, without answers to the agent', () => {
    const rows = journalRows({
      corrections: [
        { stepId: 'code.publish', step: 'Коммит', at: at(5), decision: 'rework', title: 'Коммит, пуш и PR', comment: 'Заголовок о доработке', eventId: 41 },
        { stepId: 'jira.start', step: 'Взять в работу', at: at(1), decision: 'rejected', title: 'Взять в работу', comment: null },
        { stepId: 'qa.fix', step: 'Доработка по тесту', at: at(10), decision: 'retry', title: 'AC 3 кодом не исправить', comment: 'Окружение поправил' },
      ],
      questions: [{ stepId: 'qa.stand', step: 'Тест на стенде', at: at(2), question: 'Какой стенд?', answer: 'stable' }],
      failures: [{ stepId: 'ci.wait', step: 'Сборка ветки', at: at(9), error: 'Сборка упала' }],
      denials: [{ stepId: 'qa.fix', step: 'Доработка по тесту', at: at(7), tools: ['Bash(curl x)', 'WebFetch'] }],
      loops: [{ stepId: 'qa.fix', step: 'Доработка по тесту', at: at(8), round: 1, max: 3 }],
    });
    expect(rows.map((r) => [r.kind, r.step, r.text])).toEqual([
      ['retry', 'Доработка по тесту', 'Окружение поправил (после ошибки: AC 3 кодом не исправить)'],
      ['failure', 'Сборка ветки', 'Сборка упала'],
      ['loop', 'Доработка по тесту', 'круг 1 из 3'],
      ['denial', 'Доработка по тесту', 'Bash(curl x), WebFetch'],
      ['rework', 'Коммит', 'Коммит, пуш и PR: Заголовок о доработке'],
      ['rejected', 'Взять в работу', 'Взять в работу'],
    ]);
    // Запись с событием ведет к нему в ленте, без события - только к шагу.
    expect(rows.find((r) => r.kind === 'rework')?.eventId).toBe(41);
    expect(rows.find((r) => r.kind === 'rejected')).not.toHaveProperty('eventId');
  });

  it('shows only the counters that are not zero in the history', () => {
    expect(journalChips({ failures: 2, reworks: 0, rejects: 1, loops: 3, denials: 0 })).toEqual([
      { label: 'падения: 2', tone: 'red' },
      { label: 'отклонено: 1', tone: 'amber' },
      { label: 'круги петель: 3', tone: 'violet' },
    ]);
    expect(journalChips({ failures: 0, reworks: 0, rejects: 0, loops: 0, denials: 0 })).toEqual([]);
  });
});
