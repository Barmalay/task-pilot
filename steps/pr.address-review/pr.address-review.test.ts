import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitPort, Issue, PrComment, PrReview, PullRequestState, ScmPort } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

const KEY = 'TEAM-8';
const AUTHOR = 'Автор PR';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ISSUE = { key: KEY, summary: 'Обмен паспортного токена', status: 'Ready to Review', url: '', labels: [], components: [], sprint: null, assignee: null, description: '' } as Issue;

const comment = (id: number, text: string, replies: [string, string][] = []): PrComment => ({
  id,
  author: 'Ревьюер Один',
  text,
  createdAt: '2026-09-22T08:00:00.000Z',
  state: 'OPEN',
  file: id === 7930 ? 'src/A.java' : null,
  line: id === 7930 ? 182 : null,
  replies: replies.map(([author, t], i) => ({ id: id * 10 + i, author, text: t, createdAt: '2026-09-22T09:00:00.000Z' })),
});

function setup(opts: { comments: PrComment[]; output?: Record<string, unknown>; values?: Record<string, unknown> }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'address-review-')));
  roots.push(root);
  const worktree = join(root, 'wt', `demo-${KEY}`);
  mkdirSync(worktree, { recursive: true });
  const pr: PullRequestState = { id: 262, title: 'TEAM-8', url: 'https://git.example.org/pr/262', state: 'OPEN', author: AUTHOR, reviewers: [{ name: 'Ревьюер Один', status: 'NEEDS_WORK' }], comments: opts.comments };
  const scm: ScmPort = {
    openPullRequests: async () => [],
    createPullRequest: async () => pr,
    findPullRequest: async () => pr,
    pullRequest: async () => pr,
    reply: async () => {},
  };
  const git: GitPort = {
    run: async () => ({ code: 0, stdout: 'aaaaaaaa00\n', stderr: '' }),
    tryRun: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  const agent = fakeAgent(() => ({ output: opts.output ?? {} }));
  const repo = { ...testRepo(join(root, 'repo'), join(root, 'wt')), build: { javaHome: '/jdk21', command: 'mvn -o verify' }, bitbucket: { project: 'CLOUD', repo: 'demo', reviewers: [] } };
  const c = testContext({ issueKey: KEY, repo, ports: { scm, git }, agent: agent.agent, values: { issue: ISSUE, worktree, branch: `feature/${KEY}`, pr: { id: 262 }, ...opts.values } });
  return { c, agent, worktree };
}

const TWO = [comment(7930, 'Давай где пустые return добавим дебаг логи?'), comment(7929, 'Добавил ключи в k8s?')];

describe('pr.address-review', () => {
  it('asks the agent to fix the code and answer every open comment without names, and loops when the code changed', async () => {
    const t = setup({
      comments: TWO,
      output: {
        replies: [
          { commentId: 7930, text: 'Добавил debug-лог перед каждым return.', fixed: true },
          { commentId: 7929, text: 'Да, ключи в ветке feature/TEAM-8 k8s-ansible.', fixed: false },
        ],
        summary: 'Логи добавлены',
        files: ['src/A.java'],
        tests: ['src/ATest.java'],
        buildGreen: true,
      },
    });
    const out = (await step.run(t.c)) as { prReview: PrReview };

    const req = t.agent.requests[0]!;
    expect(req).toMatchObject({ label: 'ответ на ревью', cwd: t.worktree });
    expect(req.allow).toEqual(expect.arrayContaining(['Bash(mvn *)', 'Bash(git diff *)']));
    expect(req.prompt).toContain('- Замечание 7930 (src/A.java:182): Давай где пустые return добавим дебаг логи?');
    expect(req.prompt).toContain('- Замечание 7929 (общий комментарий): Добавил ключи в k8s?');
    expect(req.prompt).toContain('ревьюеры одобрили 0 из 1, просят доработать 1');
    expect(req.prompt).not.toContain('Ревьюер Один');

    expect(out.prReview).toMatchObject({ pr: 262, pending: true, base: 'aaaaaaaa00', files: ['src/A.java'] });
    expect(out.prReview.replies.map((r) => [r.commentId, r.fixed])).toEqual([
      [7930, true],
      [7929, false],
    ]);
    expect(await step.again!(t.c, out)).toBe(true);
  });

  it('shows the thread of earlier replies and skips comments where the author has the last word', async () => {
    const t = setup({
      comments: [comment(7930, 'Логи?', [[AUTHOR, 'Везде есть reject с логом'], ['Ревьюер Один', 'А в методе check?']]), comment(7929, 'Ключи?', [[AUTHOR, 'Да']])],
      output: { replies: [{ commentId: 7930, text: 'В check тоже добавил.', fixed: true }], summary: '', files: ['src/A.java'], tests: [], buildGreen: true },
    });
    await step.run(t.c);
    const prompt = t.agent.requests[0]!.prompt;
    expect(prompt).toContain('Ветка ответов: вы: Везде есть reject с логом; ревьюер: А в методе check?');
    expect(prompt).not.toContain('Замечание 7929');
  });

  it('needs no new round when the answers change no code', async () => {
    const t = setup({ comments: [comment(7929, 'Ключи?')], output: { replies: [{ commentId: 7929, text: 'Да, в k8s-ansible.', fixed: false }], summary: '', files: [], tests: [], buildGreen: true } });
    const out = await step.run(t.c);
    expect(await step.again!(t.c, out)).toBe(false);
    expect(t.c.logs.at(-1)).toBe('Ответы готовы: 1, код не менялся');
  });

  it('fails when the agent left a comment without an answer', async () => {
    const t = setup({ comments: TWO, output: { replies: [{ commentId: 7929, text: 'Да.', fixed: false }], summary: '', files: [], tests: [], buildGreen: true } });
    await expect(step.run(t.c)).rejects.toThrow('Агент не ответил на замечания 7930');
  });

  it('is done when there is nothing to answer or the answers to every open comment are ready', async () => {
    expect(await step.done!(setup({ comments: [] }).c)).toEqual({ note: 'В PR #262 замечаний без ответа нет: одобрили 0 из 1, просят доработать 1' });
    const drafted: PrReview = { pr: 262, replies: [{ commentId: 7929, text: 'Да.', fixed: false }], summary: '', files: [], tests: [], pending: true, base: 'a', at: 'x' };
    expect(await step.done!(setup({ comments: [comment(7929, 'Ключи?')], values: { prReview: drafted } }).c)).toEqual({ note: 'Ответы на замечания готовы: их публикует шаг "Мерж и доска"' });
    expect(await step.done!(setup({ comments: TWO, values: { prReview: drafted } }).c)).toBeNull();
  });
});
