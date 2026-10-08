import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BambooPort, BuildResult, WaitEvent } from '../../packages/step-kit/src/index.ts';
import { createGit } from '../../apps/server/src/integrations/git.ts';
import { fakeAgent, TEST_CONTOUR, testContext, testRepo } from '../_test/context.ts';
import { branchRepo, git, gitIdentity } from '../_test/git.ts';
import { waitOf } from '../_test/wait.ts';
import step from './index.ts';

const SHA = 'a'.repeat(40);
const PLAN = 'BUILDS-P';

beforeAll(gitIdentity);

const build = (over: Partial<BuildResult> = {}): BuildResult => ({ key: `${PLAN}246-4`, number: 4, state: 'Successful', lifeCycle: 'Finished', revision: SHA, url: 'https://bamboo/browse/BUILDS-P246-4', ...over });

/** Bamboo, у которого ветка плана появляется с branchAfter-го запроса, а сборки идут по сценарию. */
function fakeBamboo(scenario: BuildResult[][], opts: { branchAfter?: number; log?: string[] } = {}) {
  let branchCalls = 0;
  let buildCalls = 0;
  const bamboo = {
    async planBranch(plan: string, branch: string) {
      branchCalls += 1;
      expect([plan, branch]).toEqual([PLAN, 'feature/TEAM-5']);
      return branchCalls > (opts.branchAfter ?? 0) ? { key: `${PLAN}246`, name: 'feature-TEAM-5' } : null;
    },
    async builds(key: string) {
      expect(key).toBe(`${PLAN}246`);
      return scenario[Math.min(buildCalls++, scenario.length - 1)]!;
    },
    async buildLog() {
      return opts.log ?? ['--- BUILDS-P246-BAPP-4', '[ERROR] CalculatorTest.addsTwoNumbers expected 5 but was 6'];
    },
  } as unknown as BambooPort;
  return { bamboo, calls: () => ({ branchCalls, buildCalls }) };
}

function setup(bamboo: BambooPort, values: Record<string, unknown> = {}, over: { worktree?: string; agent?: ReturnType<typeof fakeAgent>; build?: { command: string }; waited?: WaitEvent } = {}) {
  const repo = { ...testRepo('/tmp/none', '/tmp/wt'), bamboo: { plan: PLAN, deploymentProject: 1 }, ...(over.build ? { build: over.build } : {}) };
  const agent = over.agent ?? fakeAgent();
  const c = testContext({
    issueKey: 'TEAM-5',
    repo,
    ports: { bamboo: () => bamboo, git: createGit() },
    agent: agent.agent,
    values: { issue: {}, commitSha: SHA, ...(over.worktree ? { worktree: over.worktree } : {}), ...values },
    waited: over.waited ?? null,
  });
  return { c, agent };
}

