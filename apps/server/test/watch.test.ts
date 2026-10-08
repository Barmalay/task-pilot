import { describe, expect, it } from 'vitest';
import type { BambooPort, Issue, PullRequestState, ScmPort, StandLogsPort, StepTrigger, WaitEvent } from '@task-pilot/step-kit';
import { issueChanges, StepWaiting, timed } from '@task-pilot/step-kit';
import { finished, Watcher, type WatcherDeps } from '../src/watch.ts';
import { fakeJira, FakeCatalog, issue, makeEngine, manifest, PROFILES } from './helpers.ts';

const SCM = { contour: 'cloud', project: 'CLOUD', repo: 'demo' };
/** Доска вроде доски команды: путь до MERGED, после него Monitoring, закрытая задача закончена. */
const BOARD = {
  ...PROFILES.jira,
  path: [
    { from: 'Open', id: '4', name: 'Start Progress', to: 'In Progress' },
    { from: 'In Progress', id: '971', name: 'Готово к ревью', to: 'Ready to Review' },
    { from: 'Ready to Review', id: '1091', name: 'Можно тестировать', to: 'To Testing' },
    { from: 'To Testing', id: '751', name: 'Взять в тестирование', to: 'In Testing' },
    { from: 'In Testing', id: '721', name: 'Все хорошо!', to: 'Resolved' },
    { from: 'Resolved', id: '1011', name: 'Смержено', to: 'MERGED' },
  ],
  after: ['Monitoring'],
  offPath: ['Waiting', 'Closed'],
  finished: ['Closed'],
  milestones: { inProgress: 'In Progress', review: 'Ready to Review', testing: 'In Testing', merged: 'MERGED' },
};

describe('a finished task', () => {
  it('has reached the merge milestone of the board or a status after it, or is in a finished status of the board', () => {
    expect(['MERGED', 'Monitoring', 'Closed', 'closed'].map((s) => finished(s, BOARD))).toEqual([true, true, true, true]);
    expect(['Open', 'In Testing', 'Waiting'].map((s) => finished(s, BOARD))).toEqual([false, false, false]);
  });

  it('knows only the statuses of its own board: no MERGED or Closed of another board', () => {
    const other = { path: [{ from: 'Open', to: 'Doing' }, { from: 'Doing', to: 'Done' }], after: [], milestones: { merged: null }, finished: ['Done'] };
    expect(finished('Done', other)).toBe(true);
    expect(['MERGED', 'Closed', 'Doing'].map((s) => finished(s, other))).toEqual([false, false, false]);
  });
});

function pr(over: Partial<PullRequestState> = {}): PullRequestState {
  return { id: 262, title: 'TEAM-1 Вход', url: 'https://git.example.org/pr/262', state: 'OPEN', author: 'Автор', reviewers: [], comments: [], ...over };
}

const COMMENT = { id: 7929, author: 'Ревьюер', text: 'Добавил ключи в k8s?', createdAt: 'x', state: 'OPEN', file: null, line: null, replies: [] } as PullRequestState['comments'][number];

function fakeScm(state: { pr: PullRequestState }): ScmPort {
  return {
    openPullRequests: async () => [],
    createPullRequest: async () => state.pr,
    findPullRequest: async () => state.pr,
    pullRequest: async () => state.pr,
    reply: async () => {},
  };
}

/** Ответ на ревью в тестах: шаг, который по манифесту сам запускается по замечаниям в PR. */
const ANSWER = { id: 'review.answer', trigger: { event: 'pr.review', auto: true } as StepTrigger | undefined };

/**
 * Прогон, чей шаг "Мерж" ждет мержа PR, а перед ним стоит шаг ответа на ревью (по умолчанию ANSWER). Шаги считают
 * свои запуски, чтобы было видно, что наблюдатель продолжил прогон.
 */
