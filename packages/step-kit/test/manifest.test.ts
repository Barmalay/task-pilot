import { describe, expect, it } from 'vitest';
import { formatZodError, plannedStepSchema, presetSchema, stepManifestSchema } from '../src/manifest.ts';

const valid = { id: 'jira.start', title: 'В работу', hint: 'Переводит задачу в In Progress', phase: 'task', kind: 'code' };

describe('stepManifestSchema', () => {
  it('fills defaults for optional fields', () => {
    const m = stepManifestSchema.parse(valid);
    expect(m).toMatchObject({ requires: [], provides: [], gate: 'none', sideEffects: true, interactive: false, params: {} });
  });

  it('rejects ids without an area prefix', () => {
    const r = stepManifestSchema.safeParse({ ...valid, id: 'start' });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodError(r.error)).toContain('id');
  });

  it('rejects unknown fields so typos in step.yaml are visible', () => {
    expect(stepManifestSchema.safeParse({ ...valid, gates: 'publish' }).success).toBe(false);
  });

  it('rejects an unknown gate mode', () => {
    expect(stepManifestSchema.safeParse({ ...valid, gate: 'always' }).success).toBe(false);
  });

  it('refreshes nothing, names no loop, has no trigger and goes in the chain unless the manifest says so', () => {
    const m = stepManifestSchema.parse({ ...valid, loop: { restart: ['code.verify'] } });
    expect(m).toMatchObject({ refresh: [], loop: { restart: ['code.verify'], max: 3 }, background: false });
    expect(m.loop?.title).toBeUndefined();
    expect(m.trigger).toBeUndefined();
    expect(stepManifestSchema.parse({ ...valid, background: true }).background).toBe(true);
    expect(stepManifestSchema.safeParse({ ...valid, background: 'yes' }).success).toBe(false);
  });

  it('reads what a step refreshes, the title of its loop and its trigger, which the owner starts unless auto is set', () => {
    const m = stepManifestSchema.parse({ ...valid, refresh: ['stands', 'artifacts'], loop: { restart: ['code.verify'], title: 'по ревью' }, trigger: { event: 'pr.review' } });
    expect(m).toMatchObject({ refresh: ['stands', 'artifacts'], loop: { title: 'по ревью' }, trigger: { event: 'pr.review', auto: false } });
    expect(stepManifestSchema.parse({ ...valid, trigger: { event: 'issue.changed', auto: true } }).trigger).toEqual({ event: 'issue.changed', auto: true });
  });

  it('rejects a trigger on an unknown event, a trigger with a foreign field and an unknown screen to refresh', () => {
    expect(stepManifestSchema.safeParse({ ...valid, trigger: { event: 'комментарии в PR' } }).success).toBe(false);
    expect(stepManifestSchema.safeParse({ ...valid, trigger: 'pr.review' }).success).toBe(false);
    expect(stepManifestSchema.safeParse({ ...valid, trigger: { event: 'pr.review', when: 'always' } }).success).toBe(false);
    expect(stepManifestSchema.safeParse({ ...valid, refresh: ['board'] }).success).toBe(false);
    expect(stepManifestSchema.safeParse({ ...valid, loop: { restart: ['code.verify'], title: '' } }).success).toBe(false);
  });
});

describe('plannedStepSchema', () => {
  it('requires the stage number of a planned step', () => {
    expect(plannedStepSchema.safeParse({ ...valid, id: 'code.implement', kind: 'agent' }).success).toBe(false);
    expect(plannedStepSchema.safeParse({ ...valid, id: 'code.implement', kind: 'agent', stage: 2 }).success).toBe(true);
  });

  it('leaves the trigger to the manifest of the implemented step', () => {
    expect(plannedStepSchema.safeParse({ ...valid, id: 'qa.fix', kind: 'agent', stage: 4, trigger: 'непройденные AC' }).success).toBe(false);
  });
});

describe('presetSchema', () => {
  it('accepts a preset with steps switched off by default', () => {
    const p = presetSchema.parse({ id: 'full', title: 'Полный цикл', hint: 'Обычная задача', steps: ['demo.source', 'ci.fix'], off: ['ci.fix'] });
    expect(p.off).toEqual(['ci.fix']);
  });

  it('rejects an empty preset', () => {
    expect(presetSchema.safeParse({ id: 'empty', title: 'Пусто', hint: 'Нет шагов', steps: [] }).success).toBe(false);
  });

  it('starts a run with the task and its AC unless the preset names its own inputs', () => {
    expect(presetSchema.parse({ id: 'full', title: 'Полный цикл', hint: 'Задача', steps: ['demo.source'] }).inputs).toEqual(['issue', 'ac']);
    expect(presetSchema.parse({ id: 'new-step', title: 'Новый шаг', hint: 'Мастер', steps: ['pilot.new-step'], inputs: ['stepRequest'] }).inputs).toEqual(['stepRequest']);
  });
});
