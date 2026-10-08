import { describe, expect, it } from 'vitest';
import { acView, analysisAhead } from './ac.ts';

const PLAN = { file: '/repo/.claude/TEAM-2586/plan.md', hash: 'h', summary: 's', questions: [], ac: ['Лимит по номеру', 'Межсессионность'] };

describe('acceptance criteria on the task page', () => {
  it('shows the criteria of the task description even when the plan has its own', () => {
    expect(acView({ ac: ['Капча', 'SMS'], plan: PLAN }, false)).toEqual({ label: '2', items: ['Капча', 'SMS'], planFile: null });
  });

  it('shows the criteria approved with the plan and where they are when the description has none', () => {
    expect(acView({ ac: null, plan: PLAN }, false)).toEqual({ label: '2, из плана: в описании задачи их нет', items: PLAN.ac, planFile: PLAN.file });
  });

  it('says who will fix the criteria while the analysis is still ahead', () => {
    expect(acView({ ac: null }, true)).toEqual({ label: 'в описании не найдены, их зафиксирует шаг "Анализ и план"', items: [], planFile: null });
    expect(acView({ ac: null, plan: { ...PLAN, ac: undefined } }, false)).toEqual({ label: 'в описании не найдены', items: [], planFile: null });
  });

  it('keeps the skip_ac label and shows no block for a run without a Jira task', () => {
    expect(acView({ ac: [], plan: PLAN }, true)).toEqual({ label: 'нет, метка skip_ac', items: [], planFile: null });
    expect(acView({ stepRequest: { description: 'Новый шаг' } }, false)).toBeNull();
  });

  it('counts the analysis as ahead only while it is selected and has not passed', () => {
    const step = (status: Parameters<typeof analysisAhead>[0][number]['status'], selected = true) => [{ stepId: 'task.analyze', selected, status }];
    expect(analysisAhead(step('pending'))).toBe(true);
    expect(analysisAhead(step('waiting_owner'))).toBe(true);
    expect(analysisAhead(step('failed'))).toBe(true);
    expect(analysisAhead(step('succeeded'))).toBe(false);
    expect(analysisAhead(step('skipped'))).toBe(false);
    expect(analysisAhead(step('pending', false))).toBe(false);
    expect(analysisAhead([{ stepId: 'code.implement', selected: true, status: 'pending' }])).toBe(false);
  });
});