async function waitingRun(opts: { issues?: Record<string, Issue>; answer?: typeof ANSWER } = {}) {
  const answer = opts.answer ?? ANSWER;
  const state = { pr: pr(), reviews: 0, finishes: 0 };
  const cat = new FakeCatalog()
    .add(manifest(answer.id, { trigger: answer.trigger }), {
      async run() {
        state.reviews += 1;
        return {};
      },
    })
    .add(manifest('task.finish'), {
      async run() {
        state.finishes += 1;
        if (state.pr.state !== 'MERGED') throw new StepWaiting('Жду мерж PR #262', { kind: 'pr', scm: SCM, pr: 262 });
        return { merged: { pr: 262, at: '2026-09-25T10:00:00.000Z' } };
      },
    })
    .addPreset([answer.id, 'task.finish']);
  const jira = fakeJira(opts.issues ?? { 'TEAM-1': issue('TEAM-1', { status: 'Ready to Review', updated: '2026-09-23T10:00:00.000+0300' }) });
  const deps = makeEngine(cat, [], jira.port);
  const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
  deps.store.setContext(run.id, 'issue', await jira.port.getIssue('TEAM-1'), null);
  await deps.engine.start(run.id);
  const watcher = new Watcher({ store: deps.store, engine: deps.engine, bus: deps.bus, ports: { ...NO_PORTS, jira: jira.port, scm: fakeScm(state) }, profiles: PROFILES, jira: () => BOARD, redact: deps.redact }, 0);
  /** Проверка наблюдателя и ожидание прогона, который она запустила. */
  const tick = async () => {
    await watcher.tick();
    if (deps.engine.isActive(run.id)) await deps.engine.start(run.id);
  };
  return { ...deps, run, state, tick, events: () => deps.store.listEvents(run.id).map((e) => e.type) };
}

/** Порты, которые тест не настроил: обращение к ним - ошибка с именем порта. */
const NO_PORTS: WatcherDeps['ports'] = {
  jira: fakeJira().port,
  scm: fakeScm({ pr: pr() }),
  bamboo: () => {
    throw new Error('Bamboo в тесте не нужен');
  },
  logs: () => {
    throw new Error('логи стенда в тесте не нужны');
  },
  git: {
    run: async () => {
      throw new Error('git в тесте не нужен');
    },
    tryRun: async () => {
      throw new Error('git в тесте не нужен');
    },
  },
};

const MINUTE = 60_000;
/** Срок ожидания от сейчас: ms вперед, отрицательный - срок уже вышел. */
const due = (ms: number, error = 'срок вышел') => timed(new Date(Date.now() + ms - 10 * MINUTE).toISOString(), 10 * MINUTE, error);

/**
 * Прогон, чей шаг ждет события event: как шаг сборки или деплоя, продолжение он делает через resume и считает его.
 * Наблюдатель спрашивает подменные порты ports, по умолчанию с интервалом 0: каждая проверка смотрит все ожидания.
 */
async function waitingOn(event: WaitEvent, ports: Partial<WatcherDeps['ports']>, intervals: [number, number] = [0, 0]) {
  const state = { resumed: 0 };
  const cat = new FakeCatalog()
    .add(manifest('demo.wait'), {
      async run() {
        throw new StepWaiting('Жду события', event);
      },
      async resume(_c, e) {
        state.resumed += 1;
        expect(e).toEqual(event);
        return {};
      },
    })
    .add(manifest('deploy.stand'), { run: async () => ({}) })
    .addPreset(['demo.wait'])
    .addPreset(['deploy.stand'], [], 'linked');
  const deps = makeEngine(cat);
  const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
  await deps.engine.start(run.id);
  expect(deps.store.getStep(run.id, 'demo.wait')?.status).toBe('waiting');
  const watcher = new Watcher({ store: deps.store, engine: deps.engine, bus: deps.bus, ports: { ...NO_PORTS, ...ports }, profiles: PROFILES, jira: () => BOARD, redact: deps.redact }, ...intervals);
  const tick = async (now?: Date) => {
    await watcher.tick(now);
    if (deps.engine.isActive(run.id)) await deps.engine.start(run.id);
  };
  return { ...deps, run, state, tick, status: () => deps.store.getRun(run.id)?.status };
}

