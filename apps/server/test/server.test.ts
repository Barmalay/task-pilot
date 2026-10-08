import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountDto, AttentionDto, CatalogDto, DoctorCheckDto, DoctorDto, EventDto, IntegrationDto, IntegrationsDto, ProfileDto, RunViewDto, TasksDto } from '@task-pilot/api-types';
import { noticeable, settles } from '../src/http/routes/events.ts';
import { buildServer, notable } from '../src/http/server.ts';
import { TaskService } from '../src/tasks.ts';
import { fakeJira, FakeCatalog, issue, makeEngine, manifest, PROFILES } from './helpers.ts';

/** Сервер на подменной Jira с задачами TEAM-7 и TEAM-8; extra - задачи конкретного теста. */
function app(extra: Record<string, ReturnType<typeof issue>> = {}, profile?: () => ProfileDto) {
  const catalog = new FakeCatalog()
    .add(manifest('jira.start', { requires: ['issue'], params: { moveTo: { type: 'jiraStatus', label: 'Куда перевести задачу', milestone: 'inProgress' } } }), {
      async run() {
        return {};
      },
    })
    .add(manifest('pilot.new-step', { requires: ['stepRequest'], gate: 'before' }), {
      async preview(c) {
        return { title: 'Новый шаг', actions: [], payload: c.get('stepRequest') };
      },
      async run() {
        return {};
      },
    })
    .addPreset(['jira.start'])
    .addPreset(['jira.start'], ['jira.start'], 'quiet')
    .addPreset(['pilot.new-step'], [], 'new-step');
  const jira = fakeJira({
    'TEAM-7': issue('TEAM-7', { components: ['keycloak'] }),
    'TEAM-8': issue('TEAM-8', { components: ['api'], labels: ['skip_ac'] }),
    ...extra,
  });
  const deps = makeEngine(catalog, [], jira.port);
  const tasks = new TaskService({ ...deps, profiles: PROFILES });
  const server = buildServer({ profiles: PROFILES, catalog, tasks, ...deps, ...(profile ? { profile } : {}) });
  return { server, deps, searches: jira.searches };
}

const LOCAL = { host: 'localhost:5176', 'x-task-pilot': '1' };
let current: ReturnType<typeof app>['server'] | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function open(key: string, url = `/api/tasks/${key}/open`) {
  const r = await current!.inject({ method: 'POST', url, headers: LOCAL, payload: url === '/api/runs' ? { issueKey: key } : {} });
  return r;
}

