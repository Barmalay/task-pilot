import { afterEach, describe, expect, it } from 'vitest';
import type { JiraConfig, JiraPort, Transition } from '@task-pilot/step-kit';
import { buildServer } from '../src/http/server.ts';
import { TaskService, transitionTarget } from '../src/tasks.ts';
import { fakeJira, FakeCatalog, issue, makeEngine, manifest, PROFILES } from './helpers.ts';

const LOCAL = { host: 'localhost:5176', 'x-task-pilot': '1' };

/** Сервер с доской, на которой задаче доступны заданные переходы; перевод записывается в moves. */
function board(transitions: Transition[]) {
  const moves: string[] = [];
  const jira: JiraPort = {
    ...fakeJira({ 'TEAM-7': issue('TEAM-7'), 'TEAM-8': issue('TEAM-8') }).port,
    async getTransitions() {
      return transitions;
    },
    async transition(key, id) {
      moves.push(`${key}:${id}`);
    },
  };
  const catalog = new FakeCatalog()
    .add(manifest('jira.start'), {
      async run() {
        return {};
      },
    })
    .addPreset(['jira.start']);
  const deps = makeEngine(catalog, [], jira);
  const server = buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), ...deps });
  return { server, moves, deps };
}

let current: ReturnType<typeof board>['server'] | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('target status of a board transition', () => {
  const jira: JiraConfig = { ...PROFILES.jira, path: [{ from: 'Open', id: '4', name: 'Start Progress', to: 'In Progress' }], after: ['Monitoring'], offPath: ['Closed', 'Прием'] };

  it('takes the status reported by REST Jira first', () => {
    expect(transitionTarget({ id: '4', name: 'Start Progress', to: 'In Review' }, jira)).toBe('In Review');
  });

  it('finds the status of a transition from mcp-atlassian on the board path by its id', () => {
    expect(transitionTarget({ id: '4', name: 'Начать' }, jira)).toBe('In Progress');
  });

  it('matches a transition off the path by its name, ignoring case and е with dots', () => {
    expect(transitionTarget({ id: '1001', name: 'closed' }, jira)).toBe('Closed');
    expect(transitionTarget({ id: '1111', name: 'Monitoring' }, jira)).toBe('Monitoring');
    expect(transitionTarget({ id: '1201', name: 'ПРИЁМ' }, jira)).toBe('Прием');
  });

  it('gives null when the status of a transition is unknown', () => {
    expect(transitionTarget({ id: '991', name: 'Хочу починить' }, jira)).toBeNull();
  });
});

describe('moving a task on the board', () => {
  it('lists the transitions of a task with the columns they lead to', async () => {
    current = board([{ id: '4', name: 'Start Progress' }, { id: '991', name: 'Хочу починить' }]).server;
    const r = await current.inject({ method: 'GET', url: '/api/tasks/team-7/transitions', headers: LOCAL });
    expect(r.json()).toEqual([
      { id: '4', name: 'Start Progress', to: 'In Progress' },
      { id: '991', name: 'Хочу починить', to: null },
    ]);
  });

  it('moves the task with the transition the owner dropped it on', async () => {
    const b = board([{ id: '4', name: 'Start Progress', to: 'In Progress' }]);
    current = b.server;
    const r = await current.inject({ method: 'POST', url: '/api/tasks/TEAM-7/transition', headers: LOCAL, payload: { transitionId: '4' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ to: 'In Progress' });
    expect(b.moves).toEqual(['TEAM-7:4']);
  });

  it('refuses a transition the task no longer has, for example after someone moved it meanwhile', async () => {
    const b = board([{ id: '971', name: 'Готово к ревью', to: 'Ready to Review' }]);
    current = b.server;
    const r = await current.inject({ method: 'POST', url: '/api/tasks/TEAM-7/transition', headers: LOCAL, payload: { transitionId: '4' } });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error_description: string }).error_description).toContain('сейчас недоступен');
    expect(b.moves).toEqual([]);
  });

  it('requires the x-task-pilot header and a valid task key to move a task', async () => {
    const b = board([{ id: '4', name: 'Start Progress' }]);
    current = b.server;
    const noHeader = await current.inject({ method: 'POST', url: '/api/tasks/TEAM-7/transition', headers: { host: 'localhost:5176' }, payload: { transitionId: '4' } });
    expect(noHeader.statusCode).toBe(403);
    const badKey = await current.inject({ method: 'POST', url: '/api/tasks/not-a-key/transition', headers: LOCAL, payload: { transitionId: '4' } });
    expect(badKey.statusCode).toBe(400);
    expect(b.moves).toEqual([]);
  });
});

describe('runs of one task', () => {
  it('lists only the runs of the requested task, newest first', async () => {
    const b = board([]);
    current = b.server;
    const first = b.deps.engine.createRun({ issueKey: 'TEAM-7' });
    b.deps.engine.createRun({ issueKey: 'TEAM-8' });
    // created_at сравнивается строкой: второй прогон той же задачи заводится заметно позже первого.
    await new Promise((r) => setTimeout(r, 5));
    const second = b.deps.engine.createRun({ issueKey: 'TEAM-7' });
    const r = await current.inject({ method: 'GET', url: '/api/runs?issue=team-7', headers: LOCAL });
    expect((r.json() as { id: string; issueKey: string }[]).map((x) => [x.id, x.issueKey])).toEqual([
      [second.id, 'TEAM-7'],
      [first.id, 'TEAM-7'],
    ]);
    const all = await current.inject({ method: 'GET', url: '/api/runs', headers: LOCAL });
    expect((all.json() as unknown[]).length).toBe(3);
    const bad = await current.inject({ method: 'GET', url: '/api/runs?issue=1%20OR%201', headers: LOCAL });
    expect(bad.statusCode).toBe(400);
  });
});