describe('changes of a task in Jira', () => {
  it('names a status change and whether the task was sent back on the board', () => {
    const before = issue('TEAM-1', { status: 'In Testing' });
    expect(issueChanges(before, { ...before, status: 'In Progress' }, BOARD)).toEqual([{ kind: 'status', text: 'статус In Testing → In Progress, задачу вернули', returned: true }]);
    expect(issueChanges(before, { ...before, status: 'Resolved' }, BOARD)[0]).toMatchObject({ returned: false });
  });

  it('tells a change of the acceptance criteria from a change of the description', () => {
    const before = issue('TEAM-1', { updated: 'a' });
    expect(issueChanges(before, { ...before, description: '## Критерии приемки\n- первый\n- второй\n- третий' }, BOARD)).toEqual([{ kind: 'ac', text: 'критерии приемки: было 2, стало 3' }]);
    expect(issueChanges(before, { ...before, description: `Контекст\n\n${before.description}` }, BOARD)).toEqual([{ kind: 'description', text: 'изменилось описание' }]);
    expect(issueChanges(before, before, BOARD)).toEqual([]);
  });

  it('counts new comments of other people and changed fields, but not the comments of the owner, a new sprint or the update time alone', () => {
    const comment = (id: string, author: string) => ({ id, author, created: '2026-09-23T10:00:00.000+0300' });
    const before = issue('TEAM-1', { updated: 'a', comments: [comment('1', 'reviewer')] });
    const after = { ...before, updated: 'b', comments: [comment('1', 'reviewer'), comment('2', 'owner'), comment('3', 'reviewer'), comment('4', 'qa')] };
    expect(issueChanges(before, after, BOARD)).toEqual([{ kind: 'comments', text: 'новые комментарии: 2' }]);
    expect(issueChanges(before, { ...before, updated: 'b', comments: [...before.comments!, comment('2', 'owner')] }, BOARD)).toEqual([]);
    expect(issueChanges({ ...before, comments: undefined }, after, BOARD)).toEqual([]);
    expect(issueChanges(before, { ...before, labels: ['backend'], assignee: { name: 'qa' } }, BOARD)).toEqual([{ kind: 'fields', text: 'изменились поля: метки, исполнитель' }]);
    expect(issueChanges(before, { ...before, updated: 'c', sprint: { id: 5000, name: 'Следующий', state: 'active' } }, BOARD)).toEqual([]);
  });
});

