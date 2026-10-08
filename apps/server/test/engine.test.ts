import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_MOVE, StepWaiting, TASK_INPUTS, timed, z, type AgentRequest, type Build, type Preset, type PrReview, type StepContext, type StepManifest, type StepModule, type StepTrigger, type WaitEvent } from '@task-pilot/step-kit';
import { Engine, type AgentFactory } from '../src/engine/engine.ts';
import { FakeCatalog, issue, makeEngine, manifest, PROFILES } from './helpers.ts';

/** Зеленая сборка ветки по контракту step-kit: учебные шаги кладут ее в контекст как настоящий ci.wait. */
const build = (key: string): Build => ({ key, number: 1, plan: 'PLAN', branch: 'feature/TEAM-1', revision: 'abc123', tag: null, url: `https://bamboo.example.org/browse/${key}` });

function counter(outputs: Record<string, unknown> = {}) {
  const calls = { run: 0, simulate: 0 };
  const module: StepModule = {
    async run() {
      calls.run += 1;
      return outputs;
    },
  };
  return { module, calls };
}

describe('Engine with linked runs', () => {
  it('gives a step the newest run of the task in every other repository, with its steps and context', async () => {
    const seen: { runId: string; repo: string; deploy: unknown; build: unknown }[][] = [];
    const cat = new FakeCatalog()
      .add(manifest('a.one', { provides: ['build'] }), {
        async run(c) {
          seen.push(c.linked().map((l) => ({ runId: l.runId, repo: l.repo.id, deploy: l.steps.find((s) => s.id === 'a.one')?.status, build: l.get('build') })));
          return { build: build(`B-${c.repo.id}`) };
        },
      })
      .addPreset(['a.one']);
    const { engine } = makeEngine(cat);
    const old = engine.createRun({ issueKey: 'TEAM-1', repoId: 'api-auth' });
    await engine.start(old.id);
    const other = engine.createRun({ issueKey: 'TEAM-1', repoId: 'api-auth' });
    const main = engine.createRun({ issueKey: 'TEAM-1', repoId: 'demo' });
    engine.createRun({ issueKey: 'TEAM-2', repoId: 'api-auth' });
    await engine.start(main.id);
    // Из двух прогонов задачи в api-auth связан самый новый, еще не запущенный; прогоны другой задачи не связаны.
    expect(seen.at(-1)).toEqual([{ runId: other.id, repo: 'api-auth', deploy: 'pending', build: undefined }]);
    await engine.start(other.id);
    expect(seen.at(-1)).toEqual([{ runId: main.id, repo: 'demo', deploy: 'succeeded', build: build('B-demo') }]);
  });
});