describe('ci.wait', () => {
  it('waits for the plan branch and then for the build of the published commit, and gives the build with its image tag', async () => {
    const f = fakeBamboo([[build({ state: 'Unknown', lifeCycle: 'InProgress' })], [build(), build({ key: `${PLAN}246-3`, number: 3, revision: 'b'.repeat(40) })]], { branchAfter: 1 });
    const first = setup(f.bamboo);
    const branch = await waitOf(step.run(first.c));
    expect(branch).toMatchObject({ kind: 'plan-branch', contour: 'cloud', plan: PLAN, branch: 'feature/TEAM-5' });
    expect(Date.parse(branch.deadline.at) - Date.parse(branch.since)).toBe(10 * 60_000);
    expect(branch.deadline.error).toBe('Bamboo за 10 минут не завел ветку плана для feature/TEAM-5');
    // Ветка плана появилась: сборки коммита еще нет, шаг ждет ее с прежним началом ожидания.
    const second = setup(f.bamboo, {}, { waited: branch });
    const built = await waitOf(step.resume!(second.c, branch));
    expect(built).toMatchObject({ kind: 'build', contour: 'cloud', planKey: `${PLAN}246`, revision: SHA, since: branch.since });
    expect(Date.parse(built.deadline.at) - Date.parse(branch.since)).toBe(45 * 60_000);
    expect(built.deadline.error).toBe('Сборка коммита aaaaaaaa не закончилась за 45 минут: https://bamboo/browse/BUILDS-P246-4');
    const third = setup(f.bamboo, {}, { waited: built });
    expect(await step.resume!(third.c, built)).toEqual({
      build: { key: `${PLAN}246-4`, number: 4, plan: PLAN, branch: 'feature/TEAM-5', revision: SHA, tag: '1.0.4-246', url: 'https://bamboo/browse/BUILDS-P246-4' },
    });
    expect([...second.c.logs, ...third.c.logs].filter((l) => l.startsWith('Bamboo:'))).toEqual([`Bamboo: ${PLAN}246-4: InProgress`, `Bamboo: ${PLAN}246-4: Finished`]);
    expect(first.c.logs[0]).toBe('Жду сборку коммита aaaaaaaa ветки feature/TEAM-5 в плане BUILDS-P');
  });

  it('gives the green build at once when Bamboo already built the commit', async () => {
    const { c } = setup(fakeBamboo([[build()]]).bamboo);
    expect(await step.run(c)).toMatchObject({ build: { key: `${PLAN}246-4`, tag: '1.0.4-246' } });
  });

  it('waits for the head of the branch on the remote when no commit was published in this run', async () => {
    const { work } = branchRepo('TEAM-5');
    git(work, 'push', '-q', 'origin', 'feature/TEAM-5');
    const head = git(work, 'rev-parse', 'HEAD').trim();
    const f = fakeBamboo([[build({ revision: head })]]);
    const repo = { ...testRepo(work, '/tmp/wt'), bamboo: { plan: PLAN, deploymentProject: 1 } };
    const c = testContext({ issueKey: 'TEAM-5', repo, ports: { bamboo: () => f.bamboo, git: createGit() }, values: { issue: {} } });
    expect(((await step.run(c)) as { build: { revision: string } }).build.revision).toBe(head);
  });

  it('is done without waiting when the build of the commit is already green', async () => {
    const { c } = setup(fakeBamboo([[build()]]).bamboo);
    expect(await step.done!(c)).toMatchObject({ note: `Сборка ${PLAN}246-4 коммита aaaaaaaa уже зеленая`, outputs: { build: { tag: '1.0.4-246' } } });
    const running = setup(fakeBamboo([[build({ state: 'Unknown', lifeCycle: 'InProgress' })]]).bamboo);
    expect(await step.done!(running.c)).toBeNull();
  });

  it('lets the agent fix the code of a failed build and asks to publish the fix and wait again', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'ci-wait-'));
    git(worktree, 'init', '-q');
    const agent = fakeAgent((req) => {
      writeFileSync(join(req.cwd, 'Fix.java'), 'class Fix {}');
      return { output: { cause: 'code', summary: 'Тест ждал старое значение.', files: ['Fix.java'] } };
    });
    const { c } = setup(fakeBamboo([[build({ state: 'Failed' })]]).bamboo, {}, { worktree, agent, build: { command: 'make test' } });
    await expect(step.run(c)).rejects.toThrow('Агент исправил код в рабочей папке (Fix.java): повторите шаг "Коммит, пуш и PR", а затем этот шаг');
    const req = agent.requests[0]!;
    expect(req.prompt).toContain('expected 5 but was 6');
    expect(req.prompt).toContain('проверь исправление локальной сборкой: `make test`');
    expect(req.prompt).toContain('Не коммить и не пушь');
    expect(req.allow).toEqual(expect.arrayContaining(['Bash(git status *)', 'Bash(make *)']));
  });

  it('says the code was not touched when the failure is outside the code', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'ci-wait-'));
    git(worktree, 'init', '-q');
    const agent = fakeAgent(() => ({ output: { cause: 'infra', summary: 'Упала публикация docker-образа.', files: [] } }));
    const { c } = setup(fakeBamboo([[build({ state: 'Failed' })]], { log: ['Error executing /usr/bin/docker push'] }).bamboo, {}, { worktree, agent });
    await expect(step.run(c)).rejects.toThrow(`Сборка ${PLAN}246-4 упала, в коде агент ничего не менял: Упала публикация docker-образа. https://bamboo/browse/BUILDS-P246-4`);
    // Без команды сборки в профиле агент все равно разбирает лог, а проверяет исправление чтением кода.
    expect(agent.requests[0]!.prompt).toContain('локальная сборка в профиле репозитория не настроена');
  });

  it('does not call the agent without a worktree and points to the build', async () => {
    const agent = fakeAgent(() => {
      throw new Error('агента звать не должны');
    });
    const { c } = setup(fakeBamboo([[build({ state: 'Failed' })]]).bamboo, {}, { agent });
    await expect(step.run(c)).rejects.toThrow(`Сборка ${PLAN}246-4 упала: https://bamboo/browse/BUILDS-P246-4. Рабочей папки ветки нет`);
    expect(agent.requests).toEqual([]);
  });

  it('fails on a build that was not built and on a contour that is not connected', async () => {
    const notBuilt = setup(fakeBamboo([[build({ state: 'Unknown', lifeCycle: 'NotBuilt' })]]).bamboo);
    await expect(step.run(notBuilt.c)).rejects.toThrow('не выполнялась');
    const repo = { ...testRepo('/tmp/none', '/tmp/wt'), bamboo: { plan: PLAN, deploymentProject: 1 } };
    const offline = testContext({ issueKey: 'TEAM-5', repo, ports: {}, contour: { ...TEST_CONTOUR, connected: false }, values: { issue: {}, commitSha: SHA } });
    await expect(step.run(offline)).rejects.toThrow('еще не подключен');
  });

  it('waits for a build that has not started yet without a link in the deadline error', async () => {
    const { c } = setup(fakeBamboo([[]]).bamboo);
    const e = await waitOf(step.run(c));
    expect(e).toMatchObject({ kind: 'build', planKey: `${PLAN}246`, deadline: { error: 'Сборка коммита aaaaaaaa не закончилась за 45 минут' } });
    expect(c.logs).toContain('Bamboo: сборка коммита еще не началась');
  });
});