describe('watcher', () => {
  it('goes on with a run once its pull request is merged and leaves it waiting while the PR is open', async () => {
    const t = await waitingRun();
    expect(t.store.getStep(t.run.id, 'task.finish')).toMatchObject({ status: 'waiting', note: 'Жду мерж PR #262' });
    expect(t.store.getRun(t.run.id)?.status).toBe('waiting');
    await t.tick();
    expect(t.state.finishes).toBe(1);
    t.state.pr = pr({ state: 'MERGED' });
    await t.tick();
    expect(t.store.getStep(t.run.id, 'task.finish')?.status).toBe('succeeded');
    expect(t.store.getRun(t.run.id)?.status).toBe('completed');
    expect(t.events()).toContain('pr.merged');
  });

  it('starts the answer to the review again for new comments without an answer, once per comment', async () => {
    const t = await waitingRun();
    expect(t.state.reviews).toBe(1);
    t.state.pr = pr({ comments: [COMMENT] });
    await t.tick();
    expect(t.state.reviews).toBe(2);
    expect(t.store.getContext(t.run.id).prSeen).toEqual([7929]);
    expect(t.events().filter((e) => e === 'pr.review')).toHaveLength(1);
    await t.tick();
    expect(t.state.reviews).toBe(2);
    expect(t.events().filter((e) => e === 'pr.review')).toHaveLength(1);
  });

  it('finds the step to start by its trigger, not by its id, and leaves a step the owner starts or one out of the plan', async () => {
    // Шаг с id настоящего ответа на ревью, но без триггера, идет только по порядку плана.
    for (const answer of [
      { id: 'pr.address-review', trigger: undefined },
      { id: 'review.answer', trigger: { event: 'pr.review', auto: false } as StepTrigger },
      { id: 'review.answer', trigger: { event: 'issue.changed', auto: true } as StepTrigger },
    ]) {
      const t = await waitingRun({ answer });
      t.state.pr = pr({ comments: [COMMENT] });
      await t.tick();
      expect(t.state.reviews, JSON.stringify(answer)).toBe(1);
      expect(t.events()).toContain('pr.review');
    }
    const t = await waitingRun();
    t.store.updateStep(t.run.id, ANSWER.id, { selected: false });
    t.state.pr = pr({ comments: [COMMENT] });
    await t.tick();
    expect(t.state.reviews).toBe(1);
  });

  it('keeps the changes of the task in the run context and reports them once', async () => {
    const issues = { 'TEAM-1': issue('TEAM-1', { status: 'In Testing', updated: '2026-09-23T10:00:00.000+0300' }) };
    const t = await waitingRun({ issues });
    await t.tick();
    expect(t.store.getContext(t.run.id).issueChanged).toBeUndefined();
    issues['TEAM-1'] = { ...issues['TEAM-1'], status: 'In Progress', updated: '2026-09-23T12:00:00.000+0300' };
    await t.tick();
    expect(t.store.getContext(t.run.id).issueChanged).toMatchObject({ status: 'In Progress', changes: [{ kind: 'status', returned: true }] });
    await t.tick();
    expect(t.events().filter((e) => e === 'issue.changed')).toHaveLength(1);
  });

  it('reports the same change once even when the task has no update time', async () => {
    const issues = { 'TEAM-1': issue('TEAM-1', { status: 'Ready to Review', updated: undefined }) };
    const t = await waitingRun({ issues });
    issues['TEAM-1'] = { ...issues['TEAM-1'], status: 'In Progress' };
    await t.tick();
    await t.tick();
    expect(t.events().filter((e) => e === 'issue.changed')).toHaveLength(1);
    expect(t.store.getContext(t.run.id).issueChanged).toMatchObject({ changes: [{ kind: 'status', returned: true }] });
  });

  it('does not report the transitions the run made itself, but reports a return after them', async () => {
    const issues = { 'TEAM-1': issue('TEAM-1', { status: 'Ready to Review', updated: 'a' }) };
    const t = await waitingRun({ issues });
    t.store.setContext(t.run.id, 'status', 'In Testing', 'qa.publish');
    issues['TEAM-1'] = { ...issues['TEAM-1'], status: 'In Testing', updated: 'b' };
    await t.tick();
    expect(t.store.getContext(t.run.id).issueChanged).toBeUndefined();
    issues['TEAM-1'] = { ...issues['TEAM-1'], status: 'In Progress', updated: 'c' };
    await t.tick();
    expect(t.store.getContext(t.run.id).issueChanged).toMatchObject({ changes: [{ kind: 'status', text: 'статус In Testing → In Progress, задачу вернули' }] });
  });

  it('leaves alone a task that the run itself walked to MERGED', async () => {
    const issues = { 'TEAM-1': issue('TEAM-1', { status: 'In Testing', updated: 'a' }) };
    const t = await waitingRun({ issues });
    t.store.setContext(t.run.id, 'status', 'MERGED', 'task.finish');
    issues['TEAM-1'] = { ...issues['TEAM-1'], status: 'MERGED', updated: 'b' };
    await t.tick();
    expect(t.events()).not.toContain('issue.changed');
    expect(t.store.getContext(t.run.id).issueSeen).toBeUndefined();
  });

  it('leaves alone a task that is already merged', async () => {
    const issues = { 'TEAM-1': issue('TEAM-1', { status: 'MERGED', updated: 'a' }) };
    const t = await waitingRun({ issues });
    issues['TEAM-1'] = { ...issues['TEAM-1'], updated: 'b' };
    await t.tick();
    expect(t.events()).not.toContain('issue.changed');
  });
});