describe('Engine', () => {
  it('runs selected steps in order and shares outputs through the context', async () => {
    const order: string[] = [];
    const cat = new FakeCatalog()
      .add(manifest('a.one', { provides: ['x'] }), {
        async run() {
          order.push('one');
          return { x: 1 };
        },
      })
      .add(manifest('a.two', { requires: ['x'] }), {
        async run(c) {
          order.push(`two:${c.get('x')}`);
          return { y: 2 };
        },
      })
      .addPreset(['a.one', 'a.two']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'team-1' });
    await engine.start(run.id);
    expect(order).toEqual(['one', 'two:1']);
    expect(store.getContext(run.id)).toEqual({ x: 1, y: 2 });
    expect(engine.view(run.id).run).toMatchObject({ status: 'completed', issueKey: 'TEAM-1', standId: 'stable' });
  });

  it('takes Stable of the contour of the repository as the default stand and moves the run to it with another repository', () => {
    const cat = new FakeCatalog().add(manifest('jira.start'), counter().module).addPreset(['jira.start']);
    const coreStands = [
      { id: 'core-testing-a-0', title: 'Testing-A-0', contour: 'core', namespace: 'testing-a-0', bambooEnv: 'Testing-A-0', bambooEnvIds: { 'api-auth': 11 }, logs: 'kibana', deployable: true, notes: [] },
      { id: 'core-stable', title: 'Stable', contour: 'core', namespace: 'stable', bambooEnv: 'Stable', bambooEnvIds: { 'api-auth': 12 }, logs: 'kibana', deployable: true, notes: [] },
    ];
    const { engine, store } = makeEngine(cat, [], undefined, { profiles: { ...PROFILES, stands: [...PROFILES.stands, ...coreStands] } });
    expect(engine.createRun({ issueKey: 'TEAM-1' }).standId).toBe('stable');
    expect(engine.createRun({ issueKey: 'TEAM-2', repoId: 'api-auth' }).standId).toBe('core-stable');
    const run = engine.createRun({ issueKey: 'TEAM-3' });
    engine.setOptions(run.id, { repoId: 'api-auth' });
    expect(store.getRun(run.id)?.standId).toBe('core-stable');
    // Стенд, выбранный вместе с репозиторием, остается как выбран.
    engine.setOptions(run.id, { repoId: 'demo', standId: null });
    expect(store.getRun(run.id)?.standId).toBeNull();
  });

  it('gives steps the Jira login of the active account of the integrations screen', async () => {
    const seen: string[] = [];
    const cat = new FakeCatalog()
      .add(manifest('jira.start'), {
        async run(c) {
          seen.push(c.jira.me);
          return {};
        },
      })
      .addPreset(['jira.start']);
    const { engine, integrations } = makeEngine(cat, [], undefined, { integrations: { whoami: async () => ({ login: 'tech', name: 'Технический' }) } });
    await engine.start(engine.createRun({ issueKey: 'TEAM-1' }).id);
    await integrations.addToken('jira', { token: 'tech-jira-token-1' });
    await engine.start(engine.createRun({ issueKey: 'TEAM-2' }).id);
    expect(seen).toEqual(['owner', 'tech']);
  });

  it('marks a step as already done and keeps its outputs when done() confirms it', async () => {
    const { module, calls } = counter();
    module.done = async () => ({ note: 'ветка готова', outputs: { branch: 'feature/TEAM-1' } });
    const cat = new FakeCatalog().add(manifest('git.prepare'), module).addPreset(['git.prepare']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(calls.run).toBe(0);
    expect(store.getStep(run.id, 'git.prepare')).toMatchObject({ status: 'already', note: 'ветка готова' });
    expect(store.getContext(run.id)).toEqual({ branch: 'feature/TEAM-1' });
  });

  it('blocks a step whose data is missing and names the step that provides it', async () => {
    const cat = new FakeCatalog()
      .add(manifest('demo.source', { title: 'Задача', provides: ['issue'] }), counter().module)
      .add(manifest('jira.start', { requires: ['issue'] }), counter().module)
      .addPreset(['jira.start']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 'jira.start')).toMatchObject({ status: 'blocked' });
    expect(store.getStep(run.id, 'jira.start')?.note).toContain('дает шаг "Задача"');
    expect(engine.view(run.id).run.status).toBe('paused');
  });

  it('does not run steps switched off in the preset', async () => {
    const one = counter();
    const cat = new FakeCatalog().add(manifest('a.one'), one.module).add(manifest('a.two'), counter().module).addPreset(['a.one', 'a.two'], ['a.one']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(one.calls.run).toBe(0);
    expect(store.getStep(run.id, 'a.one')).toMatchObject({ selected: false, status: 'pending' });
  });

  it('refuses to select a planned step that is not implemented yet', () => {
    const cat = new FakeCatalog().add(manifest('a.one'), counter().module).add(manifest('code.implement')).addPreset(['a.one', 'code.implement']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    expect(store.getStep(run.id, 'code.implement')?.selected).toBe(false);
    expect(() => engine.setSelected(run.id, 'code.implement', true)).toThrow('не реализован');
  });

  it('waits for approval before a gated step and runs it exactly once after approval', async () => {
    const { module, calls } = counter({ status: 'In Progress' });
    module.preview = async () => ({ title: 'Взять в работу', actions: ['Open → In Progress'], payload: { transitions: ['4'] } });
    const cat = new FakeCatalog().add(manifest('jira.start', { gate: 'before' }), module).addPreset(['jira.start']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const waiting = engine.view(run.id);
    expect(waiting.run.status).toBe('waiting_owner');
    expect(waiting.approval?.preview.title).toBe('Взять в работу');
    expect(calls.run).toBe(0);

    await engine.decide(waiting.approval!.id, 'approve');
    expect(calls.run).toBe(1);
    expect(engine.view(run.id).run.status).toBe('completed');
    expect(store.findApproval(run.id, 'jira.start', 'consumed')).toBeDefined();
    await engine.start(run.id);
    expect(calls.run).toBe(1);
  });

  it('keeps the approval when only the notes of the preview change and burns it when an approved text changes', async () => {
    let live = 0;
    let file = 'id: rba';
    const { module, calls } = counter();
    // Справка (живые цифры) меняется при каждом превью, подтверждаемый файл - только когда его меняют.
    module.preview = async () => ({ title: 'Дашборд', actions: ['Сохранить'], payload: { id: 'rba' }, texts: [{ id: 'file', label: 'файл', text: file, publish: false }], notes: [{ id: 'live', label: 'цифры', text: `за час ${++live}` }] });
    const cat = new FakeCatalog().add(manifest('monitor.dashboard', { gate: 'before' }), module).addPreset(['monitor.dashboard']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    await engine.decide(engine.view(run.id).approval!.id, 'approve');
    expect(calls.run).toBe(1);
    expect(store.findApproval(run.id, 'monitor.dashboard', 'consumed')).toBeDefined();

    const second = engine.createRun({ issueKey: 'TEAM-2' });
    await engine.start(second.id);
    const shown = engine.view(second.id).approval!;
    file = 'id: rba2';
    await engine.decide(shown.id, 'approve');
    expect(calls.run).toBe(1);
    expect(store.findApproval(second.id, 'monitor.dashboard', 'stale')).toBeDefined();
  });

  it('burns the approval when the content changes after the owner clicked', async () => {
    let branch = 'feature/TEAM-1';
    const { module, calls } = counter();
    module.preview = async () => ({ title: 'Пуш', actions: [branch], payload: { branch } });
    const cat = new FakeCatalog().add(manifest('git.push', { gate: 'publish' }), module).addPreset(['git.push']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const first = engine.view(run.id).approval!;
    branch = 'feature/TEAM-1-other';
    await engine.decide(first.id, 'approve');
    expect(calls.run).toBe(0);
    expect(store.getApproval(first.id)?.status).toBe('stale');
    const second = engine.view(run.id).approval!;
    expect(second.id).not.toBe(first.id);
    expect(second.preview.actions).toEqual(['feature/TEAM-1-other']);
  });

  it('runs a before-gated step without asking when the step says approval is not needed', async () => {
    const { module, calls } = counter();
    module.preview = async () => ({ title: 'Ветка', actions: [], payload: {}, requiresApproval: false });
    const cat = new FakeCatalog().add(manifest('git.prepare', { gate: 'before' }), module).addPreset(['git.prepare']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(calls.run).toBe(1);
  });

  it('always asks before a publish step even when the step says approval is not needed', async () => {
    const { module, calls } = counter();
    module.preview = async () => ({ title: 'Пуш', actions: [], payload: {}, requiresApproval: false });
    const cat = new FakeCatalog().add(manifest('git.push', { gate: 'publish' }), module).addPreset(['git.push']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(calls.run).toBe(0);
    expect(engine.view(run.id).run.status).toBe('waiting_owner');
  });

  it('pauses the run and returns the step to pending with the comment when the owner rejects', async () => {
    const { module, calls } = counter();
    module.preview = async () => ({ title: 'Взять в работу', actions: [], payload: { v: 1 } });
    const cat = new FakeCatalog().add(manifest('jira.start', { gate: 'before' }), module).addPreset(['jira.start']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const a = engine.view(run.id).approval!;
    await engine.decide(a.id, 'reject', 'не сейчас');
    expect(calls.run).toBe(0);
    expect(store.getStep(run.id, 'jira.start')).toMatchObject({ status: 'pending', note: 'Отклонено владельцем: не сейчас' });
    expect(engine.view(run.id)).toMatchObject({ run: { status: 'paused' }, approval: null });
    await engine.start(run.id);
    expect(engine.view(run.id).approval?.id).not.toBe(a.id);
  });

  it('simulates side-effect steps in a dry run and runs read-only steps for real', async () => {
    const read = counter({ issue: issue('TEAM-1') });
    const write = counter();
    write.module.simulate = async () => {
      write.calls.simulate += 1;
      return { status: 'In Progress' };
    };
    const cat = new FakeCatalog()
      .add(manifest('demo.source', { sideEffects: false }), read.module)
      .add(manifest('jira.start', { gate: 'before' }), write.module)
      .addPreset(['demo.source', 'jira.start']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1', dryRun: true });
    await engine.start(run.id);
    expect(read.calls.run).toBe(1);
    expect(write.calls).toEqual({ run: 0, simulate: 1 });
    expect(store.getStep(run.id, 'jira.start')?.status).toBe('simulated');
    expect(store.getContext(run.id)).toMatchObject({ status: 'In Progress' });
    expect(engine.view(run.id).approval).toBeNull();
  });

  it('records a failure with secrets masked and lets the owner retry the step', async () => {
    let attempt = 0;
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        async run() {
          attempt += 1;
          if (attempt === 1) throw new Error('boom token-supersecret-value');
          return { ok: true };
        },
      })
      .addPreset(['a.one']);
    const { engine, store } = makeEngine(cat, ['token-supersecret-value']);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 'a.one')).toMatchObject({ status: 'failed', error: 'boom ***' });
    expect(engine.view(run.id).run.status).toBe('failed');
    expect(JSON.stringify(store.listEvents(run.id))).not.toContain('supersecret');
    await engine.retry(run.id, 'a.one');
    expect(store.getStep(run.id, 'a.one')?.status).toBe('succeeded');
    expect(engine.view(run.id).run.status).toBe('completed');
  });

  it('does not run later steps past a failed one until the owner retries or skips it', async () => {
    const later = counter();
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        async run() {
          throw new Error('упал');
        },
      })
      .add(manifest('a.two'), later.module)
      .addPreset(['a.one', 'a.two']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    await engine.start(run.id);
    expect(later.calls.run).toBe(0);
    expect(store.getRun(run.id)?.status).toBe('failed');
    // Пропуск упавшего шага сам продолжает прогон: отдельный запуск не нужен.
    await engine.skip(run.id, 'a.one');
    expect(later.calls.run).toBe(1);
    expect(store.getStep(run.id, 'a.one')).toMatchObject({ status: 'skipped', note: 'Пропущен владельцем' });
    expect(store.getRun(run.id)?.status).toBe('completed');
  });

  it('skips only the step the run stopped on and changes the plan only for steps that have not started', async () => {
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        async run() {
          throw new Error('упал');
        },
      })
      .add(manifest('a.two'), counter().module)
      .addPreset(['a.one', 'a.two']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    expect(() => engine.skip(run.id, 'a.two')).toThrow('Пропустить можно шаг, на котором прогон остановился');
    expect(store.getStep(run.id, 'a.two')?.status).toBe('pending');
    await engine.start(run.id);
    expect(() => engine.setSelected(run.id, 'a.one', false)).toThrow('Шаг уже начинался');
    expect(store.getStep(run.id, 'a.one')).toMatchObject({ status: 'failed', selected: true });
    engine.setSelected(run.id, 'a.two', false);
    expect(store.getStep(run.id, 'a.two')?.selected).toBe(false);
  });

  it('does not start a run whose repository the issue did not suggest until the owner picks one', async () => {
    const work = counter();
    const cat = new FakeCatalog().add(manifest('a.one'), work.module).addPreset(['a.one']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    store.setContext(run.id, 'repoChoice', { repoId: run.repoId, reason: 'не определен по задаче: у задачи нет компонентов и метки repo:', candidates: [], unsure: true }, null);
    expect(() => engine.start(run.id)).toThrow('Репозиторий не определился по задаче');
    expect(work.calls.run).toBe(0);
    engine.setOptions(run.id, { repoId: run.repoId });
    expect(store.getContext(run.id).repoChoice).toEqual({ repoId: run.repoId, reason: 'владельцем', candidates: [] });
    await engine.start(run.id);
    expect(work.calls.run).toBe(1);
  });

  it('re-checks a blocked step on the next start after the owner enabled the step that provides the data', async () => {
    const cat = new FakeCatalog()
      .add(manifest('demo.source', { provides: ['issue'] }), {
        async run() {
          return { issue: issue('TEAM-1') };
        },
      })
      .add(manifest('jira.start', { requires: ['issue'] }), counter().module)
      .addPreset(['demo.source', 'jira.start'], ['demo.source']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 'jira.start')?.status).toBe('blocked');
    engine.setSelected(run.id, 'demo.source', true);
    await engine.start(run.id);
    expect(store.getStep(run.id, 'jira.start')?.status).toBe('succeeded');
  });

  it('burns a pending approval when the owner changes the run options', async () => {
    const { module } = counter();
    module.preview = async () => ({ title: 'Взять в работу', actions: [], payload: {} });
    const cat = new FakeCatalog().add(manifest('jira.start', { gate: 'before' }), module).addPreset(['jira.start']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const a = engine.view(run.id).approval!;
    engine.setOptions(run.id, { dryRun: true });
    expect(store.getApproval(a.id)?.status).toBe('stale');
    expect(store.getStep(run.id, 'jira.start')?.status).toBe('pending');
  });

  it('picks the default repository when none is given', () => {
    const cat = new FakeCatalog().add(manifest('a.one'), counter().module).addPreset(['a.one']);
    const { engine } = makeEngine(cat);
    expect(engine.createRun({ issueKey: 'TEAM-1' }).repoId).toBe('demo');
  });

  it('changes the repository only until the first step did something', async () => {
    const cat = new FakeCatalog().add(manifest('a.one'), counter().module).addPreset(['a.one']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    engine.setOptions(run.id, { repoId: 'api-auth' });
    expect(store.getRun(run.id)?.repoId).toBe('api-auth');
    await engine.start(run.id);
    expect(() => engine.setOptions(run.id, { repoId: 'demo' })).toThrow('до первого выполненного шага');
    expect(() => engine.setOptions(run.id, { repoId: 'nope' })).toThrow('не найден');
  });

  it('gives the step the contour of the repository', async () => {
    let seen: string | undefined;
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        async run(c) {
          seen = `${c.contour?.id}:${c.contour?.connected}`;
          return {};
        },
      })
      .addPreset(['a.one']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1', repoId: 'api-auth' });
    await engine.start(run.id);
    expect(seen).toBe('core:false');
  });

  it('marks steps interrupted by a server restart as failed and pauses their runs', () => {
    const cat = new FakeCatalog().add(manifest('a.one'), counter().module).addPreset(['a.one']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    store.updateStep(run.id, 'a.one', { status: 'running' });
    store.updateRun(run.id, { status: 'running' });
    engine.recover();
    expect(store.getStep(run.id, 'a.one')).toMatchObject({ status: 'failed', error: 'Прервано перезапуском сервера' });
    expect(store.getRun(run.id)?.status).toBe('paused');
  });

  it('rejects an invalid issue key and an unknown preset', () => {
    const cat = new FakeCatalog().add(manifest('a.one'), counter().module).addPreset(['a.one']);
    const { engine } = makeEngine(cat);
    expect(() => engine.createRun({ issueKey: 'not a key' })).toThrow('Некорректный ключ');
    expect(() => engine.createRun({ issueKey: 'TEAM-1', presetId: 'nope' })).toThrow('не найден');
  });
});

describe('Engine: preset of a run', () => {
  const steps = (ids: string[]) => ids.reduce((cat, id) => cat.add(manifest(id), counter({ [id.replace('.', '_')]: true }).module), new FakeCatalog());

  it('changes the preset in the same run instead of creating a new one', () => {
    const cat = steps(['a.one', 'b.two', 'c.three']).addPreset(['a.one', 'b.two']).addPreset(['b.two', 'c.three'], [], 'other');
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    engine.setOptions(run.id, { presetId: 'other' });
    expect(store.listRuns(10).map((r) => r.id)).toEqual([run.id]);
    expect(store.getRun(run.id)).toMatchObject({ presetId: 'other', status: 'idle' });
    expect(store.getSteps(run.id).map((s) => [s.stepId, s.selected])).toEqual([
      ['b.two', true],
      ['c.three', true],
    ]);
  });

  it('keeps executed steps as history, drops untouched ones and marks steps by the chosen preset', async () => {
    const cat = steps(['a.one', 'b.two', 'c.three', 'd.four']).addPreset(['a.one', 'b.two', 'c.three']).addPreset(['c.three', 'd.four'], ['d.four'], 'other');
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    engine.setSelected(run.id, 'b.two', false);
    engine.setSelected(run.id, 'c.three', false);
    await engine.start(run.id);
    expect(store.getRun(run.id)?.status).toBe('completed');
    engine.setOptions(run.id, { presetId: 'other' });
    expect(store.getSteps(run.id).map((s) => [s.stepId, s.status, s.selected])).toEqual([
      ['a.one', 'succeeded', false],
      ['c.three', 'pending', true],
      ['d.four', 'pending', false],
    ]);
    // Результат выполненного шага остается в контексте для следующих шагов.
    expect(store.getContext(run.id)).toMatchObject({ a_one: true });
    expect(store.getRun(run.id)?.status).toBe('paused');
    await engine.start(run.id);
    expect(store.getStep(run.id, 'c.three')?.status).toBe('succeeded');
    expect(store.getRun(run.id)?.status).toBe('completed');
  });

  it('marks the run completed when the chosen preset has nothing left to do', async () => {
    const cat = steps(['a.one', 'b.two']).addPreset(['a.one', 'b.two']).addPreset(['a.one'], [], 'short');
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    engine.setSelected(run.id, 'b.two', false);
    await engine.start(run.id);
    engine.setOptions(run.id, { presetId: 'short' });
    expect(store.getSteps(run.id).map((s) => [s.stepId, s.status])).toEqual([['a.one', 'succeeded']]);
    expect(store.getRun(run.id)?.status).toBe('completed');
  });

  it('burns a pending approval and drops the waiting step that the chosen preset does not have', async () => {
    const { module } = counter();
    module.preview = async () => ({ title: 'Взять в работу', actions: [], payload: {} });
    const cat = new FakeCatalog().add(manifest('jira.start', { gate: 'before' }), module).add(manifest('b.two'), counter().module).addPreset(['jira.start']).addPreset(['b.two'], [], 'other');
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const approval = engine.view(run.id).approval!;
    engine.setOptions(run.id, { presetId: 'other' });
    expect(store.getApproval(approval.id)?.status).toBe('stale');
    expect(store.getSteps(run.id).map((s) => s.stepId)).toEqual(['b.two']);
    expect(engine.view(run.id).approval).toBeNull();
    expect(store.getRun(run.id)?.status).toBe('idle');
  });

  it('does not let a failed step outside the chosen preset stop the run', async () => {
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        async run() {
          throw new Error('упал');
        },
      })
      .add(manifest('b.two'), counter().module)
      .addPreset(['a.one'])
      .addPreset(['b.two'], [], 'other');
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getRun(run.id)?.status).toBe('failed');
    engine.setOptions(run.id, { presetId: 'other' });
    expect(store.getSteps(run.id).map((s) => [s.stepId, s.status, s.selected])).toEqual([
      ['a.one', 'failed', false],
      ['b.two', 'pending', true],
    ]);
    expect(store.getRun(run.id)?.status).toBe('paused');
    await engine.start(run.id);
    expect(store.getRun(run.id)?.status).toBe('completed');
  });

  it('refuses a preset that is not in the catalog', () => {
    const cat = steps(['a.one']).addPreset(['a.one']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    expect(() => engine.setOptions(run.id, { presetId: 'nope' })).toThrow('Пресет nope не найден');
    expect(store.getRun(run.id)?.presetId).toBe('full');
  });
});

describe('Engine: deleting a run', () => {
  it('removes the run with its steps, context, feed, approvals, agent sessions and files and points to the next run of the task', async () => {
    const { module } = counter({ started: true });
    module.preview = async () => ({ title: 'Взять в работу', actions: [], payload: {} });
    const cat = new FakeCatalog().add(manifest('jira.start', { gate: 'before' }), module).addPreset(['jira.start']);
    const { engine, store, dataDir } = makeEngine(cat);
    const older = engine.createRun({ issueKey: 'TEAM-1' });
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const approval = engine.view(run.id).approval!;
    store.setContext(run.id, 'note', 'значение', 'jira.start');
    const session = store.createAgentSession({ sessionId: 's-1', runId: run.id, stepId: 'jira.start', label: 'план', model: null });
    mkdirSync(join(dataDir, 'runs', run.id), { recursive: true });
    writeFileSync(join(dataDir, 'runs', run.id, 'commit-message.txt'), 'TEAM-1 x');
    mkdirSync(join(dataDir, 'agent', session.id), { recursive: true });
    writeFileSync(join(dataDir, 'agent', session.id, 'stream.jsonl'), '{}');

    expect(engine.deleteRun(run.id)).toEqual({ next: older.id });
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.getSteps(run.id)).toEqual([]);
    expect(store.getContext(run.id)).toEqual({});
    expect(store.listEvents(run.id, 0, 100)).toEqual([]);
    expect(store.getApproval(approval.id)).toBeUndefined();
    expect(store.agentSessionIds(run.id)).toEqual([]);
    expect(existsSync(join(dataDir, 'runs', run.id))).toBe(false);
    expect(existsSync(join(dataDir, 'agent', session.id))).toBe(false);
    // Другой прогон задачи не тронут.
    expect(store.getSteps(older.id).map((s) => s.stepId)).toEqual(['jira.start']);
    expect(engine.deleteRun(older.id)).toEqual({ next: null });
  });

  it('does not delete a run that is executing', async () => {
    let release!: () => void;
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        run: () =>
          new Promise((resolve) => {
            release = () => resolve({});
          }),
      })
      .addPreset(['a.one']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    const done = engine.start(run.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(() => engine.deleteRun(run.id)).toThrow('Прогон выполняется');
    release();
    await done;
    expect(store.getRun(run.id)).toBeDefined();
  });

  it('answers not found for a run that does not exist', () => {
    const { engine } = makeEngine(new FakeCatalog().addPreset([]));
    expect(() => engine.deleteRun('nope')).toThrow('Прогон не найден');
  });
});

describe('Engine: loop of rework', () => {
  /**
   * Прогон с петлей: сборка, тест (не проходит, пока не наберется fixesNeeded исправлений), шаг петли, который
   * исправляет, пока тест не прошел, и шаг после петли.
   */
  function loopRun(fixesNeeded: number, max = 3) {
    const runs: string[] = [];
    let fixes = 0;
    const cat = new FakeCatalog()
      .add(manifest('a.build'), {
        async run() {
          runs.push('build');
          return {};
        },
      })
      .add(manifest('b.test', { provides: ['failed'] }), {
        async run() {
          runs.push('test');
          return { failed: fixes >= fixesNeeded ? [] : ['1'] };
        },
      })
      .add(manifest('c.fix', { loop: { restart: ['a.build', 'b.test'], max } }), {
        async done(c) {
          return (c.get<string[]>('failed') ?? []).length ? null : { note: 'Все AC прошли' };
        },
        async run() {
          runs.push('fix');
          fixes += 1;
          return { fixed: fixes };
        },
      })
      .add(manifest('d.after'), {
        async run() {
          runs.push('after');
          return {};
        },
      })
      .addPreset(['a.build', 'b.test', 'c.fix', 'd.after']);
    return { ...makeEngine(cat), runs };
  }

  it('reruns the chain after a fix and goes on once nothing is left to fix', async () => {
    const { engine, store, runs } = loopRun(1);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(runs).toEqual(['build', 'test', 'fix', 'build', 'test', 'after']);
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(store.getStep(run.id, 'c.fix')).toMatchObject({ status: 'already', note: 'Все AC прошли' });
    expect(store.getContext(run.id).loops).toEqual({ 'c.fix': 1 });
    const restart = store.listEvents(run.id).find((e) => e.type === 'loop.restart');
    expect(restart?.message).toBe('c.fix: круг 1 из 3 готов, заново a.build, b.test');
  });

  it('stops the loop after the last allowed round and leaves the decision to the owner', async () => {
    const { engine, store, runs } = loopRun(99, 2);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(runs).toEqual(['build', 'test', 'fix', 'build', 'test', 'fix', 'build', 'test']);
    expect(store.getStep(run.id, 'c.fix')).toMatchObject({ status: 'failed', error: 'Петля исчерпана: кругов 2 из 2, дальше решает владелец' });
    expect(store.getStep(run.id, 'd.after')?.status).toBe('pending');
    expect(store.getRun(run.id)?.status).toBe('failed');
  });

  it('asks for a new approval of a gated step on every round and drops its draft of the previous round', async () => {
    let fixes = 0;
    const drafts: unknown[] = [];
    const cat = new FakeCatalog()
      .add(manifest('p.publish', { gate: 'publish' }), {
        async prepare(c) {
          drafts.push(c.draft);
          return { round: fixes };
        },
        async preview(c) {
          return { title: 'Пуш', actions: [`пуш круга ${(c.draft as { round: number }).round}`], payload: { round: (c.draft as { round: number }).round } };
        },
        async run() {
          return {};
        },
      })
      .add(manifest('c.fix', { loop: { restart: ['p.publish'], max: 3 } }), {
        async done() {
          return fixes >= 1 ? { note: 'нечего чинить' } : null;
        },
        async run() {
          fixes += 1;
          return {};
        },
      })
      .addPreset(['p.publish', 'c.fix']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const first = engine.view(run.id).approval!;
    expect(first.preview.actions).toEqual(['пуш круга 0']);
    await engine.decide(first.id, 'approve');
    const second = engine.view(run.id).approval!;
    expect(second.id).not.toBe(first.id);
    expect(second.preview.actions).toEqual(['пуш круга 1']);
    expect(store.getStep(run.id, 'p.publish')?.status).toBe('waiting_owner');
    // Черновик прежнего круга стерт: подготовка второго круга начинала с чистого листа.
    expect(drafts).toEqual([undefined, undefined]);
    await engine.decide(second.id, 'approve');
    expect(store.getRun(run.id)?.status).toBe('completed');
  });
});

describe('Engine: contracts of the context', () => {
  it('fails a step that returned a value not by its contract and writes none of its outputs', async () => {
    const cat = new FakeCatalog()
      .add(manifest('task.analyze', { provides: ['plan', 'status'] }), {
        async run() {
          return { status: 'In Progress', plan: { file: 'plan.md', summary: 'план без хэша', questions: [] } };
        },
      })
      .addPreset(['task.analyze']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 'task.analyze')).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Шаг вернул plan не по контракту: hash: /) });
    expect(store.getRun(run.id)?.status).toBe('failed');
    expect(store.getContext(run.id)).not.toHaveProperty('plan');
    expect(store.getContext(run.id)).not.toHaveProperty('status');
  });

  it('writes a key without a contract as it is with a note in the feed and checks a contract a step declares for its own key', async () => {
    let greeting: unknown = 'Привет';
    const cat = new FakeCatalog()
      .add(manifest('demo.greet', { provides: ['greeting'] }), {
        async run() {
          return { greeting, extra: { any: 1 } };
        },
        contracts: { greeting: z.string() },
      })
      .addPreset(['demo.greet']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 'demo.greet')?.status).toBe('succeeded');
    expect(store.getContext(run.id)).toMatchObject({ greeting: 'Привет', extra: { any: 1 } });
    expect(store.listEvents(run.id).filter((e) => e.type === 'step.log').map((e) => e.message)).toContain('Выход extra без контракта: записан без проверки');
    greeting = 42;
    await engine.retry(run.id, 'demo.greet');
    expect(store.getStep(run.id, 'demo.greet')).toMatchObject({ status: 'failed', error: expect.stringContaining('Шаг вернул greeting не по контракту') });
    expect(store.getContext(run.id).greeting).toBe('Привет');
  });

  it('fails a waiting step whose outputs break the contract instead of pausing it', async () => {
    const cat = new FakeCatalog()
      .add(manifest('t.finish'), {
        async run() {
          throw new StepWaiting('Жду мерж PR #262', { kind: 'pr', scm: { contour: 'cloud', project: 'CLOUD', repo: 'demo' }, pr: 262 }, { prReview: { pr: 262 } });
        },
      })
      .addPreset(['t.finish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 't.finish')).toMatchObject({ status: 'failed', error: expect.stringContaining('Шаг вернул prReview не по контракту') });
    expect(store.getContext(run.id)).not.toHaveProperty('waiting');
    expect(store.getContext(run.id)).not.toHaveProperty('prReview');
  });
});

