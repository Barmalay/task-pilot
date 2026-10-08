import type { StepTrigger } from '@task-pilot/step-kit';
import { describe, expect, it } from 'vitest';
import type { CatalogDto, RunViewDto } from '@task-pilot/api-types';
import { issueReworkStep } from './rework.ts';

const ON_CHANGE: StepTrigger = { event: 'issue.changed', auto: false };
const ON_REVIEW: StepTrigger = { event: 'pr.review', auto: true };

function view(presetId: string, steps: [string, StepTrigger | null][]): Pick<RunViewDto, 'run' | 'steps'> {
  return { run: { presetId } as RunViewDto['run'], steps: steps.map(([stepId, trigger]) => ({ stepId, trigger }) as RunViewDto['steps'][number]) };
}

function catalog(rework: string[], triggers: Record<string, StepTrigger>): Pick<CatalogDto, 'steps' | 'presets'> {
  const ids = [...new Set([...rework, ...Object.keys(triggers)])];
  return {
    steps: ids.map((id) => ({ id, trigger: triggers[id] ?? null }) as CatalogDto['steps'][number]),
    presets: [{ id: 'rework', title: 'Доработка', hint: 'пресет', steps: rework, off: [], inputs: ['issue', 'ac'], params: {} }],
  };
}

describe('the step that reworks the task after it changed in Jira', () => {
  it('is the step of the run with the issue.changed trigger when the run is on the rework preset', () => {
    expect(issueReworkStep(view('rework', [['git.prepare', null], ['task.rework', ON_CHANGE], ['pr.address-review', ON_REVIEW]]), undefined)).toBe('task.rework');
  });

  it('is the step of the rework preset in the catalog when the run is on another preset and switches to it', () => {
    const c = catalog(['task.rework', 'git.prepare'], { 'task.rework': ON_CHANGE, 'pr.address-review': ON_REVIEW });
    expect(issueReworkStep(view('full', [['pr.address-review', ON_REVIEW]]), c)).toBe('task.rework');
  });

  it('is missing when neither the run nor the rework preset has such a step or the catalog is not loaded yet', () => {
    expect(issueReworkStep(view('rework', [['pr.address-review', ON_REVIEW]]), undefined)).toBeNull();
    expect(issueReworkStep(view('full', []), catalog(['git.prepare'], { 'pr.address-review': ON_REVIEW }))).toBeNull();
    expect(issueReworkStep(view('full', [['task.rework', ON_CHANGE]]), undefined)).toBeNull();
  });
});