describe('watcher: events the steps wait for', () => {
  it('goes on with a run once Bamboo has the plan branch, the build commit has finished or the deployment is over', async () => {
    const ci = { branch: false, build: 'InProgress', deploy: 'IN_PROGRESS', manual: false };
    const bamboo = {
      planBranch: async () => (ci.branch ? { key: 'P-1', name: 'feature-TEAM-1' } : null),
      builds: async () => [{ key: 'P-1-1', number: 1, state: 'Unknown', lifeCycle: ci.build, revision: 'abc', url: '' }],
      deployResult: async () => ({ id: 42, envId: 1, versionId: 21, versionName: 'v', state: 'UNKNOWN', lifeCycle: ci.deploy, startedAt: null, finishedAt: null }),
      environmentResults: async () => (ci.manual ? [{ id: 55, envId: 1, versionId: 21, versionName: 'v', state: 'UNKNOWN', lifeCycle: 'IN_PROGRESS', startedAt: new Date().toISOString(), finishedAt: null }] : []),
    } as unknown as BambooPort;
    const cases: [WaitEvent, () => void][] = [
      [{ kind: 'plan-branch', contour: 'cloud', plan: 'P', branch: 'feature/TEAM-1', ...due(MINUTE) }, () => (ci.branch = true)],
      [{ kind: 'build', contour: 'cloud', planKey: 'P-1', revision: 'abc', ...due(MINUTE) }, () => (ci.build = 'Finished')],
      [{ kind: 'deploy', contour: 'cloud', resultId: 42, ...due(MINUTE) }, () => (ci.deploy = 'FINISHED')],
      [{ kind: 'manual-deploy', contour: 'cloud', envId: 1, versionId: 21, ...due(MINUTE) }, () => (ci.manual = true)],
    ];
    for (const [event, happen] of cases) {
      const t = await waitingOn(event, { bamboo: () => bamboo });
      await t.tick();
      expect(t.state.resumed, event.kind).toBe(0);
      expect(t.status()).toBe('waiting');
      happen();
      await t.tick();
      expect(t.state.resumed, event.kind).toBe(1);
      expect(t.status()).toBe('completed');
    }
  });

  it('goes on after the rollout once the pod has the image of the build and the stand answers', async () => {
    const stand = { tag: '1.0.3-11', status: 503 };
    const calls: string[] = [];
    const logs: StandLogsPort = {
      pods: async (app, namespaces) => {
        calls.push(`pods ${app} ${namespaces.join()}`);
        return { [namespaces[0]!]: [{ pod: 'p', tag: stand.tag, firstSeen: '', lastSeen: '' }] };
      },
      probe: async () => ({ status: stand.status, environment: null }),
    };
    const event: WaitEvent = { kind: 'rollout', standId: 'stable', repoId: 'demo', app: 'demo', tag: '1.0.4-12', probe: { url: 'https://stable/.well-known', service: false }, resultId: 42, ...due(MINUTE) };
    const t = await waitingOn(event, { logs: () => logs });
    await t.tick();
    stand.tag = '1.0.4-12';
    await t.tick();
    expect(t.state.resumed).toBe(0);
    stand.status = 200;
    await t.tick();
    expect(t.state.resumed).toBe(1);
    expect(calls[0]).toBe('pods demo stable-cloud');
  });

  it('goes on once the linked runs of the task have deployed, even though the waiting run is not the newest run of the task', async () => {
    const t = await waitingOn({ kind: 'linked', deployStep: 'deploy.stand', ...due(MINUTE) }, {});
    const linked = t.engine.createRun({ issueKey: 'TEAM-1', repoId: 'api-auth', presetId: 'linked' });
    await t.tick();
    expect(t.state.resumed).toBe(0);
    t.store.updateStep(linked.id, 'deploy.stand', { status: 'succeeded' });
    await t.tick();
    expect(t.state.resumed).toBe(1);
  });

  it('fails the step with its own error once the deadline passed, with the last failed check if there was one', async () => {
    const t = await waitingOn({ kind: 'build', contour: 'cloud', planKey: 'P-1', revision: 'abc', ...due(-MINUTE, 'Сборка коммита abc не закончилась за 45 минут') }, {
      bamboo: () => ({ builds: async () => [] }) as unknown as BambooPort,
    });
    await t.tick();
    expect(t.store.getStep(t.run.id, 'demo.wait')).toMatchObject({ status: 'failed', error: 'Сборка коммита abc не закончилась за 45 минут' });
    expect(t.status()).toBe('failed');
    expect(t.store.getContext(t.run.id)).not.toHaveProperty('waiting');
    const broken = await waitingOn({ kind: 'deploy', contour: 'cloud', resultId: 42, ...due(-MINUTE, 'Деплой не закончился за 40 минут') }, {
      bamboo: () =>
        ({
          deployResult: async () => {
            throw new Error('Bamboo 502');
          },
        }) as unknown as BambooPort,
    });
    await broken.tick();
    expect(broken.store.getStep(broken.run.id, 'demo.wait')).toMatchObject({ status: 'failed', error: 'Деплой не закончился за 40 минут. Последняя проверка: Bamboo 502' });
  });

  it('keeps waiting before the deadline when a check fails', async () => {
    const t = await waitingOn({ kind: 'deploy', contour: 'cloud', resultId: 42, ...due(MINUTE) }, {
      bamboo: () =>
        ({
          deployResult: async () => {
            throw new Error('Bamboo 502');
          },
        }) as unknown as BambooPort,
    });
    await t.tick();
    expect(t.store.getStep(t.run.id, 'demo.wait')?.status).toBe('waiting');
  });

  it('checks builds and deployments on the fast interval and pull requests on the usual one', async () => {
    let builds = 0;
    const bamboo = {
      builds: async () => {
        builds += 1;
        return [];
      },
    } as unknown as BambooPort;
    const t0 = Date.now();
    const fast = await waitingOn({ kind: 'build', contour: 'cloud', planKey: 'P-1', revision: 'abc', ...due(MINUTE) }, { bamboo: () => bamboo }, [5 * MINUTE, 30_000]);
    await fast.tick(new Date(t0));
    await fast.tick(new Date(t0 + 30_000));
    expect(builds).toBe(2);
    let prs = 0;
    const scm = { ...fakeScm({ pr: pr() }), pullRequest: async () => (prs++, pr()) };
    const slow = await waitingOn({ kind: 'pr', scm: SCM, pr: 262 }, { scm }, [5 * MINUTE, 30_000]);
    await slow.tick(new Date(t0));
    await slow.tick(new Date(t0 + 30_000));
    expect(prs).toBe(1);
    await slow.tick(new Date(t0 + 5 * MINUTE));
    expect(prs).toBe(2);
  });

  it('does not go on with a wait whose step no longer waits: skipped or repeated', async () => {
    let builds = 0;
    const bamboo = {
      builds: async () => {
        builds += 1;
        return [];
      },
    } as unknown as BambooPort;
    const t = await waitingOn({ kind: 'build', contour: 'cloud', planKey: 'P-1', revision: 'abc', ...due(MINUTE) }, { bamboo: () => bamboo });
    await t.engine.skip(t.run.id, 'demo.wait');
    expect(t.store.getContext(t.run.id)).not.toHaveProperty('waiting');
    await t.tick();
    expect(builds).toBe(0);
    expect(t.state.resumed).toBe(0);
  });
});

