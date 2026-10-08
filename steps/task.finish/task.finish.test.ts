import { describe, expect, it } from 'vitest';
import type { Issue, JiraConfig, JiraPort, LinkedRun, PrComment, PrReview, PullRequestState, ScmPort } from '../../packages/step-kit/src/index.ts';
import { isStepWaiting } from '../../packages/step-kit/src/index.ts';
import { memoryJiraFiles } from '../../apps/server/src/demo/jira-files.ts';
import { testContext, testLinked, testRepo, TEST_JIRA } from '../_test/context.ts';
import step from './index.ts';

const KEY = 'TEAM-8';
const AUTHOR = 'Автор PR';

/** Доска с путем до MERGED, как в profiles/jira.yaml. */
const JIRA: JiraConfig = {
  ...TEST_JIRA,
  path: [
    ...TEST_JIRA.path,
    { from: 'To Testing', id: '751', name: 'Взять в тестирование', to: 'In Testing' },
    { from: 'In Testing', id: '721', name: 'Все хорошо!', to: 'Resolved' },
    { from: 'Resolved', id: '1011', name: 'Смержено', to: 'MERGED' },
  ],
  milestones: { ...TEST_JIRA.milestones, merged: 'MERGED' },
};

const comment = (id: number, text: string, replies: string[] = []): PrComment => ({
  id,
  author: 'Ревьюер',
  text,
  createdAt: '2026-09-22T08:00:00.000Z',
  state: 'OPEN',
  file: id === 7930 ? 'src/A.java' : null,
  line: id === 7930 ? 182 : null,
  replies: replies.map((a, i) => ({ id: id * 10 + i, author: a, text: 'ответ', createdAt: '2026-09-22T09:00:00.000Z' })),
});

function setup(opts: { status?: string; pr?: Partial<PullRequestState>; values?: Record<string, unknown>; linked?: LinkedRun[]; linkedStates?: Record<number, string>; params?: Record<string, unknown> } = {}) {
  const state = { status: opts.status ?? 'In Testing', moves: [] as string[] };
  const jira: JiraPort = {
    async search() {
      return [];
    },
    async getIssue(key): Promise<Issue> {
      return { key, summary: 'Вход', status: state.status, url: '', labels: [], components: [], sprint: null, assignee: null, description: '' };
    },
    async getTransitions() {
      return JIRA.path.filter((p) => p.from === state.status).map((p) => ({ id: p.id ?? p.to, name: p.name ?? p.to, to: p.to }));
    },
    async transition(_key, id) {
      const t = JIRA.path.find((p) => p.id === id && p.from === state.status)!;
      state.moves.push(id);
      state.status = t.to;
    },
    async assign() {},
    async sprints() {
      return [];
    },
    ...memoryJiraFiles().port,
  };
  const pr: PullRequestState = { id: 262, title: 'TEAM-8 Вход', url: 'https://git.example.org/pr/262', state: 'OPEN', author: AUTHOR, reviewers: [{ name: 'Ревьюер', status: 'APPROVED' }, { name: 'Второй', status: 'UNAPPROVED' }], comments: [], ...opts.pr };
  const replies: { commentId: number; text: string }[] = [];
  const found: string[] = [];
  const scm: ScmPort = {
    openPullRequests: async () => [],
    createPullRequest: async () => pr,
    async findPullRequest(_ref, branch) {
      found.push(branch);
      return pr;
    },
    // PR связанных прогонов отвечают своим состоянием по номеру, PR этого прогона - как задан.
    pullRequest: async (_ref, id) => (opts.linkedStates?.[id] ? { ...pr, id, state: opts.linkedStates[id]! } : pr),
    async reply(_ref, _pr, commentId, text) {
      replies.push({ commentId, text });
    },
  };
  const repo = { ...testRepo('/repo', '/wt'), bitbucket: { project: 'CLOUD', repo: 'demo', reviewers: [] } };
  const c = testContext({ issueKey: KEY, repo, ports: { jira, scm }, jira: JIRA, params: opts.params, values: { pr: { id: 262 }, ...opts.values }, linked: () => opts.linked ?? [] });
  return { c, state, replies, found, pr };
}

/** Как движок: preview, затем run с тем же контекстом. Ожидание события - не ошибка, а пауза. */
async function gate(c: ReturnType<typeof setup>['c']) {
  try {
    const preview = await step.preview!(c);
    return { preview, waiting: null };
  } catch (e) {
    if (isStepWaiting(e)) return { preview: null, waiting: e };
    throw e;
  }
}

const review = (over: Partial<PrReview> = {}): PrReview => ({
  pr: 262,
  replies: [
    { commentId: 7930, text: 'Добавил debug-лог перед каждым return.', fixed: true },
    { commentId: 7929, text: 'Да, ключи в ветке feature/TEAM-8 k8s-ansible, PR #1513.', fixed: false },
  ],
  summary: 'Логи добавлены',
  files: ['src/A.java'],
  tests: [],
  pending: true,
  base: 'aaaaaaaa00',
  at: '2026-09-23T10:00:00.000Z',
  ...over,
});

