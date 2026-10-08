import { describe, expect, it } from 'vitest';
import { addStep, draftChanged, draftOf, draftOrderIssues, draftProblems, emptyDraft, moveStep, presetOf, setStepParam } from './presets.ts';

const FINISH = { id: 'finish', title: 'Завершение', hint: 'После ревью', steps: ['git.prepare', 'code.verify', 'task.finish'], off: ['code.verify'], inputs: ['issue', 'ac'], params: {} };

describe('preset editor', () => {
  it('turns a preset into a draft with switches and back without losing the order', () => {
    const d = draftOf(FINISH);
    expect(d.steps).toEqual([
      { id: 'git.prepare', on: true },
      { id: 'code.verify', on: false },
      { id: 'task.finish', on: true },
    ]);
    expect(presetOf(d)).toEqual(FINISH);
    expect(draftChanged(d, FINISH)).toBe(false);
    expect(draftChanged({ ...d, title: 'Финиш' }, FINISH)).toBe(true);
  });

  it('moves steps inside the list only', () => {
    const d = draftOf(FINISH);
    expect(moveStep(d, 2, -1).steps.map((s) => s.id)).toEqual(['git.prepare', 'task.finish', 'code.verify']);
    expect(moveStep(d, 0, -1)).toBe(d);
    expect(moveStep(d, 2, 1)).toBe(d);
  });

  it('adds a step once, and a step that is not implemented yet switched off', () => {
    const d = addStep(addStep(draftOf(FINISH), 'wiki.update', true), 'next.step', false);
    expect(d.steps.slice(-2)).toEqual([
      { id: 'wiki.update', on: true },
      { id: 'next.step', on: false },
    ]);
    expect(addStep(d, 'wiki.update', true)).toBe(d);
    expect(presetOf(d).off).toEqual(['code.verify', 'next.step']);
  });

  it('names what blocks saving a new preset', () => {
    expect(draftProblems(emptyDraft(), true, [])).toEqual(['id: латиница в нижнем регистре, цифры и дефис, с буквы', 'нужно название', 'нужно описание', 'нужен хотя бы один шаг']);
    expect(draftProblems({ ...draftOf(FINISH), id: 'finish' }, true, ['finish'])).toEqual(['пресет finish уже есть']);
    expect(draftProblems(draftOf(FINISH), false, ['finish'])).toEqual([]);
  });

  it('checks the order of the steps of a draft as the server does: a step before its provider and a provider switched off', () => {
    const steps = [
      { id: 'git.prepare', title: 'Ветка', requires: ['issue'], provides: ['worktree'] },
      { id: 'code.verify', title: 'Проверка', requires: ['worktree'], provides: ['testReport'] },
    ];
    const d = draftOf({ ...FINISH, steps: ['code.verify', 'git.prepare'], off: [] });
    expect(draftOrderIssues(d, steps).map((i) => [i.level, i.message])).toEqual([['error', 'шаг "Проверка" требует worktree, который дает шаг "Ветка", стоящий позже']]);
    expect(draftOrderIssues(moveStep(d, 1, -1), steps)).toEqual([]);
    expect(draftOrderIssues({ ...moveStep(d, 1, -1), steps: [{ id: 'git.prepare', on: false }, { id: 'code.verify', on: true }] }, steps).map((i) => i.level)).toEqual(['warning']);
  });

  it('keeps the default settings of steps through the draft and changes one setting of one step', () => {
    const quiet = { ...FINISH, params: { 'task.finish': { moveTo: 'none' } } };
    const d = draftOf(quiet);
    expect(d.steps[2]).toEqual({ id: 'task.finish', on: true, params: { moveTo: 'none' } });
    expect(presetOf(d)).toEqual(quiet);
    expect(draftChanged(d, quiet)).toBe(false);
    const moved = setStepParam(d, 'task.finish', 'moveTo', 'In Testing');
    expect(presetOf(moved).params).toEqual({ 'task.finish': { moveTo: 'In Testing' } });
    expect(draftChanged(moved, quiet)).toBe(true);
    // Сброшенная настройка убирается из пресета: шаг снова идет с умолчанием манифеста.
    expect(presetOf(setStepParam(d, 'task.finish', 'moveTo', null)).params).toEqual({});
  });

  it('keeps the inputs of a preset through the draft', () => {
    const wizard = { id: 'new-step', title: 'Новый шаг', hint: 'Мастер', steps: ['pilot.new-step'], off: [], inputs: ['stepRequest'], params: {} };
    expect(presetOf(draftOf(wizard))).toEqual(wizard);
    expect(emptyDraft().inputs).toEqual(['issue', 'ac']);
  });
});
