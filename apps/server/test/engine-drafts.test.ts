import { describe, expect, it } from 'vitest';
import type { StepModule } from '@task-pilot/step-kit';
import { FakeCatalog, makeEngine, manifest } from './helpers.ts';

/** Шаг с черновиком: prepare пишет текст (с замечанием владельца, если оно есть), run его "публикует". */
function drafting(opts: { text?: (feedback: string | null, n: number) => string } = {}) {
  const calls = { prepare: 0, run: 0, feedback: [] as (string | null)[], published: [] as string[], drafts: [] as unknown[] };
  const text = opts.text ?? ((feedback, n) => `Черновик ${n}${feedback ? `: ${feedback}` : ''}`);
  const module: StepModule = {
    async prepare(c) {
      calls.prepare += 1;
      calls.feedback.push(c.feedback);
      calls.drafts.push(c.draft);
      return { text: text(c.feedback, calls.prepare) };
    },
    async preview(c) {
      const d = c.draft as { text: string };
      return { title: 'Опубликовать', actions: ['Комментарий'], payload: { kind: 'comment' }, texts: [{ id: 'body', label: 'Комментарий', text: d.text, publish: true }] };
    },
    async run(c) {
      calls.run += 1;
      calls.published.push((c.draft as { text: string }).text);
      return { published: true };
    },
  };
  return { module, calls };
}

