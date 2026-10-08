import { describe, expect, it } from 'vitest';
import { NO_MOVE } from '../../packages/step-kit/src/index.ts';
import { TEST_JIRA, testContext, testRepo } from '../_test/context.ts';
import { moveOf, moveOffText, transitionIds, transitionText } from './board.ts';

const context = (milestones: Record<string, string | null>, params: Record<string, unknown> = {}) =>
  testContext({ issueKey: 'TEAM-1', repo: testRepo('/r', '/wt'), ports: {}, jira: { ...TEST_JIRA, milestones }, params });

describe('moving a task along the board', () => {
  it('walks to the status of the milestone of the step, and to the status of the setting when it is chosen', () => {
    expect(moveOf(context({ review: 'Ready to Review' }), 'In Progress', 'review')).toMatchObject({ target: 'Ready to Review', off: false, byBoard: false, plan: { kind: 'transitions' } });
    expect(moveOf(context({ review: 'Ready to Review' }, { moveTo: 'To Testing' }), 'In Progress', 'review').target).toBe('To Testing');
  });

  it('leaves the task where it is when the setting says so or the board has an empty milestone for the step', () => {
    expect(moveOf(context({ review: 'Ready to Review' }, { moveTo: NO_MOVE }), 'In Progress', 'review')).toEqual({ target: null, plan: { kind: 'done', status: 'In Progress' }, off: true, byBoard: false });
    expect(moveOf(context({ review: null }), 'In Progress', 'review')).toEqual({ target: null, plan: { kind: 'done', status: 'In Progress' }, off: true, byBoard: true });
    expect(moveOffText('In Progress', true)).toBe('Jira: задача остается в статусе In Progress, на этой доске шаг задачу не двигает');
    expect(moveOffText('In Progress')).toBe('Jira: задача остается в статусе In Progress, перевод по доске выключен в настройках шага');
  });

  it('refuses a board without the milestone of the step, saying what to set', () => {
    expect(moveOf(context({}), 'In Progress', 'testing').plan).toEqual({ kind: 'blocked', reason: 'В профиле доски (jira.yaml) нет вехи testing: задайте ее статус или null, если шаг на этой доске задачу не двигает' });
  });

  it('names a transition by the profile of the board when it can, and by the status it leads to otherwise', () => {
    expect(transitionText({ from: 'Open', to: 'In Progress', name: 'Start Progress' })).toBe('Open → In Progress, переход "Start Progress"');
    expect(transitionText({ from: 'Open', to: 'In Progress' }, ': ')).toBe('Open → In Progress');
    expect(transitionIds([{ id: '4', to: 'In Progress' }, { to: 'Review' }])).toEqual(['4', '→ Review']);
  });
});