describe('HTTP API', () => {
  it('rejects mutations without the x-task-pilot header', async () => {
    current = app().server;
    const r = await current.inject({ method: 'POST', url: '/api/runs', headers: { host: 'localhost:5176' }, payload: { issueKey: 'TEAM-7' } });
    expect(r.statusCode).toBe(403);
  });

  it('rejects requests coming from a foreign page', async () => {
    current = app().server;
    const r = await current.inject({ method: 'POST', url: '/api/runs', headers: { ...LOCAL, origin: 'https://evil.example' }, payload: { issueKey: 'TEAM-7' } });
    expect(r.statusCode).toBe(403);
  });

  it('refuses every request from the QA browser so its agent cannot use the interface', async () => {
    current = app().server;
    const ua = 'Mozilla/5.0 (Macintosh) Chrome/154.0.0.0 Safari/537.36 TaskPilotQA';
    for (const [method, url] of [['GET', '/api/health'], ['POST', '/api/approvals/x']] as const) {
      const r = await current.inject({ method, url, headers: { ...LOCAL, 'user-agent': ua }, payload: method === 'POST' ? { decision: 'approve' } : undefined });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error_description: 'Из QA-браузера Task Pilot недоступен' });
    }
  });

  it('rejects a non-local Host header to stop DNS rebinding', async () => {
    current = app().server;
    const r = await current.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:5176' } });
    expect(r.statusCode).toBe(403);
  });

  it('opens a task without running anything: loads the issue, criteria and picks the repository by component', async () => {
    current = app().server;
    const r = await open('team-7');
    expect(r.statusCode).toBe(200);
    const { id, created } = r.json() as { id: string; created: boolean };
    expect(created).toBe(true);
    const view = (await current.inject({ method: 'GET', url: `/api/runs/${id}`, headers: LOCAL })).json();
    expect(view).toMatchObject({
      run: { issueKey: 'TEAM-7', repoId: 'demo', status: 'idle' },
      steps: [{ stepId: 'jira.start', status: 'pending' }],
      context: { ac: ['первый', 'второй'], issue: { key: 'TEAM-7', components: ['keycloak'] }, repoChoice: { repoId: 'demo', reason: 'по компоненту keycloak' } },
    });
  });

  it('gives the signs of the steps from their manifests in the run and in the catalog', async () => {
    const catalog = new FakeCatalog()
      .add(manifest('jira.start', { requires: ['issue'] }), { run: async () => ({}) })
      .add(manifest('qa.check', { kind: 'agent', agent: { browser: true }, refresh: ['artifacts'], loop: { restart: ['jira.start'], max: 2, title: 'по тесту' }, trigger: { event: 'issue.changed', auto: false } }), {
        run: async () => ({}),
      })
      .add(manifest('wiki.page', { background: true }), { run: async () => ({}) })
      .addPreset(['jira.start', 'qa.check', 'wiki.page']);
    const deps = makeEngine(catalog, [], fakeJira({ 'TEAM-7': issue('TEAM-7', { components: ['keycloak'] }) }).port);
    current = buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), ...deps });
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const none = { browser: false, refresh: [], loopTitle: null, trigger: null, background: false };
    const signs = { browser: true, refresh: ['artifacts'], loopTitle: 'по тесту', trigger: { event: 'issue.changed', auto: false }, background: false };
    const view = (await current.inject({ method: 'GET', url: `/api/runs/${id}`, headers: LOCAL })).json() as RunViewDto;
    expect(view.steps).toMatchObject([{ stepId: 'jira.start', ...none }, { stepId: 'qa.check', ...signs }, { stepId: 'wiki.page', ...none, background: true }]);
    expect(view).toMatchObject({ approval: null, approvals: [] });
    const steps = ((await current.inject({ method: 'GET', url: '/api/catalog', headers: LOCAL })).json() as CatalogDto).steps;
    expect(steps).toMatchObject([{ id: 'jira.start', ...none }, { id: 'qa.check', ...signs }, { id: 'wiki.page', ...none, background: true }]);
  });

  it('lists every pending approval of a run, the first one first, when the chain step and a background step wait for the owner', async () => {
    // Шаг цепочки просит подтверждение позже фонового: список идет от ранних запросов к поздним.
    const gated = (title: string, delayMs: number) => ({
      async preview() {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { title, actions: [title], payload: {} };
      },
      run: async () => ({}),
    });
    const catalog = new FakeCatalog()
      .add(manifest('wiki.page', { background: true, gate: 'publish' }), gated('Опубликовать страницу', 0))
      .add(manifest('jira.move', { gate: 'publish' }), gated('Перевести задачу', 20))
      .addPreset(['wiki.page', 'jira.move']);
    const deps = makeEngine(catalog, [], fakeJira({ 'TEAM-7': issue('TEAM-7', { components: ['keycloak'] }) }).port);
    current = buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), ...deps });
    const { id } = (await open('TEAM-7')).json() as { id: string };
    await deps.engine.start(id);
    await deps.engine.settled(id);
    const view = (await current.inject({ method: 'GET', url: `/api/runs/${id}`, headers: LOCAL })).json() as RunViewDto;
    expect(view.run.status).toBe('waiting_owner');
    expect(view.approvals.map((a) => [a.stepId, a.preview.title])).toEqual([
      ['wiki.page', 'Опубликовать страницу'],
      ['jira.move', 'Перевести задачу'],
    ]);
    expect(view.approval?.id).toBe(view.approvals[0]!.id);
  });

  it('opens a task whose repository the issue does not suggest with the default one and does not start it until the owner picks', async () => {
    current = app({ 'TEAM-9': issue('TEAM-9', { components: ['web-front'], labels: ['frontend'] }) }).server;
    const { id } = (await open('TEAM-9')).json() as { id: string };
    const view = (await current.inject({ method: 'GET', url: `/api/runs/${id}`, headers: LOCAL })).json();
    expect(view).toMatchObject({
      run: { repoId: 'demo' },
      context: { repoChoice: { repoId: 'demo', reason: 'не определен по задаче: у компонента web-front нет профиля репозитория', candidates: [], unsure: true } },
    });
    const refused = await current.inject({ method: 'POST', url: `/api/runs/${id}/start`, headers: LOCAL, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error_description: 'Репозиторий не определился по задаче: выберите его в карточке прогона или оставьте выбранный' });
    const kept = await current.inject({ method: 'PATCH', url: `/api/runs/${id}`, headers: LOCAL, payload: { repoId: 'demo' } });
    expect(kept.json()).toMatchObject({ context: { repoChoice: { repoId: 'demo', reason: 'владельцем' } } });
    expect((await current.inject({ method: 'POST', url: `/api/runs/${id}/start`, headers: LOCAL, payload: {} })).statusCode).toBe(200);
  });

  it('forecasts a run by the history and shows on the task card how much of a started run is done', async () => {
    const a = app();
    current = a.server;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const forecast = await current.inject({ method: 'GET', url: `/api/runs/${id}/forecast`, headers: LOCAL });
    expect(forecast.json()).toMatchObject({ basis: 0, totalMs: 30_000, percent: 0, steps: [{ stepId: 'jira.start', expectedMs: 30_000, runs: 0 }], initial: null });
    expect((await current.inject({ method: 'GET', url: '/api/runs/no-such-run/forecast', headers: LOCAL })).statusCode).toBe(404);
    const card = async () => ((await current!.inject({ method: 'GET', url: '/api/tasks', headers: LOCAL })).json() as TasksDto).tasks.find((t) => t.key === 'TEAM-7');
    expect((await card())?.progress).toBeNull();
    a.deps.store.updateRun(id, { status: 'paused' });
    expect((await card())?.progress).toEqual({ percent: 0, remainingMs: 30_000 });
  });

  it('opens the latest run of a task instead of creating another one', async () => {
    current = app().server;
    const first = (await open('TEAM-7')).json() as { id: string };
    const again = (await open('TEAM-7')).json() as { id: string; created: boolean };
    expect(again).toEqual({ id: first.id, created: false });
    const fresh = (await open('TEAM-7', '/api/runs')).json() as { id: string };
    expect(fresh.id).not.toBe(first.id);
  });

  it('changes the preset of the open run instead of creating another run', async () => {
    current = app().server;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const r = await current.inject({ method: 'PATCH', url: `/api/runs/${id}`, headers: LOCAL, payload: { presetId: 'quiet' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ run: { id, presetId: 'quiet' }, steps: [{ stepId: 'jira.start', selected: false }] });
    const runs = (await current.inject({ method: 'GET', url: '/api/runs?issue=TEAM-7', headers: LOCAL })).json() as { id: string }[];
    expect(runs.map((x) => x.id)).toEqual([id]);
  });

  it('deletes a run on request and answers not found for it afterwards', async () => {
    current = app().server;
    const first = (await open('TEAM-7')).json() as { id: string };
    const second = (await open('TEAM-7', '/api/runs')).json() as { id: string };
    const forbidden = await current.inject({ method: 'DELETE', url: `/api/runs/${second.id}`, headers: { host: 'localhost:5176' } });
    expect(forbidden.statusCode).toBe(403);
    const r = await current.inject({ method: 'DELETE', url: `/api/runs/${second.id}`, headers: LOCAL });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ next: first.id });
    expect((await current.inject({ method: 'GET', url: `/api/runs/${second.id}`, headers: LOCAL })).statusCode).toBe(404);
    const runs = (await current.inject({ method: 'GET', url: '/api/runs?issue=TEAM-7', headers: LOCAL })).json() as { id: string }[];
    expect(runs.map((x) => x.id)).toEqual([first.id]);
  });

  it('keeps the right repository for a task of a contour that is not connected and honours skip_ac', async () => {
    current = app().server;
    const { id } = (await open('TEAM-8')).json() as { id: string };
    const view = (await current.inject({ method: 'GET', url: `/api/runs/${id}`, headers: LOCAL })).json() as { run: { repoId: string }; context: { ac: unknown } };
    expect(view.run.repoId).toBe('api-auth');
    expect(view.context.ac).toEqual([]);
  });

  it('answers with the Jira error when the task does not exist', async () => {
    current = app().server;
    const r = await open('TEAM-404');
    expect(r.statusCode).toBe(500);
    expect((r.json() as { error_description: string }).error_description).toContain('не найдена');
  });

  it('builds the sprint filter and lists board sprints', async () => {
    const built = app();
    current = built.server;
    await current.inject({ method: 'GET', url: '/api/tasks?scope=sprint&sprint=4911&mine=0&hideDone=1', headers: LOCAL });
    await current.inject({ method: 'GET', url: '/api/tasks', headers: LOCAL });
    expect(built.searches).toEqual(['sprint = 4911 AND statusCategory != Done ORDER BY updated DESC', 'assignee = currentUser()']);
    const sprints = await current.inject({ method: 'GET', url: '/api/sprints', headers: LOCAL });
    expect((sprints.json() as { id: number }[]).map((s) => s.id)).toEqual([4911, 4314]);
  });

  it('takes a note to the agent with a retry, refuses a foreign field and a note to a step without an agent', async () => {
    current = app().server;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const retry = (payload?: object) => current!.inject({ method: 'POST', url: `/api/runs/${id}/steps/jira.start/retry`, headers: LOCAL, ...(payload ? { payload } : {}) });
    expect((await retry({ note: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await retry({ comment: 'другое поле' })).statusCode).toBe(400);
    // "В работу" - шаг без агента: замечание передать некому.
    const refused = await retry({ note: 'сделай иначе' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error_description: expect.stringContaining('У шага нет агента') });
    expect((await retry()).statusCode).toBe(200);
  });

  it('changes a setting of a step in the run, returns it to the default and refuses a value that is not on the board', async () => {
    current = app().server;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const patch = (payload: object) => current!.inject({ method: 'PATCH', url: `/api/runs/${id}/steps/jira.start/params`, headers: LOCAL, payload });
    const moveOf = (r: { json: () => unknown }) => (r.json() as RunViewDto).steps.find((s) => s.stepId === 'jira.start')?.settings[0];
    const off = await patch({ params: { moveTo: 'none' } });
    expect(off.statusCode).toBe(200);
    expect(moveOf(off)).toMatchObject({ key: 'moveTo', value: 'none', source: 'run' });
    expect((await patch({ params: { moveTo: 'Closed' } })).statusCode).toBe(400);
    expect((await patch({ moveTo: 'none' })).statusCode).toBe(400);
    expect(moveOf(await patch({ params: { moveTo: null } }))).toMatchObject({ value: '', source: 'manifest' });
    // Каталог дает редактору пресетов те же варианты: как обычно, не переводить и статусы доски.
    const catalog = (await current!.inject({ method: 'GET', url: '/api/catalog', headers: LOCAL })).json() as CatalogDto;
    expect(catalog.steps.find((s) => s.id === 'jira.start')?.settings[0]?.options.map((o) => o.value)).toEqual(['', 'none', 'Open', 'In Progress']);
  });

  it('rejects a malformed sprint id', async () => {
    current = app().server;
    const r = await current.inject({ method: 'GET', url: '/api/tasks?scope=sprint&sprint=1%20OR%201%3D1', headers: LOCAL });
    expect(r.statusCode).toBe(400);
  });

  it('answers 400 with a readable message for an invalid body', async () => {
    current = app().server;
    const r = await current.inject({ method: 'POST', url: '/api/runs', headers: LOCAL, payload: { issueKey: 5 } });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error_description: string }).error_description).toContain('issueKey');
  });

  it('closes quickly even with an open event stream', async () => {
    current = app().server;
    await current.listen({ host: '127.0.0.1', port: 0 });
    const address = current.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/${id}/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const started = Date.now();
    await current.close();
    current = undefined;
    controller.abort();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('sends to the common stream the run events the owner is notified about', () => {
    const e = (type: string, data: unknown = null, runId: string | null = 'r1') => ({ runId, type, data });
    expect(['approval.requested', 'question.asked', 'ask.answered', 'pr.merged', 'pr.review', 'issue.changed'].map((t) => notable(e(t)))).toEqual([true, true, true, true, true, true]);
    expect(notable(e('run.status', { status: 'failed' }))).toBe(true);
    expect(notable(e('run.status', { status: 'completed' }))).toBe(true);
    expect(notable(e('run.status', { status: 'running' }))).toBe(false);
    expect(notable(e('step.log'))).toBe(false);
    expect(notable(e('approval.requested', null, null))).toBe(false);
  });

  it('sends to the common stream what settles an approval or a question too, so the header knows what still waits for the owner', () => {
    const e = (type: string, runId: string | null = 'r1') => ({ runId, type });
    expect(['approval.decided', 'approval.stale', 'question.answered', 'question.expired'].map((t) => settles(e(t)))).toEqual([true, true, true, true]);
    expect(settles(e('approval.decided', null))).toBe(false);
    expect(settles(e('step.status'))).toBe(false);
  });

  it('counts as a notice every run event the owner is notified about and a firing alert of monitoring, not a cleared one', () => {
    expect(noticeable({ runId: 'r1', type: 'question.asked', data: null })).toBe(true);
    expect(noticeable({ runId: 'r1', type: 'run.status', data: { status: 'running' } })).toBe(false);
    expect(noticeable({ runId: null, type: 'monitor.alert', data: { state: 'firing', dashboard: 'd1' } })).toBe(true);
    expect(noticeable({ runId: null, type: 'monitor.alert', data: { state: 'ok', dashboard: 'd1' } })).toBe(false);
    expect(noticeable({ runId: null, type: 'catalog.updated', data: null })).toBe(false);
  });

  it('gives the history of notices newest first with the key of the task, finding an old one behind many status changes', async () => {
    const a = app();
    current = a.server;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const { store } = a.deps;
    const old = store.addEvent({ runId: id, stepId: 'jira.start', type: 'question.asked', message: 'Какой стенд взять?' });
    // Смен статуса прогона больше, чем история читает за раз: старое уведомление лежит за ними.
    for (let i = 0; i < 600; i++) store.addEvent({ runId: id, type: 'run.status', data: { status: i % 2 ? 'running' : 'waiting' } });
    store.addEvent({ runId: id, type: 'step.log', message: 'строка сборки' });
    const done = store.addEvent({ runId: id, type: 'run.status', data: { status: 'completed' } });
    const alert = store.addEvent({ type: 'monitor.alert', message: 'Алерт: доля ошибок', data: { state: 'firing', dashboard: 'team-1' } });
    store.addEvent({ type: 'monitor.alert', message: 'Алерт снят: доля ошибок', data: { state: 'ok', dashboard: 'team-1' } });

    const all = (await current.inject({ method: 'GET', url: '/api/notifications', headers: LOCAL })).json() as EventDto[];
    expect(all.map((e) => [e.id, e.type, e.issueKey ?? null])).toEqual([
      [alert.id, 'monitor.alert', null],
      [done.id, 'run.status', 'TEAM-7'],
      [old.id, 'question.asked', 'TEAM-7'],
    ]);
    const two = (await current.inject({ method: 'GET', url: '/api/notifications?limit=2', headers: LOCAL })).json() as EventDto[];
    expect(two.map((e) => e.id)).toEqual([alert.id, done.id]);
    expect((await current.inject({ method: 'GET', url: '/api/notifications?limit=0', headers: LOCAL })).statusCode).toBe(400);
  });

  it('lists what waits for the owner in every run: pending approvals and open questions of agents, earliest first, and drops what is settled', async () => {
    const a = app();
    current = a.server;
    const first = (await open('TEAM-7')).json() as { id: string };
    const second = (await open('TEAM-8')).json() as { id: string };
    const { store } = a.deps;
    const approval = store.createApproval({ runId: first.id, stepId: 'jira.start', payloadHash: 'h1', preview: { title: 'TEAM-7: в работу', actions: [], payload: {} } });
    const question = store.createQuestion({ runId: second.id, stepId: 'pilot.new-step', sessionId: null, question: 'Как делить на ноль?', options: [] });

    const list = async () => (await current!.inject({ method: 'GET', url: '/api/attention', headers: LOCAL })).json() as AttentionDto[];
    expect(await list()).toEqual([
      { runId: first.id, issueKey: 'TEAM-7', kind: 'approval', step: 'jira.start', text: 'TEAM-7: в работу', at: approval.createdAt },
      { runId: second.id, issueKey: 'TEAM-8', kind: 'question', step: 'pilot.new-step', text: 'Как делить на ноль?', at: question.createdAt },
    ]);
    store.updateApproval(approval.id, { status: 'approved' });
    store.answerQuestion(question.id, 'Ошибкой');
    expect(await list()).toEqual([]);
  });

  it('gives the profile of the team and the personal settings the server was given, and answers 404 without one', async () => {
    current = app().server;
    expect((await current.inject({ method: 'GET', url: '/api/me', headers: LOCAL })).statusCode).toBe(404);
    await current.close();
    const profile: ProfileDto = {
      team: { id: 'team', title: 'TEAM', dir: '~/team', company: null, board: null, statuses: ['Open'], skills: { qa: null, wiki: null }, wikiSpace: null, repos: [], stands: 0 },
      personal: { file: '~/.task-pilot/profile.yaml', exists: true, me: 'owner', javaHome: null, style: { yo: true, dash: false, quotes: false } },
    };
    current = app({}, () => profile).server;
    const r = await current.inject({ method: 'GET', url: '/api/me', headers: LOCAL });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(profile);
  });

  it('hides the found changes of a task by taking the task from Jira as the new snapshot, as rereading does', async () => {
    const a = app();
    current = a.server;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    a.deps.store.setContext(id, 'issue', issue('TEAM-7', { status: 'Open', description: 'старое описание' }), null);
    a.deps.store.setContext(id, 'issueChanged', { at: 'x', status: 'Open', changes: [{ kind: 'comments', text: 'новые комментарии: 1' }] }, null);
    const r = await current.inject({ method: 'POST', url: `/api/runs/${id}/issue-changes/dismiss`, headers: LOCAL });
    expect(r.statusCode).toBe(200);
    const dismissed = (r.json() as { context: Record<string, { description?: string } | undefined> }).context;
    expect(dismissed.issueChanged).toBeUndefined();
    expect(dismissed.issue?.description).toBe(issue('TEAM-7').description);
    a.deps.store.setContext(id, 'issueChanged', { at: 'x', status: 'Open', changes: [{ kind: 'comments', text: 'новые комментарии: 1' }] }, null);
    const refreshed = (await current.inject({ method: 'POST', url: `/api/runs/${id}/issue`, headers: LOCAL })).json() as { context: Record<string, unknown> };
    expect(refreshed.context.issueChanged).toBeUndefined();
  });

  it('opens a numbered run of the new step wizard without a Jira task and starts it at once', async () => {
    const a = app();
    current = a.server;
    const first = await current.inject({ method: 'POST', url: '/api/pilot/steps', headers: LOCAL, payload: { description: 'Шаг, который здоровается' } });
    const { id } = first.json() as { id: string };
    await a.deps.engine.start(id);
    expect(a.deps.engine.view(id)).toMatchObject({
      run: { issueKey: 'PILOT-1', presetId: 'new-step', standId: null, status: 'waiting_owner' },
      context: { stepRequest: { description: 'Шаг, который здоровается' } },
      approval: { stepId: 'pilot.new-step' },
    });
    const second = (await current.inject({ method: 'POST', url: '/api/pilot/steps', headers: LOCAL, payload: { description: 'Еще шаг' } })).json() as { id: string };
    expect(a.deps.engine.view(second.id).run.issueKey).toBe('PILOT-2');
    expect((await current.inject({ method: 'POST', url: '/api/pilot/steps', headers: LOCAL, payload: { description: '' } })).statusCode).toBe(400);
  });

  it('answers 404 for an unknown run', async () => {
    current = app().server;
    const r = await current.inject({ method: 'GET', url: '/api/runs/unknown', headers: LOCAL });
    expect(r.statusCode).toBe(404);
    expect((await current.inject({ method: 'GET', url: '/api/runs/unknown/timing', headers: LOCAL })).statusCode).toBe(404);
    expect((await current.inject({ method: 'GET', url: '/api/runs/unknown/journal', headers: LOCAL })).statusCode).toBe(404);
  });

  it('gives the time and the journal of a finished run and the history of runs with the features of their tasks', async () => {
    const a = app();
    current = a.server;
    const { id } = (await open('TEAM-7')).json() as { id: string };
    const idle = (await current.inject({ method: 'GET', url: `/api/runs/${id}/timing`, headers: LOCAL })).json() as { start: string | null };
    expect(idle.start).toBeNull();
    await a.deps.engine.start(id);
    const timing = (await current.inject({ method: 'GET', url: `/api/runs/${id}/timing`, headers: LOCAL })).json() as { start: string; end: string; live: boolean; wallMs: number };
    expect(timing.live).toBe(false);
    expect(Date.parse(timing.end)).toBeGreaterThanOrEqual(Date.parse(timing.start));
    const history = (await current.inject({ method: 'GET', url: '/api/timing?limit=5', headers: LOCAL })).json() as {
      run: { id: string; status: string };
      summary: string | null;
      timing: { wallMs: number; questions: number };
      features: { components: string[]; loops: number };
    }[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      run: { id, status: 'completed' },
      timing: { questions: 0 },
      features: { components: ['keycloak'], loops: 0 },
      journal: { failures: 0, reworks: 0, rejects: 0, loops: 0, denials: 0 },
    });
    expect((await current.inject({ method: 'GET', url: '/api/timing?limit=0', headers: LOCAL })).statusCode).toBe(400);
    a.deps.bus.emitEvent({ runId: id, stepId: 'jira.start', type: 'loop.restart', message: 'круг', data: { round: 1, max: 3, steps: [] } });
    const journal = (await current.inject({ method: 'GET', url: `/api/runs/${id}/journal`, headers: LOCAL })).json() as { loops: { stepId: string; round: number }[]; failures: unknown[] };
    expect(journal).toMatchObject({ loops: [{ stepId: 'jira.start', round: 1 }], failures: [] });
  });

  it('shows the accounts Task Pilot works under and masks secrets in their errors', async () => {
    const catalog = new FakeCatalog();
    const deps = makeEngine(catalog, ['s3cr3t-token-value'], fakeJira().port, {
      integrations: {
        async checkDefault() {
          throw new Error('401 для токена s3cr3t-token-value');
        },
      },
    });
    current = buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), ...deps });
    const r = await current.inject({ method: 'GET', url: '/api/account', headers: LOCAL });
    expect(r.statusCode).toBe(200);
    const account = r.json() as AccountDto;
    expect(account.jira).toMatchObject({ me: 'owner', active: { id: null, kind: 'default', active: true, check: { ok: false, error: '401 для токена ***' } } });
    expect(account.claude.active).toMatchObject({ id: null, label: 'Вход CLI claude', check: { ok: true, login: 'owner@example.org', name: 'Команда', detail: 'тариф team' } });
  });

  it('shows the spend of agents and changes its limits, refusing a wrong one', async () => {
    current = app().server;
    const got = await current.inject({ method: 'GET', url: '/api/budget', headers: LOCAL });
    expect(got.json()).toMatchObject({ day: { spentUsd: 0, limitUsd: 50, level: 'ok' }, week: { limitUsd: 200 }, level: 'ok' });
    const put = await current.inject({ method: 'PUT', url: '/api/budget', headers: LOCAL, payload: { dayUsd: 30, weekUsd: null } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ day: { limitUsd: 30 }, week: { limitUsd: null, level: 'ok' } });
    expect((await current.inject({ method: 'PUT', url: '/api/budget', headers: LOCAL, payload: { dayUsd: -1, weekUsd: 100 } })).statusCode).toBe(400);
    expect((await current.inject({ method: 'PUT', url: '/api/budget', headers: { host: 'localhost:5176' }, payload: { dayUsd: 1, weekUsd: 1 } })).statusCode).toBe(403);
    expect((await current.inject({ method: 'GET', url: '/api/budget', headers: LOCAL })).json()).toMatchObject({ day: { limitUsd: 30 } });
  });

  it('shows the cache of runs and clears a completed run, refusing a run that still needs its files', async () => {
    const a = app();
    current = a.server;
    const done = a.deps.store.createRun({ issueKey: 'TEAM-7', repoId: 'gate', standId: null, presetId: 'code-pr', dryRun: false }, [{ stepId: 'jira.start', selected: true }]);
    a.deps.store.updateRun(done.id, { status: 'completed' });
    const failed = a.deps.store.createRun({ issueKey: 'TEAM-8', repoId: 'gate', standId: null, presetId: 'code-pr', dryRun: false }, [{ stepId: 'jira.start', selected: true }]);
    a.deps.store.updateRun(failed.id, { status: 'failed' });
    for (const id of [done.id, failed.id]) {
      mkdirSync(join(a.deps.dataDir, 'runs', id), { recursive: true });
      writeFileSync(join(a.deps.dataDir, 'runs', id, 'commit-message.txt'), 'TEAM-7 update');
    }
    const got = await current.inject({ method: 'GET', url: '/api/cache', headers: LOCAL });
    expect(got.json()).toMatchObject({ runsBytes: 26, clearableBytes: 13, qa: { bytes: 0, running: false } });
    const refused = await current.inject({ method: 'POST', url: `/api/cache/runs/${failed.id}/clear`, headers: LOCAL });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error_description: 'Прогон TEAM-8 не завершен или выполняется: его файлы еще нужны шагам' });
    expect((await current.inject({ method: 'POST', url: '/api/cache/runs/no-such-run/clear', headers: LOCAL })).statusCode).toBe(404);
    expect((await current.inject({ method: 'POST', url: `/api/cache/runs/${done.id}/clear`, headers: { host: 'localhost:5176' } })).statusCode).toBe(403);
    const cleared = await current.inject({ method: 'POST', url: `/api/cache/runs/${done.id}/clear`, headers: LOCAL });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ runs: [{ runId: failed.id, bytes: 13, clearable: false }], runsBytes: 13, clearableBytes: 0 });
    expect((await current.inject({ method: 'POST', url: '/api/cache/runs/clear', headers: LOCAL })).json()).toMatchObject({ runsBytes: 13 });
    expect((await current.inject({ method: 'POST', url: '/api/cache/qa/clear', headers: LOCAL })).json()).toMatchObject({ qa: { bytes: 0 } });
  });

  it('reports the environment check of this machine with secrets masked', async () => {
    const catalog = new FakeCatalog();
    const deps = makeEngine(catalog, ['s3cr3t-token-value'], fakeJira().port);
    const checks: DoctorCheckDto[] = [{ id: 'mcp', title: 'MCP-серверы', level: 'warn', detail: 'сервер ответил s3cr3t-token-value', fix: null }];
    current = buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), ...deps, doctor: async () => checks });
    const r = await current.inject({ method: 'GET', url: '/api/doctor', headers: LOCAL });
    expect(r.statusCode).toBe(200);
    expect((r.json() as DoctorDto).checks).toEqual([{ ...checks[0], detail: 'сервер ответил ***' }]);
  });

  it('adds, switches and removes accounts of an integration and never answers with a token', async () => {
    const a = app();
    current = a.server;
    const post = (url: string, payload: unknown, headers: Record<string, string> = LOCAL) => current!.inject({ method: 'POST', url, headers, payload: payload as object });
    expect((await post('/api/integrations/jira/accounts', { token: 'tech-jira-token-1' }, { host: 'localhost:5176' })).statusCode).toBe(403);
    const added = await post('/api/integrations/jira/accounts', { token: 'tech-jira-token-1', label: 'Технический' });
    expect(added.statusCode).toBe(200);
    expect(added.body).not.toContain('tech-jira-token-1');
    const id = (added.json() as IntegrationDto).accounts[1]!.id!;
    expect((added.json() as IntegrationDto).accounts.map((x) => [x.label, x.active])).toEqual([
      ['Как обычно, из Claude Code', false],
      ['Технический', true],
    ]);
    const list = await current.inject({ method: 'GET', url: '/api/integrations', headers: LOCAL });
    expect(list.body).not.toContain('tech-jira-token-1');
    expect((list.json() as IntegrationsDto).integrations.map((i) => i.id)).toEqual(['jira', 'confluence', 'stands-kibana', 'claude']);
    const back = await current.inject({ method: 'PATCH', url: '/api/integrations/jira', headers: LOCAL, payload: { active: null } });
    expect((back.json() as IntegrationDto).accounts[0]!.active).toBe(true);
    const removed = await current.inject({ method: 'DELETE', url: `/api/integrations/jira/accounts/${id}`, headers: LOCAL });
    expect((removed.json() as IntegrationDto).accounts).toHaveLength(1);
    expect((await post('/api/integrations/nope/check', {})).statusCode).toBe(404);
    expect((await post('/api/integrations/jira/accounts', { token: 'x', extra: 1 })).statusCode).toBe(400);
    expect((await current.inject({ method: 'PATCH', url: '/api/integrations/jira', headers: LOCAL, payload: { active: 'nope' } })).statusCode).toBe(404);
  });

  it('runs a claude login through the browser from the integrations screen, takes the code and cancels', async () => {
    current = app().server;
    const started = await current.inject({ method: 'POST', url: '/api/integrations/claude/logins', headers: LOCAL, payload: { email: 'second@example.org' } });
    expect(started.statusCode).toBe(200);
    const login = (started.json() as IntegrationDto).logins[0]!;
    expect(login).toMatchObject({ state: 'waiting', url: 'https://claude.example.org/login' });
    expect((await current.inject({ method: 'POST', url: '/api/integrations/claude/logins', headers: LOCAL, payload: { email: 'not-an-email' } })).statusCode).toBe(400);
    expect((await current.inject({ method: 'POST', url: `/api/integrations/claude/logins/${login.id}/code`, headers: LOCAL, payload: { code: '  ' } })).statusCode).toBe(400);
    const cancel = await current.inject({ method: 'DELETE', url: `/api/integrations/claude/logins/${login.id}`, headers: LOCAL });
    expect(cancel.statusCode).toBe(200);
    expect((await current.inject({ method: 'DELETE', url: `/api/integrations/claude/logins/${login.id}`, headers: LOCAL })).statusCode).toBe(404);
  });

  it('gives every task card its assignee', async () => {
    current = app().server;
    const r = await current.inject({ method: 'GET', url: '/api/tasks', headers: LOCAL });
    expect((r.json() as { tasks: { key: string; assignee: unknown }[] }).tasks.map((t) => [t.key, t.assignee])).toEqual([
      ['TEAM-7', { name: 'owner' }],
      ['TEAM-8', { name: 'owner' }],
    ]);
  });
});