describe('Engine: drafts, rework and the text linter', () => {
  it('prepares the draft once and does not call the agent again on approval', async () => {
    const { module, calls } = drafting();
    const cat = new FakeCatalog().add(manifest('qa.publish', { gate: 'publish' }), module).addPreset(['qa.publish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const view = engine.view(run.id);
    expect(view.approval?.preview.texts?.[0]?.text).toBe('Черновик 1');
    expect(view.steps[0]).toMatchObject({ status: 'waiting_owner', canRework: true });
    await engine.decide(view.approval!.id, 'approve');
    expect(calls).toMatchObject({ prepare: 1, run: 1, published: ['Черновик 1'] });
    expect(store.getStep(run.id, 'qa.publish')?.status).toBe('succeeded');
  });

  it('reworks the draft with the owner comment, keeps the old draft visible to the step and asks again', async () => {
    const { module, calls } = drafting();
    const cat = new FakeCatalog().add(manifest('qa.publish', { gate: 'publish' }), module).addPreset(['qa.publish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const first = engine.view(run.id).approval!;
    await engine.decide(first.id, 'rework', 'короче');
    expect(calls.feedback).toEqual([null, 'короче']);
    expect(calls.drafts[1]).toEqual({ text: 'Черновик 1' });
    expect(store.getApproval(first.id)).toMatchObject({ status: 'rework', comment: 'короче' });
    const second = engine.view(run.id).approval!;
    expect(second.id).not.toBe(first.id);
    expect(second.preview.texts?.[0]?.text).toBe('Черновик 2: короче');
    expect(store.getStep(run.id, 'qa.publish')?.feedback).toBeNull();
    expect(calls.run).toBe(0);
    await engine.decide(second.id, 'approve');
    expect(calls.published).toEqual(['Черновик 2: короче']);
  });

  it('requires a comment to rework and refuses rework for a step without a draft', async () => {
    const { module } = drafting();
    const plain: StepModule = {
      async preview() {
        return { title: 'Перевести', actions: [], payload: {} };
      },
      async run() {
        return {};
      },
    };
    const cat = new FakeCatalog()
      .add(manifest('qa.publish', { gate: 'publish' }), module)
      .add(manifest('jira.start', { gate: 'before' }), plain)
      .addPreset(['jira.start', 'qa.publish']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const gate = engine.view(run.id).approval!;
    expect(gate.stepId).toBe('jira.start');
    expect(() => engine.decide(gate.id, 'rework', 'иначе')).toThrow('не готовит черновик');
    await engine.decide(gate.id, 'approve');
    const publish = engine.view(run.id).approval!;
    expect(() => engine.decide(publish.id, 'rework', '   ')).toThrow('Напишите, что переделать');
  });

  it('blocks approval when a published text contains forbidden content and allows rework', async () => {
    const { module, calls } = drafting({ text: (feedback) => (feedback ? 'Согласовано с тимлидом' : 'Согласовано с Петровым, тел. +7 916 123-45-67') });
    const cat = new FakeCatalog().add(manifest('qa.publish', { gate: 'publish' }), module).addPreset(['qa.publish']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const blocked = engine.view(run.id).approval!;
    expect(blocked.blocked).toBe(true);
    expect(blocked.preview.lint?.map((i) => `${i.severity}:${i.rule}`)).toEqual(['block:phone', 'block:name']);
    expect(() => engine.decide(blocked.id, 'approve')).toThrow('заблокирована линтером');
    await engine.decide(blocked.id, 'rework', 'убери имя и телефон');
    const clean = engine.view(run.id).approval!;
    expect(clean.blocked).toBe(false);
    await engine.decide(clean.id, 'approve');
    expect(calls.published).toEqual(['Согласовано с тимлидом']);
  });

  it('blocks a published text that the step did not pass through the linter fixes', async () => {
    const { module } = drafting({ text: () => 'Всё готово — «ок»' });
    const cat = new FakeCatalog().add(manifest('qa.publish', { gate: 'publish' }), module).addPreset(['qa.publish']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const a = engine.view(run.id).approval!;
    expect(a.blocked).toBe(true);
    expect(a.preview.lint?.[0]).toMatchObject({ rule: 'unlinted', severity: 'block' });
  });

  it('leaves a published text the step linted itself to the step: its own remarks decide the approval', async () => {
    const page = 'Цитата «Введён код», ответственный - Петров';
    const module = (lint: { rule: string; severity: 'block'; message: string }[]): StepModule => ({
      async prepare() {
        return {};
      },
      async preview() {
        return { title: 'Страница вики', actions: [], payload: {}, texts: [{ id: 'page', label: 'Страница', text: page, publish: true, stepLinted: true }], lint };
      },
      async run() {
        return {};
      },
    });
    const kept = makeEngine(new FakeCatalog().add(manifest('wiki.update', { gate: 'publish' }), module([])).addPreset(['wiki.update']));
    const run = kept.engine.createRun({ issueKey: 'TEAM-1' });
    await kept.engine.start(run.id);
    expect(kept.engine.view(run.id).approval).toMatchObject({ blocked: false, preview: { lint: [] } });

    const added = makeEngine(new FakeCatalog().add(manifest('wiki.update', { gate: 'publish' }), module([{ rule: 'name', severity: 'block', message: 'Страница: имя' }])).addPreset(['wiki.update']));
    const other = added.engine.createRun({ issueKey: 'TEAM-1' });
    await added.engine.start(other.id);
    expect(added.engine.view(other.id).approval?.blocked).toBe(true);
  });

  it('does not lint internal documents that are only shown for approval', async () => {
    const module: StepModule = {
      async prepare() {
        return { plan: 'План — со всем, «как есть»' };
      },
      async preview(c) {
        return { title: 'Утвердить план', actions: [], payload: {}, texts: [{ id: 'plan', label: 'План', text: (c.draft as { plan: string }).plan, publish: false }] };
      },
      async run() {
        return {};
      },
    };
    const cat = new FakeCatalog().add(manifest('task.analyze', { gate: 'before' }), module).addPreset(['task.analyze']);
    const { engine } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(engine.view(run.id).approval).toMatchObject({ blocked: false, preview: { title: 'Утвердить план' } });
    expect(engine.view(run.id).approval?.preview.lint).toBeUndefined();
  });

  it('burns the approval when only the text changed after the click', async () => {
    let text = 'Первый текст';
    const module: StepModule = {
      async prepare() {
        return {};
      },
      async preview() {
        return { title: 'Опубликовать', actions: [], payload: { same: true }, texts: [{ id: 'body', label: 'Текст', text, publish: true }] };
      },
      async run() {
        return {};
      },
    };
    const cat = new FakeCatalog().add(manifest('qa.publish', { gate: 'publish' }), module).addPreset(['qa.publish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const first = engine.view(run.id).approval!;
    text = 'Другой текст';
    await engine.decide(first.id, 'approve');
    expect(store.getApproval(first.id)?.status).toBe('stale');
    expect(engine.view(run.id).approval?.preview.texts?.[0]?.text).toBe('Другой текст');
  });

  it('keeps the approval when only the way the text is shown changed, not its words', async () => {
    let format: 'markdown' | undefined;
    let ran = 0;
    const module: StepModule = {
      async prepare() {
        return {};
      },
      async preview() {
        return { title: 'Утвердить план', actions: [], payload: { same: true }, texts: [{ id: 'plan', label: 'План', text: '# План', publish: false, ...(format ? { format } : {}) }] };
      },
      async run() {
        ran += 1;
        return {};
      },
    };
    const cat = new FakeCatalog().add(manifest('task.analyze', { gate: 'publish' }), module).addPreset(['task.analyze']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    const first = engine.view(run.id).approval!;
    format = 'markdown';
    await engine.decide(first.id, 'approve');
    expect(store.getApproval(first.id)?.status).toBe('consumed');
    expect(ran).toBe(1);
  });

  it('starts over with a fresh draft when the owner retries the step', async () => {
    const { module, calls } = drafting();
    const cat = new FakeCatalog().add(manifest('qa.publish', { gate: 'publish' }), module).addPreset(['qa.publish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    await engine.decide(engine.view(run.id).approval!.id, 'reject', 'не то');
    expect(store.getDraft(run.id, 'qa.publish')).toEqual({ text: 'Черновик 1' });
    await engine.retry(run.id, 'qa.publish');
    expect(calls.drafts).toEqual([undefined, undefined]);
    expect(engine.view(run.id).approval?.preview.texts?.[0]?.text).toBe('Черновик 2');
  });

  it('does not call prepare in a dry run and simulates the step instead', async () => {
    const { module, calls } = drafting();
    module.simulate = async () => ({ published: false });
    const cat = new FakeCatalog().add(manifest('qa.publish', { gate: 'publish' }), module).addPreset(['qa.publish']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1', dryRun: true });
    await engine.start(run.id);
    expect(calls.prepare).toBe(0);
    expect(store.getStep(run.id, 'qa.publish')?.status).toBe('simulated');
  });

  it('stops a running step when the owner presses stop and does not run the next steps', async () => {
    let started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    const next = { run: 0 };
    const cat = new FakeCatalog()
      .add(manifest('code.implement'), {
        async run(c) {
          started();
          await new Promise((_resolve, reject) => c.signal.addEventListener('abort', () => reject(new Error('прервано'))));
          return {};
        },
      })
      .add(manifest('code.verify'), {
        async run() {
          next.run += 1;
          return {};
        },
      })
      .addPreset(['code.implement', 'code.verify']);
    const { engine, store } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    const done = engine.start(run.id);
    await began;
    engine.stop(run.id);
    await done;
    expect(store.getStep(run.id, 'code.implement')).toMatchObject({ status: 'failed', error: 'Остановлено владельцем' });
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(next.run).toBe(0);
    expect(() => engine.stop(run.id)).toThrow('не выполняется');
  });

  it('gives steps the task folders inside the repository, a run folder for logs and the agent copy of the docs', async () => {
    let paths: unknown;
    const cat = new FakeCatalog()
      .add(manifest('a.one'), {
        async run(c) {
          paths = c.paths;
          return {};
        },
      })
      .addPreset(['a.one']);
    const { engine, dataDir } = makeEngine(cat);
    const run = engine.createRun({ issueKey: 'TEAM-1' });
    await engine.start(run.id);
    expect(paths).toEqual({
      docs: '/tmp/demo/.claude/TEAM-1',
      artifacts: '/tmp/demo/.claude/artifacts/TEAM-1',
      run: `${dataDir}/runs/${run.id}`,
      // Агенту CLI не дает писать в папки .claude: его копия доков лежит рядом с рабочими папками веток.
      agentDocs: '/tmp/wt/.task-pilot/demo-TEAM-1/docs',
    });
  });
});
