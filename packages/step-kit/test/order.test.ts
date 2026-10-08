import { describe, expect, it } from 'vitest';
import { stepManifestSchema, type StepManifest } from '../src/manifest.ts';
import { presetOrderIssues, TASK_INPUTS } from '../src/order.ts';

const step = (id: string, title: string, requires: string[], provides: string[]): StepManifest =>
  stepManifestSchema.parse({ id, title, hint: title, phase: 'code', kind: 'code', requires, provides });

const STEPS = new Map(
  [
    step('git.prepare', 'Ветка', ['issue'], ['branch', 'worktree']),
    step('code.implement', 'Реализация', ['issue', 'worktree'], ['changes']),
    step('code.publish', 'Коммит', ['issue', 'worktree', 'branch'], ['commitSha', 'pr']),
    step('ci.wait', 'Сборка', ['issue'], ['build']),
    step('deploy.stand', 'Деплой', ['build'], ['deployedBuild']),
    step('pilot.new-step', 'Новый шаг', ['stepRequest'], ['newStep']),
  ].map((m) => [m.id, m]),
);
const of = (id: string) => STEPS.get(id);
const preset = (steps: string[], off: string[] = [], inputs: string[] = [...TASK_INPUTS]) => ({ steps, off, inputs });

describe('order of the steps of a preset', () => {
  it('has nothing to say about a preset whose steps come after their providers', () => {
    expect(presetOrderIssues(preset(['git.prepare', 'code.implement', 'code.publish', 'ci.wait', 'deploy.stand']), of)).toEqual([]);
  });

  it('names a step that comes before the step that provides its key', () => {
    expect(presetOrderIssues(preset(['code.implement', 'git.prepare']), of)).toEqual([
      { level: 'error', stepId: 'code.implement', key: 'worktree', message: 'шаг "Реализация" требует worktree, который дает шаг "Ветка", стоящий позже' },
    ]);
  });

  it('names a key no step of the preset provides', () => {
    expect(presetOrderIssues(preset(['deploy.stand']), of)).toEqual([
      { level: 'error', stepId: 'deploy.stand', key: 'build', message: 'ключ build для шага "Деплой" не дает ни один шаг пресета' },
    ]);
  });

  it('warns when the provider is switched off by default and the step itself is not, and keeps quiet when both are off', () => {
    expect(presetOrderIssues(preset(['ci.wait', 'deploy.stand'], ['ci.wait']), of)).toEqual([
      { level: 'warning', stepId: 'deploy.stand', key: 'build', message: 'build для шага "Деплой" дает шаг "Сборка", выключенный по умолчанию' },
    ]);
    expect(presetOrderIssues(preset(['ci.wait', 'deploy.stand'], ['ci.wait', 'deploy.stand']), of)).toEqual([]);
  });

  it('takes the keys the run has from the start from the inputs of the preset', () => {
    expect(presetOrderIssues(preset(['pilot.new-step']), of).map((i) => i.key)).toEqual(['stepRequest']);
    expect(presetOrderIssues(preset(['pilot.new-step'], [], ['stepRequest']), of)).toEqual([]);
    // Задачи у такого прогона нет: шагу, которому она нужна, ее никто не дает.
    expect(presetOrderIssues(preset(['git.prepare'], [], ['stepRequest']), of).map((i) => [i.level, i.key])).toEqual([['error', 'issue']]);
  });

  it('skips steps outside the catalog: unknown steps are another check', () => {
    expect(presetOrderIssues(preset(['nope.step', 'git.prepare']), of)).toEqual([]);
  });
});
