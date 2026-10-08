import { describe, expect, it } from 'vitest';
import { memoryJiraFiles } from '../../apps/server/src/demo/jira-files.ts';
import type { Issue, JiraPort } from '../../packages/step-kit/src/index.ts';
import { TEST_JIRA, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

type Flow = Record<string, { id: string; name: string; to: string }[]>;

const FLOW: Flow = {
  Open: [
    { id: '4', name: 'Start Progress', to: 'In Progress' },
    { id: '1001', name: 'Closed', to: 'Closed' },
  ],
  'In Progress': [{ id: '971', name: 'Готово к ревью', to: 'Ready to Review' }],
};

function fakeJira(initial: { status: string; assignee: string | null }, flow: Flow = FLOW) {
  const state = { ...initial, calls: [] as string[] };
  const port: JiraPort = {
    async search() {
      return [];
    },
    async getIssue(key): Promise<Issue> {
      return {
        key,
        summary: 'Метрика',
        status: state.status,
        url: '',
        assignee: state.assignee ? { name: state.assignee, displayName: state.assignee } : null,
        labels: [],
        components: [],
        sprint: null,
        description: '',
      };
    },
    async sprints() {
      return [];
    },
    async getTransitions() {
      return (flow[state.status] ?? []).map(({ id, name }) => ({ id, name }));
    },
    async transition(_key, id) {
      const t = (flow[state.status] ?? []).find((x) => x.id === id);
      if (!t) throw new Error(`нет перехода ${id}`);
      state.calls.push(`transition:${id}`);
      state.status = t.to;
    },
    async assign(_key, user) {
      state.calls.push(`assign:${user}`);
      state.assignee = user;
    },
    ...memoryJiraFiles().port,
  };
  return { port, state };
}

function ctx(port: JiraPort, params: Record<string, unknown> = {}) {
  return testContext({ issueKey: 'TEAM-1', repo: testRepo('/tmp/none', '/tmp/wt'), params, ports: { jira: port, git: {} as never, shell: {} as never, scm: {} as never } });
}

describe('jira.start', () => {
  it('is already done when the issue is in progress and assigned to the owner', async () => {
    const { port } = fakeJira({ status: 'In Progress', assignee: 'owner' });
    expect(await step.done!(ctx(port))).toMatchObject({ outputs: { status: 'In Progress' } });
  });

  it('is already done when the issue is further on the board, without moving it back', async () => {
    const { port } = fakeJira({ status: 'Ready to Review', assignee: 'owner' });
    expect(await step.done!(ctx(port))).not.toBeNull();
  });

  it('asks to assign and to move an unassigned open issue', async () => {
    const { port } = fakeJira({ status: 'Open', assignee: null });
    const p = await step.preview!(ctx(port));
    expect(p.actions).toEqual(['Назначить задачу на вас', 'Open → In Progress: переход "Start Progress"']);
    expect(p.requiresApproval).toBeUndefined();
    expect(p.payload).toEqual({ key: 'TEAM-1', from: 'Open', assign: true, transitions: ['4'] });
  });

  it('shows the current assignee when the issue has to be reassigned', async () => {
    const { port } = fakeJira({ status: 'In Progress', assignee: 'colleague' });
    expect(await step.done!(ctx(port))).toBeNull();
    const p = await step.preview!(ctx(port));
    expect(p.actions[0]).toContain('colleague');
  });

  it('assigns the issue, applies the transition and verifies the new status', async () => {
    const { port, state } = fakeJira({ status: 'Open', assignee: null });
    expect(await step.run(ctx(port))).toEqual({ status: 'In Progress' });
    expect(state.calls).toEqual(['assign:owner', 'transition:4']);
  });

  it('fails with a clear message when the transition is not available', async () => {
    const { port } = fakeJira({ status: 'Open', assignee: 'owner' }, { Open: [{ id: '1001', name: 'Closed', to: 'Closed' }] });
    await expect(step.run(ctx(port))).rejects.toThrow('недоступен');
  });

  it('refuses to take the issue when the Jira login is set neither in personal settings nor by a token', async () => {
    const { port, state } = fakeJira({ status: 'Open', assignee: null });
    const c = testContext({ issueKey: 'TEAM-1', repo: testRepo('/tmp/none', '/tmp/wt'), jira: { ...TEST_JIRA, me: '' }, ports: { jira: port } });
    await expect(step.preview!(c)).rejects.toThrow('Логин Jira не задан: укажите me в личных настройках ~/.task-pilot/profile.yaml');
    await expect(step.run(c)).rejects.toThrow('Логин Jira не задан');
    expect(state.calls).toEqual([]);
  });

  it('only assigns the issue when the move is switched off in the step settings, and a dry run gives no status', async () => {
    const { port, state } = fakeJira({ status: 'Open', assignee: null });
    const p = await step.preview!(ctx(port, { moveTo: 'none' }));
    expect(p.actions).toEqual(['Назначить задачу на вас', 'Jira: задача остается в статусе Open, перевод по доске выключен в настройках шага']);
    expect(p.payload).toMatchObject({ transitions: [] });
    expect(await step.run(ctx(port, { moveTo: 'none' }))).toEqual({ status: 'Open' });
    expect(state.calls).toEqual(['assign:owner']);
    expect(await step.simulate!(ctx(port, { moveTo: 'none' }))).toEqual({});
    // Назначенная задача с выключенным переводом уже сделана, где бы она ни стояла.
    expect(await step.done!(ctx(port, { moveTo: 'none' }))).toMatchObject({ note: 'Задача назначена на вас, перевод по доске выключен в настройках шага' });
  });

  it('moves the issue to the status chosen in the step settings instead of the milestone', async () => {
    const { port, state } = fakeJira({ status: 'Open', assignee: 'owner' });
    const p = await step.preview!(ctx(port, { moveTo: 'Ready to Review' }));
    expect(p.actions).toEqual(['Open → In Progress: переход "Start Progress"', 'In Progress → Ready to Review: переход "Готово к ревью"']);
    expect(await step.run(ctx(port, { moveTo: 'Ready to Review' }))).toEqual({ status: 'Ready to Review' });
    expect(state.calls).toEqual(['transition:4', 'transition:971']);
  });

  it('refuses to move an issue that is off the main path', async () => {
    const { port } = fakeJira({ status: 'Waiting', assignee: 'owner' });
    await expect(step.preview!(ctx(port))).rejects.toThrow('вне основного пути');
  });
});
