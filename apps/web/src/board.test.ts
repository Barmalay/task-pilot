import { describe, expect, it } from 'vitest';
import { boardColumns, dropTargets, matchesRun, RUN_FILTERS } from './board.ts';

const ORDER = ['Open', 'In Progress', 'Ready to Review', 'To Testing', 'Closed'];

describe('board columns', () => {
  it('shows only statuses with tasks, in the order of the board', () => {
    expect(boardColumns(ORDER, ['Ready to Review', 'Open', 'Open'], [])).toEqual(['Open', 'Ready to Review']);
  });

  it('puts statuses unknown to the board after the known ones in the order they appear', () => {
    expect(boardColumns(ORDER, ['Waiting', 'Open', 'In Review'], [])).toEqual(['Open', 'Waiting', 'In Review']);
  });

  it('adds empty columns the dragged task can move to, including a status unknown to the board', () => {
    expect(boardColumns(ORDER, ['Ready to Review'], ['In Progress', 'In Review'])).toEqual(['In Progress', 'Ready to Review', 'In Review']);
  });
});

describe('drop targets of a dragged task', () => {
  it('groups the transitions by the status they lead to', () => {
    const targets = dropTargets(
      [
        { id: '991', name: 'Хочу починить', to: 'In Progress' },
        { id: '1091', name: 'Можно тестировать', to: 'To Testing' },
        { id: '1092', name: 'Срочно тестировать', to: 'To Testing' },
      ],
      'Ready to Review',
    );
    expect([...targets.keys()]).toEqual(['In Progress', 'To Testing']);
    expect(targets.get('To Testing')?.map((t) => t.id)).toEqual(['1091', '1092']);
  });

  it('ignores a transition with an unknown status and a transition into the same status', () => {
    const targets = dropTargets(
      [
        { id: '5', name: 'Непонятный', to: null },
        { id: '6', name: 'Остаться', to: 'Open' },
      ],
      'Open',
    );
    expect(targets.size).toBe(0);
  });
});

describe('filter of the board by run', () => {
  it('shows running and waiting runs as going, paused and failed as started before and completed as done', () => {
    expect(matchesRun('active', 'running')).toBe(true);
    expect(matchesRun('active', 'waiting_owner')).toBe(true);
    // Прогон, который ждет сборку или мерж, идет: его ведет наблюдатель, а не владелец.
    expect(matchesRun('active', 'waiting')).toBe(true);
    expect(matchesRun('started', 'waiting')).toBe(false);
    expect(matchesRun('active', 'paused')).toBe(false);
    expect(matchesRun('started', 'paused')).toBe(true);
    expect(matchesRun('started', 'failed')).toBe(true);
    expect(matchesRun('started', 'completed')).toBe(false);
    expect(matchesRun('done', 'completed')).toBe(true);
    expect(matchesRun('done', 'running')).toBe(false);
  });

  it('shows a task without a run or with a run that was never started only without the filter', () => {
    for (const f of ['active', 'started', 'done'] as const) {
      expect(matchesRun(f, null)).toBe(false);
      expect(matchesRun(f, 'idle')).toBe(false);
    }
    expect(matchesRun('all', null)).toBe(true);
    expect(matchesRun('all', 'idle')).toBe(true);
    expect(RUN_FILTERS.map((f) => f.label)).toEqual(['Все', 'Идет', 'Запускался', 'Выполнен']);
  });
});