describe('Engine: signs of the steps from their manifests', () => {
  it('says in the status event of a finished step what the screens reread, and nothing while the step works', async () => {
    let fail = false;
    const cat = new FakeCatalog()
      .add(manifest('t.deploy', { refresh: ['stands'] }), {
        async run() {
          if (fail) throw new Error('деплой упал');
          return {};
        },
      })
      .add(manifest('t.plain'), { run: async () => ({}) })
      .addPreset(['t.deploy', 't.plain']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const statuses = (stepId: string) => store.listEvents(run.id).filter((e) => e.type === 'step.status' && e.stepId === stepId).map((e) => e.data);
    expect(statuses('t.deploy')).toEqual([{ status: 'running' }, { status: 'succeeded', refresh: ['stands'] }]);
    expect(statuses('t.plain')).toEqual([{ status: 'running' }, { status: 'succeeded' }]);
    fail = true;
    await engine.retry(run.id, 't.deploy');
    expect(statuses('t.deploy').slice(-1)).toEqual([{ status: 'failed', error: 'деплой упал', refresh: ['stands'] }]);
  });

  it('gives the view of the run the QA browser, the refresh list, the loop title and the trigger of each step', async () => {
    const cat = new FakeCatalog()
      .add(manifest('t.review', { loop: { restart: ['t.plain'], max: 3, title: 'по ревью' }, trigger: { event: 'pr.review', auto: true } }), { run: async () => ({}) })
      .add(manifest('t.qa', { kind: 'agent', agent: { browser: true }, refresh: ['artifacts'] }), { run: async () => ({}) })
      .add(manifest('t.plain'), { run: async () => ({}) })
      .addPreset(['t.plain', 't.qa', 't.review']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    const signs = engine.view(run.id).steps.map(({ stepId, browser, refresh, loopTitle, trigger }) => ({ stepId, browser, refresh, loopTitle, trigger }));
    expect(signs).toEqual([
      { stepId: 't.plain', browser: false, refresh: [], loopTitle: null, trigger: null },
      { stepId: 't.qa', browser: true, refresh: ['artifacts'], loopTitle: null, trigger: null },
      { stepId: 't.review', browser: false, refresh: [], loopTitle: 'по ревью', trigger: { event: 'pr.review', auto: true } },
    ]);
  });
});

describe('Engine: waiting for an event', () => {
  const SCM = { contour: 'cloud', project: 'CLOUD', repo: 'demo' };

  it('keeps what a step did before it started to wait', async () => {
    const cat = new FakeCatalog()
      .add(manifest('t.finish'), {
        async run() {
          const prReview: PrReview = { pr: 262, replies: [], summary: 'ответы опубликованы', files: [], tests: [], pending: false, base: null, at: '2026-09-25T10:00:00.000Z' };
          throw new StepWaiting('ответов опубликовано: 1. Жду мерж PR #262', { kind: 'pr', scm: SCM, pr: 262 }, { prReview });
        },
      })
      .addPreset(['t.finish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 't.finish')?.status).toBe('waiting');
    expect(store.getContext(run.id)).toMatchObject({ prReview: { pr: 262, pending: false }, waiting: { stepId: 't.finish' } });
  });

  it('puts a step that waits for an event and its run into waiting instead of failing them and runs it again on the next start', async () => {
    let merged = false;
    const cat = new FakeCatalog()
      .add(manifest('t.finish'), {
        async run() {
          if (!merged) throw new StepWaiting('Жду мерж PR #262: одобрил 1 из 2', { kind: 'pr', scm: SCM, pr: 262 });
          return { merged: { pr: 262, at: '2026-09-25T10:00:00.000Z' } };
        },
      })
      .addPreset(['t.finish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getStep(run.id, 't.finish')).toMatchObject({ status: 'waiting', note: 'Жду мерж PR #262: одобрил 1 из 2', error: null });
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(store.getContext(run.id).waiting).toMatchObject({ stepId: 't.finish', event: { kind: 'pr', pr: 262 }, from: 'run' });

    merged = true;
    await engine.start(run.id);
    expect(store.getStep(run.id, 't.finish')?.status).toBe('succeeded');
    expect(store.getContext(run.id).waiting).toBeUndefined();
    expect(store.getRun(run.id)?.status).toBe('completed');
  });
});

describe('Engine: going on after a wait', () => {
  const BUILD: WaitEvent = { kind: 'build', contour: 'cloud', planKey: 'P-1', revision: 'abc', ...timed('2026-09-25T10:00:00.000Z', 45 * 60_000, 'Сборка не закончилась за 45 минут') };

  /** Шаг с подтверждением, чье подтвержденное действие ждет события: как деплой, который ждет окончания в Bamboo. */
  function deployLike(opts: { resume?: boolean } = {}) {
    const calls: string[] = [];
    let done = false;
    const cat = new FakeCatalog()
      .add(manifest('t.deploy', { gate: 'publish' }), {
        async done() {
          calls.push('done');
          return null;
        },
        async preview() {
          calls.push('preview');
          return { title: 'Деплой', actions: ['деплой'], payload: {} };
        },
        async run(c) {
          calls.push(`run ${c.waited?.kind ?? '-'}`);
          throw new StepWaiting('Жду деплой', BUILD);
        },
        ...(opts.resume === false
          ? {}
          : {
              async resume(c: StepContext, event: WaitEvent) {
                calls.push(`resume ${event.kind} ${c.waited?.kind}`);
                if (!done) throw new StepWaiting('Все еще жду деплой', event);
                return { deployed: true };
              },
            }),
      })
      .addPreset(['t.deploy']);
    const deps = makeEngine(cat);
    const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
    return { ...deps, run, calls, finish: () => (done = true) };
  }

  it('goes on with the approved action through resume without done, a new preview or a second approval', async () => {
    const t = deployLike();
    await t.engine.start(t.run.id);
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    expect(t.store.getStep(t.run.id, 't.deploy')?.status).toBe('waiting');
    expect(t.store.getContext(t.run.id).waiting).toMatchObject({ stepId: 't.deploy', from: 'run', event: { kind: 'build' } });
    const startedAt = t.store.getStep(t.run.id, 't.deploy')?.startedAt;
    await t.engine.start(t.run.id);
    expect(t.store.getStep(t.run.id, 't.deploy')).toMatchObject({ status: 'waiting', note: 'Все еще жду деплой' });
    t.finish();
    await t.engine.start(t.run.id);
    expect(t.store.getStep(t.run.id, 't.deploy')).toMatchObject({ status: 'succeeded', startedAt });
    expect(t.store.getContext(t.run.id)).toMatchObject({ deployed: true });
    expect(t.calls).toEqual(['done', 'preview', 'done', 'preview', 'run -', 'resume build build', 'resume build build']);
    expect(t.store.listEvents(t.run.id).filter((e) => e.type === 'approval.requested')).toHaveLength(1);
  });

  it('starts a step without resume over from done after a wait from run, and a repeat of the step starts over too', async () => {
    const t = deployLike({ resume: false });
    await t.engine.start(t.run.id);
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    await t.engine.start(t.run.id);
    // С начала: шаг снова смотрит, сделано ли, и просит подтверждение на то, что покажет.
    expect(t.calls).toEqual(['done', 'preview', 'done', 'preview', 'run -', 'done', 'preview']);
    expect(t.store.getStep(t.run.id, 't.deploy')?.status).toBe('waiting_owner');
    const again = deployLike();
    await again.engine.start(again.run.id);
    await again.engine.decide(again.engine.view(again.run.id).approval!.id, 'approve');
    await again.engine.retry(again.run.id, 't.deploy');
    expect(again.calls.at(-2)).toBe('done');
    expect(again.store.getContext(again.run.id)).not.toHaveProperty('waiting');
  });

  it('starts over a step whose wait came before its approval', async () => {
    let ready = false;
    const calls: string[] = [];
    const cat = new FakeCatalog()
      .add(manifest('t.finish', { gate: 'before' }), {
        async preview() {
          calls.push('preview');
          if (!ready) throw new StepWaiting('Жду мерж PR #262', { kind: 'pr', scm: { contour: 'cloud', project: 'CLOUD', repo: 'demo' }, pr: 262 });
          return { title: 'MERGED', actions: ['переход'], payload: {} };
        },
        async run() {
          return {};
        },
        async resume() {
          throw new Error('до подтверждения продолжать нечего');
        },
      })
      .addPreset(['t.finish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(store.getContext(run.id).waiting).not.toHaveProperty('from');
    ready = true;
    await engine.start(run.id);
    expect(store.getStep(run.id, 't.finish')?.status).toBe('waiting_owner');
    expect(calls).toEqual(['preview', 'preview']);
  });

  it('fails a waiting step with the error of the deadline and leaves a step that no longer waits alone', async () => {
    const t = deployLike();
    await t.engine.start(t.run.id);
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    t.engine.failWaiting(t.run.id, 'other.step', 'чужая ошибка');
    expect(t.store.getStep(t.run.id, 't.deploy')?.status).toBe('waiting');
    t.engine.failWaiting(t.run.id, 't.deploy', 'Деплой не закончился за 40 минут');
    expect(t.store.getStep(t.run.id, 't.deploy')).toMatchObject({ status: 'failed', error: 'Деплой не закончился за 40 минут' });
    expect(t.store.getRun(t.run.id)?.status).toBe('failed');
    expect(t.store.getContext(t.run.id)).not.toHaveProperty('waiting');
    // Шаг уже не ждет: повторный срок ничего не меняет.
    t.engine.failWaiting(t.run.id, 't.deploy', 'еще раз');
    expect(t.store.getStep(t.run.id, 't.deploy')?.error).toBe('Деплой не закончился за 40 минут');
  });

  it('starts a waiting step over after the stand or the dry run changed instead of going on with the old wait', async () => {
    const t = deployLike();
    await t.engine.start(t.run.id);
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    t.engine.setOptions(t.run.id, { presetId: 'full' });
    expect(t.store.getStep(t.run.id, 't.deploy')?.status).toBe('waiting');
    t.engine.setOptions(t.run.id, { standId: null });
    expect(t.store.getStep(t.run.id, 't.deploy')).toMatchObject({ status: 'pending', note: 'Параметры прогона изменились, шаг выполнится заново' });
    expect(t.store.getContext(t.run.id)).not.toHaveProperty('waiting');
    await t.engine.start(t.run.id);
    // С начала и с новым подтверждением: прежнее было для прежнего стенда.
    expect(t.calls.slice(-2)).toEqual(['done', 'preview']);
    expect(t.store.getStep(t.run.id, 't.deploy')?.status).toBe('waiting_owner');
  });

  it('lets the owner skip a waiting step and goes on without it', async () => {
    const t = deployLike();
    await t.engine.start(t.run.id);
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    await t.engine.skip(t.run.id, 't.deploy');
    expect(t.store.getStep(t.run.id, 't.deploy')?.status).toBe('skipped');
    expect(t.store.getRun(t.run.id)?.status).toBe('completed');
    expect(t.store.getContext(t.run.id)).not.toHaveProperty('waiting');
  });

  it('takes a wait kept as blocked and paused as waiting after a restart, and leaves a waiting run as it is', () => {
    const t = deployLike();
    t.store.setContext(t.run.id, 'waiting', { stepId: 't.deploy', event: BUILD, since: '2026-09-25T10:00:00.000Z' }, 't.deploy');
    t.store.updateStep(t.run.id, 't.deploy', { status: 'blocked', note: 'Жду мерж' });
    t.store.updateRun(t.run.id, { status: 'paused' });
    t.engine.recover();
    expect(t.store.getStep(t.run.id, 't.deploy')).toMatchObject({ status: 'waiting', note: 'Жду мерж' });
    expect(t.store.getRun(t.run.id)?.status).toBe('waiting');
    t.engine.recover();
    expect(t.store.getRun(t.run.id)?.status).toBe('waiting');
  });
});

describe('Engine: steps started by events', () => {
  function triggered(trigger: StepTrigger | undefined) {
    const runs: string[] = [];
    const cat = new FakeCatalog()
      .add(manifest('t.answer', { trigger }), {
        async run() {
          runs.push('answer');
          return {};
        },
      })
      .addPreset(['t.answer']);
    const deps = makeEngine(cat);
    const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
    return { ...deps, run, runs };
  }

  it('starts again a step with an auto trigger on its event of its own run, not on another event or another run', async () => {
    const t = triggered({ event: 'pr.review', auto: true });
    await t.engine.start(t.run.id);
    expect(t.runs).toEqual(['answer']);
    t.bus.emitEvent({ runId: t.run.id, type: 'issue.changed', message: 'задача изменилась' });
    t.bus.emitEvent({ runId: 'other-run', type: 'pr.review', message: 'замечания' });
    expect(t.engine.isActive(t.run.id)).toBe(false);
    t.bus.emitEvent({ runId: t.run.id, type: 'pr.review', message: 'замечания' });
    expect(t.engine.isActive(t.run.id)).toBe(true);
    await t.engine.start(t.run.id);
    expect(t.runs).toEqual(['answer', 'answer']);
  });

  it('leaves a step the owner starts and a step without a trigger to their event', async () => {
    for (const trigger of [{ event: 'issue.changed', auto: false } as StepTrigger, undefined]) {
      const t = triggered(trigger);
      await t.engine.start(t.run.id);
      t.bus.emitEvent({ runId: t.run.id, type: 'issue.changed', message: 'задача изменилась' });
      expect(t.engine.isActive(t.run.id), JSON.stringify(trigger)).toBe(false);
      expect(t.runs).toEqual(['answer']);
    }
  });
});

describe('Engine: a loop step that needs no new round', () => {
  it('goes on without restarting the chain when the step says nothing was changed', async () => {
    const runs: string[] = [];
    const cat = new FakeCatalog()
      .add(manifest('a.build'), {
        async run() {
          runs.push('build');
          return {};
        },
      })
      .add(manifest('r.review', { loop: { restart: ['a.build'], max: 3 } }), {
        async run() {
          runs.push('review');
          return { changed: false };
        },
        again: (_c, outputs) => outputs.changed === true,
      })
      .add(manifest('z.after'), {
        async run() {
          runs.push('after');
          return {};
        },
      })
      .addPreset(['a.build', 'r.review', 'z.after']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(runs).toEqual(['build', 'review', 'after']);
    expect(store.getContext(run.id).loops).toBeUndefined();
    expect(store.listEvents(run.id).some((e) => e.type === 'loop.restart')).toBe(false);
  });
});

describe('Engine: background steps', () => {
  /** Обещание, которое тест выполняет сам: так шаг идет, пока тест не отпустит его. */
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Цепочка: код, подтверждение, код в конце; между ними фоновый шаг, который идет, пока тест его не отпустит. */
  function withBackground(over: Partial<StepModule> = {}, bg: Partial<StepManifest> = {}) {
    const gate = deferred();
    const calls: string[] = [];
    const cat = new FakeCatalog()
      .add(manifest('a.first'), { run: async () => (calls.push('first'), {}) })
      .add(manifest('b.wiki', { background: true, ...bg }), {
        async run() {
          calls.push('wiki');
          await gate.promise;
          calls.push('wiki done');
          return {};
        },
        ...over,
      })
      .add(manifest('a.gate', { gate: 'before' }), {
        async preview() {
          return { title: 'Подтвердить шаг цепочки', actions: ['действие'], payload: {} };
        },
        run: async () => (calls.push('gate'), {}),
      })
      .add(manifest('a.last'), { run: async () => (calls.push('last'), {}) })
      .addPreset(['a.first', 'b.wiki', 'a.gate', 'a.last']);
    const deps = makeEngine(cat);
    const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
    const status = (stepId: string) => deps.store.getStep(run.id, stepId)?.status;
    return { ...deps, run, gate, calls, status };
  }

  it('runs a background step while the chain waits for the owner and completes the run once both are done', async () => {
    const t = withBackground();
    await t.engine.start(t.run.id);
    // Цепочка встала на подтверждении, а фоновый шаг, чьи шаги цепочки выше выполнены, идет рядом.
    expect([t.status('a.first'), t.status('b.wiki'), t.status('a.gate')]).toEqual(['succeeded', 'running', 'waiting_owner']);
    expect(t.store.getRun(t.run.id)?.status).toBe('waiting_owner');
    expect(t.engine.isActive(t.run.id)).toBe(true);
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    expect(t.status('a.last')).toBe('succeeded');
    // Цепочка выполнена, но фоновый шаг еще идет: прогон не выполнен.
    expect(t.store.getRun(t.run.id)?.status).toBe('running');
    t.gate.resolve();
    await t.engine.settled(t.run.id);
    expect(t.status('b.wiki')).toBe('succeeded');
    expect(t.store.getRun(t.run.id)?.status).toBe('completed');
    expect(t.calls).toEqual(['first', 'wiki', 'gate', 'last', 'wiki done']);
  });

  it('does not stop the chain on a failed background step, fails the run at the end and completes it after a repeat', async () => {
    const t = withBackground();
    await t.engine.start(t.run.id);
    t.gate.reject(new Error('вики недоступна'));
    await t.engine.settled(t.run.id);
    expect(t.engine.view(t.run.id).steps.find((s) => s.stepId === 'b.wiki')).toMatchObject({ status: 'failed', error: 'вики недоступна' });
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    await t.engine.settled(t.run.id);
    expect(t.status('a.last')).toBe('succeeded');
    expect(t.store.getRun(t.run.id)?.status).toBe('failed');
    const again = withBackground();
    again.gate.resolve();
    // Повтор фонового шага запускает только его: цепочку не трогает.
    await again.engine.start(again.run.id);
    await again.engine.settled(again.run.id);
    await again.engine.retry(again.run.id, 'b.wiki');
    expect(again.status('a.gate')).toBe('waiting_owner');
    expect(again.status('b.wiki')).toBe('succeeded');
  });

  it('keeps two approvals at once and an approval of the background step runs only that step', async () => {
    const t = withBackground(
      {
        async preview() {
          return { title: 'Опубликовать вики', actions: ['страница'], payload: {} };
        },
        run: async () => ({}),
      },
      { gate: 'publish' },
    );
    await t.engine.start(t.run.id);
    await t.engine.settled(t.run.id);
    const view = t.engine.view(t.run.id);
    expect(view.approvals.map((a) => a.stepId).sort()).toEqual(['a.gate', 'b.wiki']);
    expect(view.approval?.id).toBe(view.approvals[0]!.id);
    await t.engine.decide(view.approvals.find((a) => a.stepId === 'b.wiki')!.id, 'approve');
    await t.engine.settled(t.run.id);
    expect(t.status('b.wiki')).toBe('succeeded');
    expect(t.status('a.gate')).toBe('waiting_owner');
    expect(t.engine.view(t.run.id).approvals.map((a) => a.stepId)).toEqual(['a.gate']);
  });

  it('asks the approval of a background step again after the stand changed, as a chain step does', async () => {
    // Черновик, как у вики: шаг начался в prepare и уже ждал подтверждения, когда сменился стенд.
    const t = withBackground(
      {
        prepare: async () => ({ page: 'Калькулятор' }),
        async preview() {
          return { title: 'Опубликовать вики', actions: ['страница'], payload: {} };
        },
        run: async () => ({}),
      },
      { gate: 'publish' },
    );
    await t.engine.start(t.run.id);
    await t.engine.settled(t.run.id);
    const before = t.engine.view(t.run.id).approvals.find((a) => a.stepId === 'b.wiki')!;
    t.engine.setOptions(t.run.id, { standId: null });
    expect([t.status('b.wiki'), t.status('a.gate')]).toEqual(['pending', 'pending']);
    await t.engine.start(t.run.id);
    await t.engine.settled(t.run.id);
    const after = t.engine.view(t.run.id).approvals;
    expect(after.map((a) => a.stepId).sort()).toEqual(['a.gate', 'b.wiki']);
    expect(after.find((a) => a.stepId === 'b.wiki')!.id).not.toBe(before.id);
  });

  it('keeps a rejected background step from starting again by itself', async () => {
    const t = withBackground(
      {
        async preview() {
          return { title: 'Опубликовать вики', actions: ['страница'], payload: {} };
        },
        run: async () => ({}),
      },
      { gate: 'publish' },
    );
    await t.engine.start(t.run.id);
    await t.engine.settled(t.run.id);
    await t.engine.decide(t.engine.view(t.run.id).approvals.find((a) => a.stepId === 'b.wiki')!.id, 'reject', 'не сейчас');
    expect(t.engine.view(t.run.id).steps.find((s) => s.stepId === 'b.wiki')).toMatchObject({ status: 'blocked', note: 'Отклонено владельцем: не сейчас' });
    await t.engine.decide(t.engine.view(t.run.id).approval!.id, 'approve');
    await t.engine.settled(t.run.id);
    expect(t.status('b.wiki')).toBe('blocked');
    expect(t.store.getRun(t.run.id)?.status).toBe('paused');
  });

  it('stops the chain and the background step with one stop', async () => {
    const cat = new FakeCatalog()
      .add(manifest('a.first'), { run: async () => ({}) })
      .add(manifest('b.wiki', { background: true }), {
        async run(c) {
          await new Promise((_resolve, reject) => c.signal.addEventListener('abort', () => reject(new Error('прервано'))));
          return {};
        },
      })
      .add(manifest('a.long'), {
        async run(c) {
          await new Promise((_resolve, reject) => c.signal.addEventListener('abort', () => reject(new Error('прервано'))));
          return {};
        },
      })
      .addPreset(['a.first', 'b.wiki', 'a.long']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    void engine.start(run.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getStep(run.id, 'b.wiki')?.status).toBe('running');
    engine.stop(run.id);
    await engine.settled(run.id);
    expect(store.getStep(run.id, 'a.long')).toMatchObject({ status: 'failed', error: 'Остановлено владельцем' });
    expect(store.getStep(run.id, 'b.wiki')).toMatchObject({ status: 'failed', error: 'Остановлено владельцем' });
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(engine.isActive(run.id)).toBe(false);
  });

  it('simulates a background step in a dry run like any other', async () => {
    const t = withBackground({ simulate: async () => ({}) });
    t.engine.setOptions(t.run.id, { dryRun: true });
    await t.engine.start(t.run.id);
    await t.engine.settled(t.run.id);
    expect(t.status('b.wiki')).toBe('simulated');
    expect(t.calls).not.toContain('wiki');
  });

  it('starts a background step again when a loop restarts it', async () => {
    let rounds = 0;
    const cat = new FakeCatalog()
      .add(manifest('b.wiki', { background: true }), { run: async () => ({}) })
      .add(manifest('a.fix', { loop: { restart: ['b.wiki'], max: 2 } }), {
        async done() {
          return rounds >= 1 ? { note: 'дорабатывать нечего' } : null;
        },
        run: async () => (rounds++, {}),
      })
      .addPreset(['b.wiki', 'a.fix']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    await engine.settled(run.id);
    const starts = store.listEvents(run.id).filter((e) => e.type === 'step.status' && e.stepId === 'b.wiki' && (e.data as { status: string }).status === 'running');
    expect(starts).toHaveLength(2);
    expect(store.getStep(run.id, 'b.wiki')?.status).toBe('succeeded');
    expect(store.getRun(run.id)?.status).toBe('completed');
  });

  it('gives the agent of a background step no writes to the worktree and fails a background step that waits for an event', async () => {
    const seen: AgentRequest[] = [];
    const cat = new FakeCatalog()
      .add(manifest('b.wiki', { background: true }), {
        async run(c) {
          await c.agent.run({ label: 'вики', prompt: 'страница', cwd: '/tmp', tools: [], writeCwd: true });
          return {};
        },
      })
      .add(manifest('b.wait', { background: true }), {
        async run() {
          throw new StepWaiting('Жду сборку', { kind: 'pr', scm: { contour: 'cloud', project: 'CLOUD', repo: 'demo' }, pr: 1 });
        },
      })
      .addPreset(['b.wiki', 'b.wait']);
    const deps = makeEngine(cat);
    const agents: AgentFactory = {
      forStep: () => ({
        run: async (request) => {
          seen.push(request);
          return { sessionId: 's-1', text: '', output: null, costUsd: 0, durationMs: 0, turns: 1, denials: [] };
        },
        lastSession: () => null,
      }),
    };
    const engine = new Engine({ store: deps.store, bus: deps.bus, catalog: cat, profiles: PROFILES, ports: deps.ports, redact: deps.redact, agents, lint: { secrets: [] }, dataDir: deps.dataDir });
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    await engine.settled(run.id);
    expect(seen.map((r) => r.writeCwd)).toEqual([false]);
    expect(deps.store.getStep(run.id, 'b.wait')).toMatchObject({ status: 'failed', error: 'Фоновый шаг не ждет внешних событий: Жду сборку. Сделайте его шагом цепочки' });
    expect(deps.store.getContext(run.id)).not.toHaveProperty('waiting');
  });

  it('gives every background step its own copy of the task docs for the agent and the chain steps a shared one', async () => {
    const copies: Record<string, string> = {};
    const step = (id: string) => ({ run: async (c: StepContext) => ((copies[id] = c.paths.agentDocs), {}) });
    const cat = new FakeCatalog()
      .add(manifest('a.plan'), step('a.plan'))
      .add(manifest('b.wiki', { background: true }), step('b.wiki'))
      .add(manifest('b.dash', { background: true }), step('b.dash'))
      .add(manifest('a.finish'), step('a.finish'))
      .addPreset(['a.plan', 'b.wiki', 'b.dash', 'a.finish']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    await engine.settled(run.id);
    expect(copies['a.finish']).toBe(copies['a.plan']);
    expect(new Set(Object.values(copies)).size).toBe(3);
    expect(copies['b.wiki']).toMatch(/docs-b\.wiki$/);
  });
});


describe('Engine: retry of a failed step with a note to the agent', () => {
  /** Агентный шаг, который падает, пока агент не получил замечание владельца; тест видит все задания агенту. */
  function failingAgentStep(kind: StepManifest['kind'] = 'agent') {
    const prompts: string[] = [];
    const cat = new FakeCatalog()
      .add(manifest('qa.fix', { kind }), {
        async run(c) {
          const r = await c.agent.run({ label: 'доработка', prompt: 'Почини AC по отчету', cwd: '/tmp', tools: [] });
          if (!r.text.includes('замечание')) throw new Error('AC 3 кодом не исправить: причина в окружении стенда');
          return {};
        },
      })
      .addPreset(['qa.fix']);
    const deps = makeEngine(cat);
    const agents: AgentFactory = {
      forStep: () => ({
        run: async (request) => {
          prompts.push(request.prompt);
          return { sessionId: 's-1', text: request.prompt.includes('Владелец просит') ? 'учел замечание' : 'не вышло', output: null, costUsd: 0, durationMs: 0, turns: 1, denials: [] };
        },
        lastSession: () => null,
      }),
    };
    const engine = new Engine({ store: deps.store, bus: deps.bus, catalog: cat, profiles: PROFILES, ports: deps.ports, redact: deps.redact, agents, lint: { secrets: [] }, dataDir: deps.dataDir });
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    return { ...deps, engine, run, prompts };
  }

  it('gives the agent the owner note together with the error of the last attempt, once', async () => {
    const t = failingAgentStep();
    await t.engine.start(t.run.id);
    expect(t.store.getStep(t.run.id, 'qa.fix')).toMatchObject({ status: 'failed', error: 'AC 3 кодом не исправить: причина в окружении стенда' });
    await t.engine.retry(t.run.id, 'qa.fix', '  Окружение поправил, прогони AC 3 снова  ');
    expect(t.store.getStep(t.run.id, 'qa.fix')).toMatchObject({ status: 'succeeded', retryNote: null });
    const [, second] = t.prompts;
    expect(second).toContain('Почини AC по отчету');
    expect(second).toContain('Прошлая попытка шага упала с ошибкой:\nAC 3 кодом не исправить: причина в окружении стенда');
    expect(second).toContain('Владелец просит: Окружение поправил, прогони AC 3 снова');
    // Следующий повтор без замечания идет с чистым заданием.
    await t.engine.retry(t.run.id, 'qa.fix');
    expect(t.prompts[2]).toBe('Почини AC по отчету');
  });

  it('refuses a note for a step without an agent and keeps the step as it was', async () => {
    const t = failingAgentStep('code');
    await t.engine.start(t.run.id);
    expect(() => t.engine.retry(t.run.id, 'qa.fix', 'сделай иначе')).toThrow('У шага нет агента');
    expect(t.store.getStep(t.run.id, 'qa.fix')?.status).toBe('failed');
  });
});

describe('Engine: settings of a step in a run', () => {
  const MOVE: StepManifest['params'] = { moveTo: { type: 'jiraStatus', label: 'Куда перевести задачу', milestone: 'inProgress' } };

  /**
   * Шаг с настройкой перевода по доске: превью показывает, куда он переведет задачу, а выполнение запоминает
   * настройки, с которыми шло. hold держит выполнение, пока тест его не отпустит.
   */
  function moving(o: { gate?: StepManifest['gate']; background?: boolean; preset?: Preset['params']; hold?: Promise<void> } = {}) {
    const ran: StepContext['params'][] = [];
    const where = (c: StepContext) => (c.params.moveTo === NO_MOVE ? 'Не переводить' : `Перевести в ${String(c.params.moveTo)}`);
    const cat = new FakeCatalog().add(manifest('a.first'), { run: async () => ({}) }).add(manifest('jira.start', { gate: o.gate ?? 'none', background: o.background ?? false, params: MOVE }), {
      preview: async (c) => ({ title: 'В работу', actions: [where(c)], payload: { moveTo: c.params.moveTo } }),
      async run(c) {
        ran.push(c.params);
        await o.hold;
        return {};
      },
    });
    cat.addPreset(['a.first', 'jira.start'], [], 'full', [...TASK_INPUTS], o.preset ?? {});
    const t = makeEngine(cat);
    const run = t.engine.createRun({ issueKey: 'TEAM-1' });
    const setting = () => t.engine.view(run.id).steps.find((s) => s.stepId === 'jira.start')!.settings[0];
    return { ...t, run, ran, setting };
  }

  it('gives the step the usual milestone status, the default of the preset over it and the choice of the run over both', async () => {
    const usual = moving();
    await usual.engine.start(usual.run.id);
    expect(usual.ran).toEqual([{ moveTo: 'In Progress' }]);

    const preset = moving({ preset: { 'jira.start': { moveTo: 'Open' } } });
    expect(preset.setting()).toMatchObject({ value: 'Open', defaultValue: 'Open', source: 'preset' });
    await preset.engine.start(preset.run.id);
    expect(preset.ran).toEqual([{ moveTo: 'Open' }]);

    const chosen = moving({ preset: { 'jira.start': { moveTo: 'Open' } } });
    await chosen.engine.setParams(chosen.run.id, 'jira.start', { moveTo: NO_MOVE });
    expect(chosen.setting()).toMatchObject({ value: NO_MOVE, defaultValue: 'Open', source: 'run' });
    expect(chosen.store.listEvents(chosen.run.id, 0, 100).find((e) => e.type === 'step.params')?.message).toBe('jira.start: настройки куда перевести задачу - не переводить');
    await chosen.engine.start(chosen.run.id);
    expect(chosen.ran).toEqual([{ moveTo: NO_MOVE }]);
  });

  it('returns the default for null and refuses an unknown setting, a status not on the board and a wrong type', async () => {
    const t = moving();
    await t.engine.setParams(t.run.id, 'jira.start', { moveTo: 'Open' });
    await t.engine.setParams(t.run.id, 'jira.start', { moveTo: null });
    expect(t.store.getStep(t.run.id, 'jira.start')?.params).toEqual({});
    expect(t.setting()).toMatchObject({ value: '', source: 'manifest' });
    expect(() => t.engine.setParams(t.run.id, 'jira.start', { color: 'red' })).toThrow('нет настройки color');
    expect(() => t.engine.setParams(t.run.id, 'jira.start', { moveTo: 'Closed' })).toThrow('варианта "Closed" нет');
    expect(() => t.engine.setParams(t.run.id, 'jira.start', { moveTo: true })).toThrow('нужен текст');
    // Отказ ничего не меняет: ни одного значения из отклоненного запроса в прогоне нет.
    expect(() => t.engine.setParams(t.run.id, 'jira.start', { moveTo: 'Open', color: 'red' })).toThrow('нет настройки color');
    expect(t.store.getStep(t.run.id, 'jira.start')?.params).toEqual({});
  });

  it('does not change the settings of a step while it runs', async () => {
    let release!: () => void;
    const t = moving({ hold: new Promise<void>((r) => (release = r)) });
    const going = t.engine.start(t.run.id);
    const until = Date.now() + 2000;
    while (t.store.getStep(t.run.id, 'jira.start')?.status !== 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    expect(() => t.engine.setParams(t.run.id, 'jira.start', { moveTo: NO_MOVE })).toThrow('Шаг выполняется');
    release();
    await going;
    expect(t.ran).toEqual([{ moveTo: 'In Progress' }]);
  });

  it('burns the approval of a waiting step and asks it again at once with the new settings', async () => {
    const t = moving({ gate: 'before' });
    await t.engine.start(t.run.id);
    const first = t.engine.view(t.run.id).approval!;
    expect(first.preview.actions).toEqual(['Перевести в In Progress']);
    await t.engine.setParams(t.run.id, 'jira.start', { moveTo: NO_MOVE });
    const second = t.engine.view(t.run.id).approval!;
    expect(second.id).not.toBe(first.id);
    expect(second.preview.actions).toEqual(['Не переводить']);
    expect(t.store.getApproval(first.id)?.status).toBe('stale');
    expect(t.store.getRun(t.run.id)?.status).toBe('waiting_owner');
    expect(() => t.engine.decide(first.id, 'approve')).toThrow('неактуален');
    await t.engine.decide(second.id, 'approve');
    expect(t.ran).toEqual([{ moveTo: NO_MOVE }]);
  });

  it('asks the approval of a waiting background step again without running the chain', async () => {
    const t = moving({ gate: 'before', background: true });
    await t.engine.start(t.run.id);
    await t.engine.settled(t.run.id);
    expect(t.engine.view(t.run.id).approval?.preview.actions).toEqual(['Перевести в In Progress']);
    await t.engine.setParams(t.run.id, 'jira.start', { moveTo: 'Open' });
    await t.engine.settled(t.run.id);
    const again = t.engine.view(t.run.id);
    expect(again.approval?.preview.actions).toEqual(['Перевести в Open']);
    expect(again.steps.map((s) => [s.stepId, s.status])).toEqual([
      ['a.first', 'succeeded'],
      ['jira.start', 'waiting_owner'],
    ]);
  });
});
