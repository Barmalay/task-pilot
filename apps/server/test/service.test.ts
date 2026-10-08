import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.ts';
import { createGit } from '../src/integrations/git.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { changedSince, createServiceInfo, docsOf, installNeeded, launchedByApp, lineLevel, logLines, repoOf, RESTART_AREAS } from '../src/service.ts';
import { TaskService } from '../src/tasks.ts';
import { Store } from '../src/store/db.ts';
import { FakeCatalog, makeEngine, PROFILES } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-pilot-service-')));
  roots.push(root);
  return root;
}

/** Файл с текстом и временем изменения at (мс). */
function file(path: string, text = 'x', at?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (at !== undefined) utimesSync(path, at / 1000, at / 1000);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' } });

/** Репозиторий с коммитом, измененным файлом и новым файлом. */
function repo(): string {
  const root = tmp();
  git(root, 'init', '-q', '-b', 'master');
  file(join(root, 'a.txt'), 'a');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Первый коммит');
  file(join(root, 'a.txt'), 'a2');
  file(join(root, 'new.txt'), 'n');
  return root;
}

const T0 = Date.parse('2026-09-28T10:00:00Z');

describe('what the server reads only at start', () => {
  it('lists the files of the restart areas changed after the start, without dependencies and build output', () => {
    const root = tmp();
    file(join(root, 'apps/server/src/app.ts'), 'x', T0 + 60_000);
    file(join(root, 'apps/server/src/old.ts'), 'x', T0 - 60_000);
    file(join(root, 'packages/step-kit/src/contracts.ts'), 'x', T0 + 1000);
    file(join(root, 'packages/step-kit/src/node_modules/dep/index.js'), 'x', T0 + 1000);
    file(join(root, 'company/example/contours/core.yaml'), 'x', T0 + 5000);
    file(join(root, 'steps/qa.stand/index.ts'), 'x', T0 + 5000);
    expect(changedSince(root, RESTART_AREAS, T0)).toEqual(['apps/server/src/app.ts', 'company/example/contours/core.yaml', 'packages/step-kit/src/contracts.ts']);
    expect(changedSince(root, ['нет/такой/папки'], T0)).toEqual([]);
  });

  it('lists the changed files of the team pack outside the root by their full path', () => {
    const root = tmp();
    const team = tmp();
    file(join(team, 'team.yaml'), 'x', T0 - 60_000);
    file(join(team, 'profiles/jira.yaml'), 'x', T0 + 5000);
    file(join(team, 'dashboards/a/dashboard.yaml'), 'x', T0 + 5000);
    expect(changedSince(root, [join(team, 'team.yaml'), join(team, 'profiles')], T0)).toEqual([join(team, 'profiles/jira.yaml')]);
  });

  it('says dependencies must be installed when the lockfile differs from the installed one, whatever the file times', () => {
    const root = tmp();
    expect(installNeeded(root)).toBe(false);
    file(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', T0 + 1000);
    expect(installNeeded(root)).toBe(true);
    file(join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9.0\n', T0);
    expect(installNeeded(root)).toBe(false);
    file(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nnew: dep\n', T0 - 1000);
    expect(installNeeded(root)).toBe(true);
  });

  it('knows the server was started by the app from launcher.json', () => {
    const data = tmp();
    expect(launchedByApp(data, 4242)).toBe(false);
    file(join(data, 'launcher.json'), JSON.stringify({ server: { pgid: 4242, started: 'x' }, web: { pgid: 4243, started: 'y' } }));
    expect(launchedByApp(data, 4242)).toBe(true);
    expect(launchedByApp(data, 4243)).toBe(false);
  });
});

describe('server log', () => {
  it('keeps the last lines without terminal colors and tokens and marks errors and warnings', () => {
    const data = tmp();
    const lines = ['старая строка', '\u001b[32m  VITE v8.3.0\u001b[39m  ready', 'Резервная копия базы не сделана Error: disk full', 'Каталог: steps/x/step.yaml: нет id', 'Authorization: Bearer abc.def-123', 'url?token=s3cr3t-value&x=1', 'ключ tp-secret-12345 в строке'];
    file(join(data, 'launcher.log'), `${lines.join('\n')}\n`);
    const out = logLines(join(data, 'launcher.log'), createRedactor(['tp-secret-12345']).text, 6);
    expect(out.map((l) => l.text)).toEqual(['  VITE v8.3.0  ready', 'Резервная копия базы не сделана Error: disk full', 'Каталог: steps/x/step.yaml: нет id', 'Authorization: Bearer ***', 'url?token=***&x=1', 'ключ *** в строке']);
    expect(out.map((l) => l.level)).toEqual([null, 'error', 'warn', null, null, null]);
    expect(logLines(join(data, 'нет.log'), (t) => t)).toEqual([]);
    expect(lineLevel('WARNING: slow')).toBe('warn');
  });
});

describe('docs waiting for the owner', () => {
  it('lists acceptance guides, decision journals and plans of .claude, newest first, with their open questions', () => {
    const root = tmp();
    file(join(root, '.claude/stage-2/acceptance.md'), '# Приемка этапа 2\n\nШаги.', T0);
    file(join(root, '.claude/run-2860/notes.md'), '# Замечания по прогону\n\n## Решения, которые принял я и которые стоит подтвердить\n\n- одно', T0 + 2000);
    file(join(root, '.claude/arch/plan.md'), 'Без заголовка', T0 + 1000);
    file(join(root, '.claude/arch/qa-guide.md'), '# Гайд', T0);
    file(join(root, '.claude/artifacts/shots/acceptance.md'), '# Не док', T0);
    const docs = docsOf(root, {});
    expect(docs.map((d) => [d.path, d.kind, d.title, d.questions, d.accepted])).toEqual([
      ['run-2860/notes.md', 'notes', 'Замечания по прогону', true, false],
      ['arch/plan.md', 'plan', 'arch/plan.md', false, false],
      ['stage-2/acceptance.md', 'acceptance', 'Приемка этапа 2', false, false],
    ]);
    expect(docsOf(tmp(), {})).toEqual([]);
  });

  it('counts a doc accepted until it changes again', () => {
    const root = tmp();
    file(join(root, '.claude/stage-2/acceptance.md'), '# Приемка', T0);
    expect(docsOf(root, { 'stage-2/acceptance.md': T0 })[0]!.accepted).toBe(true);
    file(join(root, '.claude/stage-2/acceptance.md'), '# Приемка, правка', T0 + 1000);
    expect(docsOf(root, { 'stage-2/acceptance.md': T0 })[0]!.accepted).toBe(false);
  });
});

describe('repository of Task Pilot', () => {
  it('shows the branch, the last commits and uncommitted files with their raw status codes', async () => {
    const root = repo();
    const r = await repoOf(createGit(), root, (t) => t);
    expect(r).toMatchObject({ branch: 'master', remote: null, error: null });
    expect(r.commits.map((c) => c.subject)).toEqual(['Первый коммит']);
    expect(r.dirty).toEqual([
      { code: ' M', path: 'a.txt' },
      { code: '??', path: 'new.txt' },
    ]);
  });

  it('counts commits not pushed to the remote and hides tokens in its address', async () => {
    const root = repo();
    const origin = tmp();
    git(origin, 'init', '-q', '--bare', '-b', 'master');
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '-q', '-u', 'origin', 'master');
    git(root, 'commit', '-q', '-am', 'Второй коммит');
    const r = await repoOf(createGit(), root, (t) => t.replace(origin, '<origin>'));
    expect(r.remote).toEqual({ name: 'origin', url: '<origin>', ahead: 1, behind: 0 });
  });

  it('says so when the folder is not a git repository', async () => {
    expect(await repoOf(createGit(), tmp(), (t) => t)).toMatchObject({ branch: null, error: 'Папка Task Pilot не репозиторий git' });
  });
});

/** Сведения о Task Pilot на временном репозитории: сервер запущен в T0 приложением (или нет). */
async function service(opts: { app?: boolean } = {}) {
  const root = repo();
  const data = tmp();
  const store = new Store(':memory:');
  const pid = 777;
  if (opts.app !== false) file(join(data, 'launcher.json'), JSON.stringify({ server: { pgid: pid, started: 'x' } }));
  file(join(root, '.claude/stage-2/acceptance.md'), '# Приемка этапа 2\n\nключ tp-secret-12345', T0);
  file(join(data, 'launcher.log'), 'Task Pilot API: http://127.0.0.1:5176\n');
  const restarts: number[] = [];
  const info = await createServiceInfo({
    root,
    dataDir: data,
    personalFile: join(data, 'profile.yaml'),
    store,
    git: createGit(),
    redact: createRedactor(['tp-secret-12345']),
    startedAt: new Date(T0),
    pid,
    spawnRestart: () => restarts.push(Date.now()),
  });
  const run = (status: 'running' | 'waiting_owner' | 'completed') => {
    const r = store.createRun({ issueKey: `TEAM-${status.length}`, repoId: 'gate', standId: null, presetId: 'code-pr', dryRun: false }, [{ stepId: 'code.implement', selected: true }]);
    store.updateRun(r.id, { status });
    return r.id;
  };
  return { root, data, store, info, restarts, run };
}

describe('service info', () => {
  it('reports the server, the repository, the docs waiting and the log in one answer', async () => {
    const t = await service();
    t.run('waiting_owner');
    t.run('completed');
    file(join(t.root, 'apps/server/src/app.ts'), 'x', Date.now());
    const s = await t.info.status();
    expect(s.server).toMatchObject({ startedAt: new Date(T0).toISOString(), launchedByApp: true, changed: ['apps/server/src/app.ts'], installNeeded: false });
    expect(s.server.commitAtStart).toMatch(/^[0-9a-f]{7,}$/);
    expect(s.server.runs.map((r) => r.status)).toEqual(['waiting_owner']);
    expect(s.repo.branch).toBe('master');
    expect(s.docs.map((d) => d.path)).toEqual(['stage-2/acceptance.md']);
    expect(s.log.current.map((l) => l.text)).toEqual(['Task Pilot API: http://127.0.0.1:5176']);
    expect(s.log.restart).toEqual([]);
  });

  it('restarts only a server started by the app, never over a running run and not twice in a row', async () => {
    const waiting = await service();
    waiting.run('waiting_owner');
    waiting.info.restart();
    expect(waiting.restarts).toHaveLength(1);
    expect(() => waiting.info.restart()).toThrow('Перезапуск уже идет');

    const busy = await service();
    busy.run('running');
    expect(() => busy.info.restart()).toThrow('Выполняется прогонов: 1. Перезапуск прервал бы их шаги');
    expect(busy.restarts).toHaveLength(0);

    const external = await service({ app: false });
    expect(() => external.info.restart()).toThrow('Сервер запущен не приложением Task Pilot');
    expect(external.restarts).toHaveLength(0);
  });

  it('opens and accepts only docs from the list and hides tokens in their text', async () => {
    const t = await service();
    expect(t.info.doc('stage-2/acceptance.md')).toBe('# Приемка этапа 2\n\nключ ***');
    expect(() => t.info.doc('../../etc/passwd.md')).toThrow('нет среди гайдов и журналов');
    expect(() => t.info.doc('stage-2/secret.md')).toThrow('нет среди гайдов и журналов');
    t.info.accept('stage-2/acceptance.md', true);
    expect((await t.info.status()).docs[0]!.accepted).toBe(true);
    t.info.accept('stage-2/acceptance.md', false);
    expect((await t.info.status()).docs[0]!.accepted).toBe(false);
    expect(() => t.info.accept('artifacts/x/acceptance.md', true)).toThrow('нет среди гайдов и журналов');
  });
});

describe('service routes', () => {
  const LOCAL = { host: 'localhost:5176', 'x-task-pilot': '1' };

  async function server(opts: { app?: boolean } = {}) {
    const t = await service(opts);
    const catalog = new FakeCatalog();
    const deps = makeEngine(catalog);
    return { t, app: buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...deps, profiles: PROFILES }), ...deps, service: t.info }) };
  }

  it('answers the info, starts a restart with 202 and refuses it with 409 and the reason', async () => {
    const { t, app } = await server();
    const info = await app.inject({ method: 'GET', url: '/api/service', headers: LOCAL });
    expect(info.statusCode).toBe(200);
    expect(info.json().server.launchedByApp).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/service/restart', headers: LOCAL })).statusCode).toBe(202);
    expect(t.restarts).toHaveLength(1);
    const again = await app.inject({ method: 'POST', url: '/api/service/restart', headers: LOCAL });
    expect(again.statusCode).toBe(409);
    expect(again.json().error_description).toBe('Перезапуск уже идет');
    await app.close();
  });

  it('gives a doc from the list, marks it accepted and rejects other paths', async () => {
    const { app } = await server();
    const doc = await app.inject({ method: 'GET', url: `/api/service/doc?path=${encodeURIComponent('stage-2/acceptance.md')}`, headers: LOCAL });
    expect(doc.json()).toEqual({ path: 'stage-2/acceptance.md', text: '# Приемка этапа 2\n\nключ ***' });
    expect((await app.inject({ method: 'GET', url: '/api/service/doc?path=..%2F..%2Fpackage.json', headers: LOCAL })).statusCode).toBe(404);
    const accepted = await app.inject({ method: 'POST', url: '/api/service/doc/accept', headers: LOCAL, payload: { path: 'stage-2/acceptance.md', accepted: true } });
    expect(accepted.json().docs[0].accepted).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/service/doc/accept', headers: LOCAL, payload: { path: 'stage-2/acceptance.md' } })).statusCode).toBe(400);
    await app.close();
  });
});
