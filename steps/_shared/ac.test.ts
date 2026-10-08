import { describe, expect, it } from 'vitest';
import type { StepContext } from '../../packages/step-kit/src/index.ts';
import { acOf, acPlanTask, acText, planAcOf, planAcPreview } from './ac.ts';

const ctx = (values: Record<string, unknown>): Pick<StepContext, 'get'> => ({ get: <T>(key: string) => values[key] as T | undefined });
const PLAN = { file: '/repo/.claude/TEAM-1/plan.md', hash: 'h', summary: 's', questions: [], ac: ['Бан на 20-й попытке', 'Остаток в ответе'] };
const PLAN_TEXT = '# План\n\n## Критерии приемки\n\n1. Бан на 20-й попытке\n2. Остаток в ответе\n\n## Тесты\n\nКраевые случаи.';

describe('acOf', () => {
  it('takes the criteria from the task description first, even when the plan has its own', () => {
    expect(acOf(ctx({ ac: ['Из Jira'], plan: PLAN }))).toEqual({ items: ['Из Jira'], planFile: null });
  });

  it('takes the criteria approved with the plan when the description has none', () => {
    expect(acOf(ctx({ ac: null, plan: PLAN }))).toEqual({ items: PLAN.ac, planFile: PLAN.file });
  });

  it('keeps the skip_ac label over the criteria of the plan', () => {
    expect(acOf(ctx({ ac: [], plan: PLAN }))).toEqual({ items: [], planFile: null });
  });

  it('has no criteria when neither the description nor the plan has them', () => {
    expect(acOf(ctx({ ac: null, plan: { ...PLAN, ac: undefined } }))).toEqual({ items: null, planFile: null });
    expect(acOf(ctx({}))).toEqual({ items: null, planFile: null });
  });

  it('uses the criteria of a freshly read task instead of the context', () => {
    expect(acOf(ctx({ ac: ['Старый'], plan: PLAN }), ['Новый'])).toEqual({ items: ['Новый'], planFile: null });
    expect(acOf(ctx({ ac: ['Старый'], plan: PLAN }), null)).toEqual({ items: PLAN.ac, planFile: PLAN.file });
  });
});

describe('acText', () => {
  it('numbers the criteria of the description', () => {
    expect(acText({ items: ['Капча', 'SMS'], planFile: null })).toBe('1. Капча\n2. SMS');
  });

  it('tells the agent that the criteria come from the plan and where its section is', () => {
    expect(acText({ items: PLAN.ac, planFile: PLAN.file })).toBe(
      'в описании задачи их нет, список утвержден с планом (раздел "Критерии приемки" в /repo/.claude/TEAM-1/plan.md):\n1. Бан на 20-й попытке\n2. Остаток в ответе',
    );
  });

  it('says when there are no criteria at all or the task has the skip_ac label', () => {
    expect(acText({ items: null, planFile: null })).toBe('в описании не найдены');
    expect(acText({ items: [], planFile: null })).toBe('нет, у задачи метка skip_ac');
  });
});

describe('planAcOf', () => {
  it('reads the criteria section of the plan when the description has none', () => {
    expect(planAcOf(PLAN_TEXT, null)).toEqual(PLAN.ac);
    expect(planAcOf(PLAN_TEXT, undefined)).toEqual(PLAN.ac);
  });

  it('ignores the plan section when the description has criteria or the task has the skip_ac label', () => {
    expect(planAcOf(PLAN_TEXT, ['Из Jira'])).toBeUndefined();
    expect(planAcOf(PLAN_TEXT, [])).toBeUndefined();
  });

  it('finds nothing in a plan without the criteria section', () => {
    expect(planAcOf('# План\n\nКритериев приемки в Jira нет, поэтому работа сверяется с доками.\n\n1. Шаг один', null)).toBeUndefined();
  });
});

describe('acPlanTask', () => {
  it('asks to fix the criteria in the plan, taking them from the task docs if they are there', () => {
    const task = acPlanTask(null, '/wt/.task-pilot/docs');
    expect(task).toContain('раздел "## Критерии приемки"');
    expect(task).toContain('в доках задачи (/wt/.task-pilot/docs)');
    expect(task).toContain('task-description.md');
    expect(task).toContain('сохрани номера пунктов');
  });

  it('asks to drop the plan section once the description got criteria, and asks nothing otherwise', () => {
    expect(acPlanTask(['Из Jira'], '/docs', true)).toContain('раздел "Критерии приемки" в плане больше не нужен');
    expect(acPlanTask(['Из Jira'], '/docs')).toBe('');
    expect(acPlanTask([], '/docs', true)).toBe('');
  });
});

describe('planAcPreview', () => {
  it('tells on the approval how many criteria the plan fixes', () => {
    expect(planAcPreview(PLAN_TEXT, null)).toEqual({
      actions: ['Критерии приемки из раздела плана (2): по ним пойдут реализация, тест на стенде и итоги в Jira, в описании задачи их нет'],
      warnings: [],
    });
  });

  it('warns when neither the description nor the plan has criteria', () => {
    expect(planAcPreview('# План', null).warnings).toEqual([
      'В описании задачи нет критериев приемки, а в плане нет раздела "Критерии приемки": следующим шагам не с чем сверять работу. "Переделать" с замечанием попросит агента их составить',
    ]);
  });

  it('says nothing about criteria that come from the description or a task with the skip_ac label', () => {
    expect(planAcPreview(PLAN_TEXT, ['Из Jira'])).toEqual({ actions: [], warnings: [] });
    expect(planAcPreview('# План', [])).toEqual({ actions: [], warnings: [] });
  });
});
