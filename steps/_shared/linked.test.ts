import { describe, expect, it } from 'vitest';
import type { LinkedRun, StepStatus } from '../../packages/step-kit/src/index.ts';
import { linkedText as textOf, pendingDeploys as pendingOf } from '../../packages/step-kit/src/index.ts';
import { testLinked } from '../_test/context.ts';
import { DEPLOY_STEP, linkedPr } from './linked.ts';

// Связанный прогон ждут по шагу деплоя, как его ждет тест на стенде.
const pendingDeploys = (linked: LinkedRun[]) => pendingOf(linked, DEPLOY_STEP);
const linkedText = (l: LinkedRun) => textOf(l, DEPLOY_STEP);

const deploy = (status: StepStatus, selected = true) => [{ id: 'deploy.stand', selected, status }];
const DEPLOYED = { stand: 'core-stable', build: 'BUILDS-OA-12', tag: '1.0.12-3' };

describe('linked runs', () => {
  it('wait for a linked run whose deploy is selected until it deploys the newest build of its branch', () => {
    const waits = (steps: ReturnType<typeof deploy> | [], context: Record<string, unknown> = {}) => pendingDeploys([testLinked({ steps, context })]).length === 1;
    expect(waits(deploy('pending'))).toBe(true);
    expect(waits(deploy('running'))).toBe(true);
    expect(waits(deploy('failed'))).toBe(true);
    expect(waits(deploy('succeeded'), { build: { key: 'BUILDS-OA-12' }, deployedBuild: DEPLOYED })).toBe(false);
    expect(waits(deploy('already'), { build: { key: 'BUILDS-OA-12' }, deployedBuild: DEPLOYED })).toBe(false);
    // Новая сборка после деплоя, например после доработки: ждем, пока прогон выкатит и ее.
    expect(waits(deploy('succeeded'), { build: { key: 'BUILDS-OA-13' }, deployedBuild: DEPLOYED })).toBe(true);
  });

  it('do not wait for a linked run without a deploy, with it switched off, skipped or simulated', () => {
    expect(pendingDeploys([testLinked({ steps: [] }), testLinked({ steps: deploy('pending', false) }), testLinked({ steps: deploy('skipped') }), testLinked({ steps: deploy('simulated') })])).toEqual([]);
  });

  it('tell what a linked run has deployed or what its deploy waits for', () => {
    expect(linkedText(testLinked({ steps: deploy('succeeded'), context: { build: { key: 'BUILDS-OA-12' }, deployedBuild: DEPLOYED } }))).toBe('adapter: сборка BUILDS-OA-12 с образом 1.0.12-3 выкачена на core-stable');
    expect(linkedText(testLinked({ steps: deploy('succeeded'), context: { build: { key: 'BUILDS-OA-13' }, deployedBuild: DEPLOYED } }))).toBe('adapter: на core-stable старая сборка BUILDS-OA-12, ждет деплоя BUILDS-OA-13');
    expect(linkedText(testLinked({ steps: deploy('pending') }))).toBe('adapter: деплой еще не прошел');
    expect(linkedText(testLinked({ steps: deploy('pending', false) }))).toBe('adapter: деплой в прогоне выключен');
    expect(linkedText(testLinked({ steps: [] }))).toBe('adapter: шага деплоя в прогоне нет');
  });

  it('find the pull request of a linked run in the Bitbucket of its own repository', () => {
    expect(linkedPr(testLinked({ context: { pr: { id: 12 } } }))).toEqual({ scm: { contour: 'core', project: 'TEAM', repo: 'adapter' }, id: 12 });
    expect(linkedPr(testLinked())).toBeNull();
    expect(linkedPr(testLinked({ context: { pr: { id: 12 } }, bitbucket: false }))).toBeNull();
  });
});