describe('task.finish', () => {
  it('waits for the merge of an open pull request and tells the state of the review', async () => {
    const t = setup({ pr: { comments: [comment(7929, 'Добавил ключи в k8s?')] } });
    const { waiting } = await gate(t.c);
    expect(waiting?.message).toBe('Жду мерж PR #262: одобрили 1 из 2, замечаний без ответа 1');
    expect(waiting?.event).toEqual({ kind: 'pr', scm: { contour: 'cloud', project: 'CLOUD', repo: 'demo' }, pr: 262 });
  });

  it('publishes the prepared replies after the push, with the fix commit, and waits for the merge', async () => {
    const t = setup({ pr: { comments: [comment(7930, 'Добавим дебаг логи?'), comment(7929, 'Добавил ключи в k8s?')] }, values: { prReview: review(), commitSha: 'bbbbbbbb11' } });
    const { preview } = await gate(t.c);
    expect(preview?.actions).toEqual(['Ответить в PR #262 на 2 замечания']);
    expect(preview?.texts?.map((x) => [x.label, x.text])).toEqual([
      ['Ответ на замечание (src/A.java:182): "Добавим дебаг логи?"', 'Добавил debug-лог перед каждым return. Исправлено в коммите bbbbbbbb.'],
      ['Ответ на замечание (общий комментарий): "Добавил ключи в k8s?"', 'Да, ключи в ветке feature/TEAM-8 k8s-ansible, PR #1513.'],
    ]);
    const run = await step.run(t.c).catch((e: unknown) => e);
    expect(isStepWaiting(run)).toBe(true);
    expect((run as Error).message).toBe('ответов опубликовано: 2. Жду мерж PR #262: одобрили 1 из 2');
    expect(t.replies.map((r) => r.commentId)).toEqual([7930, 7929]);
    expect((run as { outputs?: { prReview?: PrReview } }).outputs?.prReview).toMatchObject({ pr: 262, pending: false, replies: review().replies });
  });

  it('does not publish a reply twice: a thread where the author has the last word is skipped', async () => {
    const t = setup({ pr: { comments: [comment(7930, 'Добавим дебаг логи?', [AUTHOR]), comment(7929, 'Добавил ключи в k8s?')] }, values: { prReview: review(), commitSha: 'bbbbbbbb11' } });
    const { preview } = await gate(t.c);
    expect(preview?.texts?.map((x) => x.id)).toEqual(['reply-7929']);
  });

  it('refuses to answer about a fix that has not been pushed yet', async () => {
    const t = setup({ pr: { comments: [comment(7930, 'Добавим дебаг логи?')] }, values: { prReview: review(), commitSha: 'aaaaaaaa00' } });
    await expect(step.preview!(t.c)).rejects.toThrow('Исправления по замечаниям ревьюеров еще не запушены');
  });

  it('walks the task to MERGED with one approval once the pull request is merged', async () => {
    const t = setup({ pr: { state: 'MERGED' } });
    const { preview } = await gate(t.c);
    expect(preview?.actions).toEqual([
      'Jira: In Testing → Resolved, переход "Все хорошо!"',
      'Jira: Resolved → MERGED, переход "Смержено"',
    ]);
    expect(preview?.requiresApproval).toBe(true);
    const out = await step.run(t.c);
    expect(out).toMatchObject({ merged: { pr: 262 }, status: 'MERGED' });
    expect(t.state.moves).toEqual(['721', '1011']);
  });

  it('leaves the task where it is while the pull request of a linked run is open, and walks it to MERGED after the last merge', async () => {
    const linked = [testLinked({ context: { pr: { id: 12 } } }), testLinked({ repoId: 'mobile', context: { pr: { id: 7 } } })];
    const t = setup({ pr: { state: 'MERGED' }, linked, linkedStates: { 12: 'OPEN', 7: 'MERGED' } });
    const { preview } = await gate(t.c);
    expect(preview).toMatchObject({ title: 'TEAM-8: MERGED после связанных прогонов', actions: ['Задачу по доске не вести: ждут мержа adapter #12'], requiresApproval: false });
    expect(await step.run(t.c)).toMatchObject({ merged: { pr: 262 }, status: 'In Testing' });
    expect(t.state.moves).toEqual([]);
    expect(t.c.logs).toContain('PR #262 смержен; задачу дальше по доске переведет прогон, чей PR смержат последним: ждут adapter #12');
    const last = setup({ pr: { state: 'MERGED' }, linked, linkedStates: { 12: 'MERGED', 7: 'MERGED' } });
    expect((await gate(last.c)).preview?.requiresApproval).toBe(true);
    expect(await step.run(last.c)).toMatchObject({ status: 'MERGED' });
    expect(last.state.moves).toEqual(['721', '1011']);
  });

  it('still waits for the merge with the move switched off and then leaves the task in its status without an approval', async () => {
    // С выключенным переводом шаг не "уже сделан": он ждет мерж, как обычно.
    expect(await step.done!(setup({ status: 'MERGED', params: { moveTo: 'none' } }).c)).toBeNull();
    await expect(step.preview!(setup({ params: { moveTo: 'none' } }).c)).rejects.toThrow('Жду мерж PR #262');
    const t = setup({ pr: { state: 'MERGED' }, params: { moveTo: 'none' } });
    const { preview } = await gate(t.c);
    expect(preview).toMatchObject({ actions: ['Jira: задача остается в статусе In Testing, перевод по доске выключен в настройках шага'], requiresApproval: false });
    expect(await step.run(t.c)).toMatchObject({ merged: { pr: 262 }, status: 'In Testing' });
    expect(t.state.moves).toEqual([]);
  });

  it('stops on a declined pull request and is done for a task that is already MERGED', async () => {
    await expect(step.preview!(setup({ pr: { state: 'DECLINED' } }).c)).rejects.toThrow('PR #262 отклонен');
    expect(await step.done!(setup({ status: 'MERGED' }).c)).toEqual({ note: 'Задача уже в статусе MERGED', outputs: { status: 'MERGED' } });
    expect(await step.done!(setup({ status: 'Resolved' }).c)).toBeNull();
  });

  it('finds the pull request by the branch of the task when the run did not create it', async () => {
    const t = setup({ pr: { state: 'MERGED' }, values: { pr: undefined, branch: 'feature/TEAM-8' } });
    await gate(t.c);
    expect(t.found).toEqual(['feature/TEAM-8']);
  });
});