describe('watcher and background steps', () => {
  it('goes on with the chain waiting for the merge while a background step still runs', async () => {
    const state = { pr: pr() };
    let release!: () => void;
    const wiki = new Promise<void>((resolve) => (release = resolve));
    const cat = new FakeCatalog()
      .add(manifest('b.wiki', { background: true }), {
        async run() {
          await wiki;
          return {};
        },
      })
      .add(manifest('task.finish'), {
        async run() {
          if (state.pr.state !== 'MERGED') throw new StepWaiting('Жду мерж PR #262', { kind: 'pr', scm: SCM, pr: 262 });
          return { merged: { pr: 262, at: '2026-09-25T10:00:00.000Z' } };
        },
      })
      .addPreset(['b.wiki', 'task.finish']);
    const jira = fakeJira({ 'TEAM-1': issue('TEAM-1', { status: 'Ready to Review', updated: '2026-09-23T10:00:00.000+0300' }) });
    const deps = makeEngine(cat, [], jira.port);
    const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
    deps.store.setContext(run.id, 'issue', await jira.port.getIssue('TEAM-1'), null);
    await deps.engine.start(run.id);
    const step = (id: string) => deps.store.getStep(run.id, id)?.status;
    expect([step('b.wiki'), step('task.finish'), deps.store.getRun(run.id)?.status]).toEqual(['running', 'waiting', 'running']);
    const watcher = new Watcher({ store: deps.store, engine: deps.engine, bus: deps.bus, ports: { ...NO_PORTS, jira: jira.port, scm: fakeScm(state) }, profiles: PROFILES, jira: () => BOARD, redact: deps.redact }, 0);
    state.pr = pr({ state: 'MERGED' });
    await watcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([step('task.finish'), step('b.wiki')]).toEqual(['succeeded', 'running']);
    release();
    await deps.engine.settled(run.id);
    expect(deps.store.getRun(run.id)?.status).toBe('completed');
  });
});
