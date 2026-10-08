import { describe, expect, it } from 'vitest';
import { StepWaiting, timed, type StepModule, type WaitEvent } from '@task-pilot/step-kit';
import { FakeCatalog, makeEngine, manifest } from './helpers.ts';

/** Шаг, который ждет, пока его не прервут. */
function hanging() {
  let started!: () => void;
  const began = new Promise<void>((r) => (started = r));
  const module: StepModule = {
    async run(c) {
      started();
      await new Promise((_resolve, reject) => c.signal.addEventListener('abort', () => reject(new Error('прервано'))));
      return {};
    },
  };
  return { module, began };
}

const noop: StepModule = { run: async () => ({}) };

describe('Engine: safety of runs and approvals', () => {
  it('marks the step interrupted by a server shutdown as such, not as stopped by the owner', async () => {
    const h = hanging();
    const cat = new FakeCatalog().add(manifest('code.verify'), h.module).addPreset(['code.verify']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    void engine.start(run.id);
    await h.began;
    await engine.shutdown(2000);
    expect(store.getStep(run.id, 'code.verify')).toMatchObject({ status: 'failed', error: 'Прервано перезапуском сервера' });
    expect(store.getRun(run.id)?.status).toBe('paused');
  });

  it('keeps a step that waits for an event through a server restart and goes on with it after the start', async () => {
    let built = false;
    const event: WaitEvent = { kind: 'build', contour: 'cloud', planKey: 'P-1', revision: 'abc', ...timed(new Date().toISOString(), 45 * 60_000, 'Сборка не закончилась за 45 минут') };
    const cat = new FakeCatalog()
      .add(manifest('ci.wait'), {
        async run() {
          throw new StepWaiting('Жду сборку коммита abc', event);
        },
        async resume() {
          if (!built) throw new StepWaiting('Жду сборку коммита abc', event);
          return {};
        },
      })
      .addPreset(['ci.wait']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    // Ждущий шаг не выполняется: перезапуск сервера его не прерывает, а после старта наблюдатель продолжит прогон.
    await engine.shutdown(1000);
    engine.recover();
    expect(store.getStep(run.id, 'ci.wait')).toMatchObject({ status: 'waiting', error: null, note: 'Жду сборку коммита abc' });
    expect(store.getRun(run.id)?.status).toBe('waiting');
    built = true;
    await engine.start(run.id);
    expect(store.getStep(run.id, 'ci.wait')?.status).toBe('succeeded');
    expect(store.getRun(run.id)?.status).toBe('completed');
  });

  it('does not run two runs of the same issue at once', async () => {
    const h = hanging();
    const cat = new FakeCatalog().add(manifest('code.implement'), h.module).addPreset(['code.implement']);
    const { engine } = makeEngine(cat);
    const first = engine.createRun({ issueKey: 'TEAM-1' });
    const second = engine.createRun({ issueKey: 'TEAM-1' });
    const other = engine.createRun({ issueKey: 'TEAM-2' });
    const p = engine.start(first.id);
    await h.began;
    expect(() => engine.start(second.id)).toThrow('По задаче уже выполняется другой прогон');
    expect(() => engine.retry(second.id, 'code.implement')).toThrow('По задаче уже выполняется другой прогон');
    void engine.start(other.id);
    engine.stop(first.id);
    engine.stop(other.id);
    await p;
  });

  it('burns a waiting approval when the step went ahead without it', async () => {
    let needsApproval = true;
    const module: StepModule = {
      async preview() {
        return { title: 'Ребейз', actions: ['rebase'], payload: { rebase: needsApproval }, requiresApproval: needsApproval };
      },
      async run() {
        return {};
      },
    };
    const cat = new FakeCatalog().add(manifest('git.prepare', { gate: 'before' }), module).addPreset(['git.prepare']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const a = engine.view(run.id).approval!;
    needsApproval = false;
    await engine.skip(run.id, 'git.prepare');
    expect(store.getApproval(a.id)?.status).toBe('stale');
    await engine.retry(run.id, 'git.prepare');
    expect(store.getStep(run.id, 'git.prepare')?.status).toBe('succeeded');
    expect(engine.view(run.id).approval).toBeNull();
  });

  it('does not keep an approval that was given but not used after the run options changed', async () => {
    const module: StepModule = {
      async preview() {
        return { title: 'Деплой', actions: [], payload: {} };
      },
      async run() {
        throw new Error('сбой до расхода подтверждения не бывает, но проверим отказ');
      },
    };
    const before: StepModule = {
      async run() {
        throw new Error('упал раньше');
      },
    };
    const cat = new FakeCatalog().add(manifest('a.before'), before).add(manifest('deploy.stand', { gate: 'publish' }), module).addPreset(['a.before', 'deploy.stand']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    engine.setSelected(run.id, 'a.before', false);
    await engine.start(run.id);
    const a = engine.view(run.id).approval!;
    store.updateApproval(a.id, { status: 'approved' });
    engine.setOptions(run.id, { standId: 'stable' });
    expect(store.getApproval(a.id)?.status).toBe('stale');
  });

  it('refuses a rejection while the run is executing, so the rejection is not silently lost', async () => {
    const h = hanging();
    const gated: StepModule = {
      async preview() {
        return { title: 'Пуш', actions: [], payload: {} };
      },
      async run() {
        return {};
      },
    };
    const cat = new FakeCatalog().add(manifest('code.implement'), h.module).add(manifest('code.publish', { gate: 'publish' }), gated).addPreset(['code.implement', 'code.publish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    engine.setSelected(run.id, 'code.implement', false);
    await engine.start(run.id);
    const a = engine.view(run.id).approval!;
    const p = engine.retry(run.id, 'code.implement');
    await h.began;
    expect(() => engine.decide(a.id, 'reject', 'не то')).toThrow('Прогон выполняется');
    expect(store.getApproval(a.id)?.status).toBe('pending');
    engine.stop(run.id);
    await p;
  });

  it('blocks an empty publish text', async () => {
    const module: StepModule = {
      async prepare() {
        return {};
      },
      async preview() {
        return { title: 'Коммит', actions: [], payload: {}, texts: [{ id: 'commit', label: 'Сообщение коммита', text: '  ', publish: true }] };
      },
      async run() {
        return {};
      },
    };
    const cat = new FakeCatalog().add(manifest('code.publish', { gate: 'publish' }), module).addPreset(['code.publish']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const a = engine.view(run.id).approval!;
    expect(a.blocked).toBe(true);
    expect(a.preview.lint).toEqual([{ rule: 'empty', severity: 'block', message: 'Сообщение коммита: пустой текст' }]);
  });

  it('runs simulated steps for real after the owner turns the dry run off and drops their fake outputs', async () => {
    let real = 0;
    const module: StepModule = {
      async simulate() {
        return { branch: 'имитация' };
      },
      async run() {
        real += 1;
        return { branch: 'feature/TEAM-1' };
      },
    };
    const cat = new FakeCatalog().add(manifest('git.prepare'), module).addPreset(['git.prepare']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1', dryRun: true });
    await engine.start(run.id);
    expect(store.getContext(run.id)).toEqual({ branch: 'имитация' });
    engine.setOptions(run.id, { dryRun: false });
    expect(store.getStep(run.id, 'git.prepare')?.status).toBe('pending');
    expect(store.getContext(run.id)).toEqual({});
    await engine.start(run.id);
    expect(real).toBe(1);
    expect(store.getContext(run.id)).toEqual({ branch: 'feature/TEAM-1' });
  });

  it('brings an untouched run to the current preset order and defaults, keeping what the owner toggled', () => {
    const cat = new FakeCatalog()
      .add(manifest('jira.start'), noop)
      .add(manifest('task.analyze'))
      .add(manifest('git.prepare'), noop)
      .add(manifest('code.implement'))
      .addPreset(['jira.start', 'task.analyze', 'git.prepare', 'code.implement']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    engine.setSelected(run.id, 'jira.start', false);
    // Каталог обновился: анализ и реализация реализованы, "Ветка" теперь идет перед анализом.
    cat.add(manifest('task.analyze'), noop).add(manifest('code.implement'), noop).addPreset(['jira.start', 'git.prepare', 'task.analyze', 'code.implement']);
    engine.syncSteps(run.id);
    expect(store.getSteps(run.id).map((s) => `${s.stepId}:${s.selected}`)).toEqual(['jira.start:false', 'git.prepare:true', 'task.analyze:true', 'code.implement:true']);
    expect(store.listEvents(run.id).some((e) => e.type === 'run.steps')).toBe(true);
  });

  it('leaves a run alone once any of its steps did something', async () => {
    const cat = new FakeCatalog().add(manifest('a.one'), noop).add(manifest('a.two'), noop).addPreset(['a.one', 'a.two']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    cat.addPreset(['a.two', 'a.one']);
    engine.syncSteps(run.id);
    expect(store.getSteps(run.id).map((s) => s.stepId)).toEqual(['a.one', 'a.two']);
  });
});
