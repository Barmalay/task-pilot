import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGit } from '../../apps/server/src/integrations/git.ts';
import type { StepContext } from '../../packages/step-kit/src/index.ts';
import { TEST_CONTOUR, testContext, testRepo } from '../_test/context.ts';
import { parseWorktrees } from '../_shared/worktrees.ts';
import step from './index.ts';

const roots: string[] = [];

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.org';
  process.env.GIT_COMMITTER_NAME = 'test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.org';
});

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function commit(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `change ${file}`);
}

/** origin (bare), seed - клон для имитации коллег, work - основная папка владельца. */
function setup() {
  // realpath: git печатает пути без симлинков, а на macOS tmpdir лежит под симлинком /var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-pilot-git-')));
  roots.push(root);
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  commit(seed, 'a.txt', 'one\n');
  git(seed, 'push', '-q', 'origin', 'master');
  const work = join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  return { seed, work, worktrees: join(root, 'wt') };
}

function context(work: string, worktrees: string, issueKey: string): StepContext {
  return testContext({ issueKey, repo: testRepo(work, worktrees), ports: { git: createGit(), jira: {} as never, shell: {} as never, scm: {} as never } });
}

describe('parseWorktrees', () => {
  it('reads paths and branches from porcelain output', () => {
    const out = 'worktree /a\nHEAD 1\nbranch refs/heads/master\n\nworktree /b\nHEAD 2\ndetached\n';
    expect(parseWorktrees(out)).toEqual([
      { path: '/a', branch: 'refs/heads/master' },
      { path: '/b', branch: null },
    ]);
  });
});

describe('git.prepare', () => {
  it('creates a new branch from fresh master in a separate worktree without asking', async () => {
    const { work, worktrees } = setup();
    const c = context(work, worktrees, 'TEAM-1');
    expect(await step.done!(c)).toBeNull();
    const p = await step.preview!(c);
    expect(p.requiresApproval).toBe(false);
    expect(p.actions[0]).toContain('Создать ветку feature/TEAM-1');
    const out = await step.run(context(work, worktrees, 'TEAM-1'));
    expect(out).toEqual({ branch: 'feature/TEAM-1', worktree: join(worktrees, 'demo-TEAM-1'), rebased: false });
    expect(git(join(worktrees, 'demo-TEAM-1'), 'branch', '--show-current').trim()).toBe('feature/TEAM-1');
  });

  it('is idempotent: after the run the branch is reported as ready', async () => {
    const { work, worktrees } = setup();
    await step.run(context(work, worktrees, 'TEAM-1'));
    expect(await step.done!(context(work, worktrees, 'TEAM-1'))).toMatchObject({ outputs: { branch: 'feature/TEAM-1' } });
  });

  it('takes an existing remote branch into a tracking worktree', async () => {
    const { seed, work, worktrees } = setup();
    git(seed, 'checkout', '-q', '-b', 'feature/TEAM-2');
    commit(seed, 'b.txt', 'two\n');
    git(seed, 'push', '-q', 'origin', 'feature/TEAM-2');
    const out = await step.run(context(work, worktrees, 'TEAM-2'));
    expect(readFileSync(join(String(out.worktree), 'b.txt'), 'utf8')).toBe('two\n');
  });

  it('asks for approval before rebasing a pushed branch that fell behind master, then rebases it', async () => {
    const { seed, work, worktrees } = setup();
    git(work, 'checkout', '-q', '-b', 'feature/TEAM-3');
    commit(work, 'b.txt', 'mine\n');
    git(work, 'push', '-q', '-u', 'origin', 'feature/TEAM-3');
    commit(seed, 'c.txt', 'master moved\n');
    git(seed, 'push', '-q', 'origin', 'master');

    const p = await step.preview!(context(work, worktrees, 'TEAM-3'));
    expect(p.requiresApproval).toBe(true);
    expect(p.summary).toBe(work);
    expect(p.actions.join(' ')).toContain('--force-with-lease');

    const out = await step.run(context(work, worktrees, 'TEAM-3'));
    expect(out).toMatchObject({ branch: 'feature/TEAM-3', worktree: work, rebased: true });
    expect(existsSync(join(work, 'c.txt'))).toBe(true);
    expect(existsSync(join(work, 'b.txt'))).toBe(true);
  });

  it('aborts a conflicting rebase and leaves the branch as it was', async () => {
    const { seed, work, worktrees } = setup();
    git(work, 'checkout', '-q', '-b', 'feature/TEAM-4');
    commit(work, 'a.txt', 'branch version\n');
    commit(seed, 'a.txt', 'master version\n');
    git(seed, 'push', '-q', 'origin', 'master');
    const before = git(work, 'rev-parse', 'HEAD').trim();
    await expect(step.run(context(work, worktrees, 'TEAM-4'))).rejects.toThrow('Конфликт');
    expect(git(work, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(existsSync(join(work, '.git', 'rebase-merge'))).toBe(false);
  });

  it('refuses to touch a checkout with uncommitted changes', async () => {
    const { seed, work, worktrees } = setup();
    git(work, 'checkout', '-q', '-b', 'feature/TEAM-5');
    commit(seed, 'c.txt', 'master moved\n');
    git(seed, 'push', '-q', 'origin', 'master');
    writeFileSync(join(work, 'a.txt'), 'dirty\n');
    await expect(step.preview!(context(work, worktrees, 'TEAM-5'))).rejects.toThrow('незакоммиченные');
  });

  it('refuses to work in a contour that is not connected yet', async () => {
    const { work, worktrees } = setup();
    const c = testContext({
      issueKey: 'TEAM-7',
      repo: testRepo(work, worktrees),
      ports: { git: createGit(), jira: {} as never, shell: {} as never, scm: {} as never },
      contour: { ...TEST_CONTOUR, id: 'core', title: 'core', connected: false, note: 'нужны учетные данные' },
    });
    await expect(step.done!(c)).rejects.toThrow('Контур core еще не подключен: нужны учетные данные');
    expect(existsSync(join(worktrees, 'demo-TEAM-7'))).toBe(false);
  });

  it('stops when the local branch diverged from the remote one', async () => {
    const { seed, work, worktrees } = setup();
    git(work, 'checkout', '-q', '-b', 'feature/TEAM-6');
    commit(work, 'b.txt', 'base\n');
    git(work, 'push', '-q', '-u', 'origin', 'feature/TEAM-6');
    git(seed, 'fetch', '-q', 'origin');
    git(seed, 'checkout', '-q', '-b', 'feature/TEAM-6', 'origin/feature/TEAM-6');
    commit(seed, 'c.txt', 'colleague\n');
    git(seed, 'push', '-q', 'origin', 'feature/TEAM-6');
    commit(work, 'd.txt', 'mine\n');
    await expect(step.preview!(context(work, worktrees, 'TEAM-6'))).rejects.toThrow('разошлась');
  });
});
