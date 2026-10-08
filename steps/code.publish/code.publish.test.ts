import { chmodSync, existsSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { memoryJiraFiles } from '../../apps/server/src/demo/jira-files.ts';
import { createGit } from '../../apps/server/src/integrations/git.ts';
import type { Issue, JiraPort, Ports, Preview, PullRequestRef, ScmPort } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import { branchRepo, commit, git, gitIdentity, write } from '../_test/git.ts';
import { classify, parsePorcelain, removesLines, styleOffenders, testChanges, unmergedPaths } from './changes.ts';
import step from './index.ts';

const roots: string[] = [];
beforeAll(gitIdentity);
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fakeJira(status: string) {
  const state = { status, moves: [] as string[] };
  const jira: JiraPort = {
    async search() {
      return [];
    },
    async getIssue(key) {
      return { key, summary: 'Лимит попыток', status: state.status, url: `https://jira.example.org/browse/${key}`, labels: [], components: [], sprint: null, assignee: null, description: '' } as Issue;
    },
    async getTransitions() {
      return state.status === 'In Progress' ? [{ id: '971', name: 'Готово к ревью' }] : [];
    },
    async transition(_key, id) {
      state.moves.push(id);
      if (id === '971') state.status = 'Ready to Review';
    },
    async assign() {},
    async sprints() {
      return [];
    },
    ...memoryJiraFiles().port,
  };
  return { jira, state };
}

function fakeScm(open: PullRequestRef[] = []) {
  const created: unknown[] = [];
  const scm: ScmPort = {
    async openPullRequests() {
      return open;
    },
    async createPullRequest(ref, input) {
      created.push({ ref, input });
      const pr = { id: 271, title: input.title, url: 'https://git.example.org/pr/271' };
      open.push(pr);
      return pr;
    },
    findPullRequest: async () => null,
    pullRequest: async () => {
      throw new Error('состояние PR в тесте не нужно');
    },
    reply: async () => {
      throw new Error('ответы в PR в тесте не нужны');
    },
  };
  return { scm, created };
}

const TEXTS = { subject: 'Лимит попыток входа — «пять»', body: '', prTitle: '', prDescription: '- Счётчик попыток\n- Проверено тестами' };

/** Личный стиль владельца: е вместо е с точками, дефис вместо длинного тире, прямые кавычки. */
const STYLE = { yo: true, dash: true, quotes: true };

function setup(opts: { status?: string; open?: PullRequestRef[]; texts?: Record<string, string>; scm?: ScmPort; dryRun?: boolean; worktree?: string; values?: Record<string, unknown>; params?: Record<string, unknown>; style?: typeof STYLE } = {}) {
  const { root, origin, work } = branchRepo('TEAM-8', { 'src/main/java/demo/A.java': 'class A {}\n', 'src/test/java/demo/OldTest.java': 'class OldTest {}\n', 'pom.xml': '<project/>\n' });
  roots.push(root);
  const jira = fakeJira(opts.status ?? 'In Progress');
  const scm = fakeScm(opts.open);
  const agent = fakeAgent(() => ({ output: opts.texts ?? TEXTS }));
  const repo = { ...testRepo(join(root, 'repo'), join(root, 'wt')), commitPaths: ['src/**', 'pom.xml'], bitbucket: { project: 'CLOUD', repo: 'demo', reviewers: [] } };
  const ports = { git: createGit(), jira: jira.jira, scm: opts.scm ?? scm.scm } as unknown as Ports;
  const ctx = (extra: { draft?: unknown; feedback?: string | null } = {}) => {
    const style = opts.style ?? STYLE;
    const c = testContext({
      issueKey: 'TEAM-8',
      repo,
      ports,
      agent: agent.agent,
      params: opts.params,
      values: { worktree: opts.worktree ?? work, branch: 'feature/TEAM-8', ...opts.values },
      draft: extra.draft,
      feedback: extra.feedback,
      lint: { style },
      texts: { rules: '', style },
    });
    return opts.dryRun ? { ...c, run: { ...c.run, dryRun: true } } : c;
  };
  /** Как движок: prepare, затем preview с черновиком; возвращает черновик и превью. */
  const gate = async (feedback: string | null = null, previous?: unknown) => {
    const draft = await step.prepare!(ctx({ draft: previous, feedback }));
    return { draft, preview: await step.preview!(ctx({ draft })) };
  };
  return { root, origin, work, jira, scm, agent, ctx, gate };
}

describe('change helpers', () => {
  it('reads porcelain output including renames and untracked files', () => {
    const out = [' M src/A.java', '?? src/New.java', 'R  src/B2.java', 'src/B.java', 'D  src/test/OldTest.java', ''].join('\0');
    expect(parsePorcelain(out)).toEqual([
      { path: 'src/A.java', status: 'M' },
      { path: 'src/New.java', status: '?' },
      { path: 'src/B2.java', status: 'R' },
      { path: 'src/B.java', status: 'D' },
      { path: 'src/test/OldTest.java', status: 'D' },
    ]);
  });

  it('commits only allowlisted paths and never service files', () => {
    const r = classify(
      [
        { path: 'src/A.java', status: 'M' },
        { path: 'notes.txt', status: '?' },
        { path: '.claude/TEAM-8/plan.md', status: '?' },
        { path: 'src/.DS_Store', status: '?' },
        { path: 'src/.env', status: '?' },
      ],
      ['src/**'],
    );
    expect(r.included.map((f) => f.path)).toEqual(['src/A.java']);
    expect(r.excluded.map((f) => f.path)).toEqual(['notes.txt', '.claude/TEAM-8/plan.md', 'src/.DS_Store', 'src/.env']);
  });

  it('reads renames in the worktree column, skips files added and then deleted, finds conflicts', () => {
    expect(parsePorcelain([' R src/New.java', 'src/Old.java', 'AD src/Gone.java', 'UU src/C.java', ''].join('\0'))).toEqual([
      { path: 'src/New.java', status: 'R' },
      { path: 'src/Old.java', status: 'D' },
      { path: 'src/C.java', status: 'U' },
    ]);
    expect(unmergedPaths(['UU src/C.java', 'AA src/D.java', ' M src/E.java', ''].join('\0'))).toEqual(['src/C.java', 'src/D.java']);
  });

  it('finds files whose added lines break the personal text style, and only by the rules the style turns on', () => {
    const diff = ['+++ b/src/A.java', '+  // Проверка — вход', '+++ b/src/B.java', '+  int x = 1;', '-  // старое — было', ''].join('\n');
    const files = [{ path: 'src/New.java', text: '/** Всё */' }, { path: 'src/Ok.java', text: 'ok' }];
    expect(styleOffenders(diff, files, STYLE)).toEqual(['src/A.java', 'src/New.java']);
    expect(styleOffenders(diff, files, { yo: true, dash: false, quotes: false })).toEqual(['src/New.java']);
    expect(styleOffenders(diff, files, { yo: false, dash: false, quotes: false })).toEqual([]);
  });

  it('finds deleted tests and tests with removed lines, and tells extended ones apart', () => {
    const changes = [
      { path: 'src/test/java/ATest.java', status: 'M' },
      { path: 'src/test/java/BTest.java', status: 'D' },
      { path: 'src/test/java/CTest.java', status: '?' },
      { path: 'src/test/java/DTest.java', status: 'M' },
      { path: 'src/main/java/A.java', status: 'D' },
    ];
    expect(testChanges(changes, new Set(['src/test/java/ATest.java']))).toEqual({
      deleted: ['src/test/java/BTest.java'],
      modified: ['src/test/java/ATest.java'],
      extended: ['src/test/java/DTest.java'],
    });
    expect(removesLines(['--- a/x', '+++ b/x', '@@ -1 +1,2 @@', '+  added', ''].join('\n'))).toBe(false);
    expect(removesLines(['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-  assertEquals(2, x);', '+  assertTrue(x > 0);', ''].join('\n'))).toBe(true);
  });
});

describe('code.publish', () => {
  it('shows one approval for the commit of allowlisted files, the push, the PR and the Jira move', async () => {
    const t = setup();
    write(t.work, 'src/main/java/demo/A.java', 'class A { int limit = 5; }\n');
    write(t.work, 'src/test/java/demo/ATest.java', 'class ATest {}\n');
    write(t.work, '.claude/TEAM-8/plan.md', '# План\n');
    write(t.work, 'notes.txt', 'черновик\n');
    const { draft, preview } = await t.gate();
    expect(draft).toMatchObject({ subject: 'TEAM-8 Лимит попыток входа - "пять"', prTitle: 'TEAM-8 Лимит попыток входа - "пять"', prDescription: '- Счетчик попыток\n- Проверено тестами' });
    expect(preview.actions).toEqual([
      'Коммит в feature/TEAM-8, файлов: 2 (src/main/java/demo/A.java, src/test/java/demo/ATest.java)',
      'Пуш feature/TEAM-8 в origin, коммитов: 1 (новая ветка)',
      'Создать PR feature/TEAM-8 → master в CLOUD/demo',
      'Jira: In Progress → Ready to Review, переход "Готово к ревью"',
    ]);
    expect(preview.warnings).toEqual(['Не войдут в коммит (вне allowlist профиля или служебные): .claude/TEAM-8/plan.md, notes.txt']);
    expect(preview.texts?.map((x) => [x.id, x.publish])).toEqual([['commit', true], ['prTitle', true], ['prDescription', true]]);
    // Описание PR в Bitbucket - markdown, и подтверждение показывает его отрисованным; коммит и заголовок - обычный текст.
    expect(preview.texts?.map((x) => x.format ?? null)).toEqual([null, null, 'markdown']);
    expect(preview.lint?.map((i) => i.message)).toEqual(expect.arrayContaining(['Коммит: длинное тире заменено дефисом', 'Описание PR: буква е с точками заменена на е']));
    const req = t.agent.requests[0]!;
    expect(req.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(req.prompt).toContain('https://jira.example.org/browse/TEAM-8');
    expect(req.prompt).toContain('src/test/java/demo/ATest.java (новый)');
  });

  it('commits exactly the approved files, pushes, opens the PR and moves the issue', async () => {
    const t = setup();
    write(t.work, 'src/main/java/demo/A.java', 'class A { int limit = 5; }\n');
    write(t.work, 'notes.txt', 'черновик\n');
    git(t.work, 'add', 'notes.txt');
    const { draft } = await t.gate();
    const out = (await step.run(t.ctx({ draft }))) as { commitSha: string; pr: PullRequestRef; status: string };
    expect(git(t.work, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual(['TEAM-8 Лимит попыток входа - "пять"', '', 'src/main/java/demo/A.java']);
    expect(git(t.work, 'status', '--porcelain')).toContain('?? notes.txt');
    expect(git(t.work, 'ls-remote', 'origin', 'refs/heads/feature/TEAM-8').split('\t')[0]).toBe(out.commitSha);
    expect(t.scm.created).toEqual([{ ref: { contour: 'cloud', project: 'CLOUD', repo: 'demo' }, input: expect.objectContaining({ from: 'feature/TEAM-8', to: 'master', title: 'TEAM-8 Лимит попыток входа - "пять"' }) }]);
    expect(out).toMatchObject({ pr: { id: 271 }, status: 'Ready to Review' });
    expect(t.jira.state.moves).toEqual(['971']);
    expect(await step.done!(t.ctx())).toMatchObject({ note: 'Все опубликовано: PR #271; вне allowlist остались изменения: notes.txt' });
  });

  it('does not warn when tests were only added to an existing test file, and warns when an assertion changed', async () => {
    const t = setup();
    // Исходный тест лежит в master, ветка отходит от него: дифф ветки считается от точки отхода.
    git(t.work, 'switch', '-q', 'master');
    commit(t.work, 'src/test/java/demo/OldTest.java', 'class OldTest {\n  @Test void a() { assertEquals(1, 1); }\n}\n', 'тест в master');
    git(t.work, 'push', '-q', 'origin', 'master');
    git(t.work, 'switch', '-q', 'feature/TEAM-8');
    git(t.work, 'merge', '-q', '--ff-only', 'master');
    write(t.work, 'src/test/java/demo/OldTest.java', 'class OldTest {\n  @Test void a() { assertEquals(1, 1); }\n  @Test void b() { assertEquals(2, 2); }\n}\n');
    const added = await t.gate();
    expect(added.preview.warnings?.some((w) => w.includes('Изменены существующие тесты'))).toBe(false);
    write(t.work, 'src/test/java/demo/OldTest.java', 'class OldTest {\n  @Test void a() { assertTrue(true); }\n}\n');
    const weakened = await t.gate();
    expect(weakened.preview.warnings).toContain('Изменены существующие тесты: src/test/java/demo/OldTest.java');
  });

  it('highlights deleted and modified existing tests on the approval', async () => {
    const t = setup();
    unlinkSync(join(t.work, 'src/test/java/demo/OldTest.java'));
    commit(t.work, 'src/main/java/demo/A.java', 'class A { }\n');
    const { preview } = await t.gate();
    expect(preview.warnings).toContain('Удалены тесты: src/test/java/demo/OldTest.java');
  });

  it('pushes a rebased branch with --force-with-lease on the version seen at approval', async () => {
    const t = setup({ status: 'Ready to Review' });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 первая версия');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    git(t.work, 'commit', '-q', '--amend', '-m', 'TEAM-8 переписано ребейзом');
    const { draft, preview } = await t.gate();
    expect(preview.actions[0]).toContain('с --force-with-lease');
    expect((preview.payload as { push: { force: boolean } }).push.force).toBe(true);
    await step.run(t.ctx({ draft }));
    expect(git(t.work, 'log', '-1', '--format=%s', 'origin/feature/TEAM-8').trim()).toBe('TEAM-8 переписано ребейзом');
  });

  it('rewrites the texts in the same agent session with the owner comment', async () => {
    const t = setup();
    write(t.work, 'src/main/java/demo/A.java', 'class A { int limit = 5; }\n');
    const first = await t.gate();
    await t.gate('короче, без второго пункта', first.draft);
    const req = t.agent.requests[1]!;
    expect(req.resume).toBe('s-1');
    expect(req.prompt).toContain('<замечание>\nкороче, без второго пункта\n</замечание>');
    expect(req.prompt).toContain('<коммит>\nTEAM-8 Лимит попыток входа - "пять"\n</коммит>');
  });

  it('opens a PR for already pushed commits without committing again', async () => {
    const t = setup({ status: 'Ready to Review' });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 готово');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    const { preview } = await t.gate();
    expect(preview.actions).toEqual(['Создать PR feature/TEAM-8 → master в CLOUD/demo']);
    expect(preview.texts?.map((x) => x.id)).toEqual(['prTitle', 'prDescription']);
  });

  it('tells the text agent that a commit after the stand test is the rework of the failed AC', async () => {
    const open = [{ id: 262, title: 'TEAM-8', url: 'https://git.example.org/pr/262' }];
    const t = setup({ status: 'Ready to Review', open, values: { changes: { summary: 'Счетчик попыток' }, qaFix: { round: 1, summary: 'Сброс счетчика после входа' } } });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 готово');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    write(t.work, 'src/main/java/demo/A.java', 'class A { int v = 0; }\n');
    const { preview } = await t.gate();
    const prompt = t.agent.requests[0]!.prompt;
    expect(prompt).toContain('Что сделала реализация: Счетчик попыток');
    expect(prompt).toContain('Коммит - доработка после теста на стенде, круг 1: Сброс счетчика после входа.');
    expect(preview.texts?.map((x) => x.id)).toEqual(['commit']);
  });

  it('tells the text agent about fixes after the review comments when they are the latest rework of the run', async () => {
    const open = [{ id: 262, title: 'TEAM-8', url: 'https://git.example.org/pr/262' }];
    const prReview = { pr: 262, replies: [], summary: 'Добавлены debug-логи перед return', files: ['src/main/java/demo/A.java'], tests: [], pending: true, base: 'x', at: '2026-09-23T12:00:00.000Z' };
    const qaFix = { round: 1, summary: 'Сброс счетчика', at: '2026-09-23T10:00:00.000Z' };
    const t = setup({ status: 'Ready to Review', open, values: { prReview, qaFix } });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 готово');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    write(t.work, 'src/main/java/demo/A.java', 'class A { int v = 0; }\n');
    await t.gate();
    const prompt = t.agent.requests[0]!.prompt;
    expect(prompt).toContain('Коммит - исправления по замечаниям ревьюеров в PR #262: Добавлены debug-логи перед return.');
    expect(prompt).not.toContain('доработка после теста на стенде');
  });

  it('asks nothing of the agent when there is nothing to commit and the PR is open', async () => {
    const t = setup({ status: 'In Progress', open: [{ id: 262, title: 'TEAM-8', url: 'https://git.example.org/pr/262' }] });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 готово');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    const { preview } = await t.gate();
    expect(t.agent.requests).toHaveLength(0);
    expect((preview as Preview).actions).toEqual(['Jira: In Progress → Ready to Review, переход "Готово к ревью"']);
    expect(preview.summary).toContain('PR #262 уже открыт');
  });

  it('keeps the issue in its status when the move is switched off in the step settings', async () => {
    const t = setup({ status: 'In Progress', open: [{ id: 262, title: 'TEAM-8', url: 'https://git.example.org/pr/262' }], params: { moveTo: 'none' } });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 готово');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    // Все запушено и PR открыт: без перевода по доске публиковать нечего.
    expect(await step.done!(t.ctx())).toMatchObject({ note: 'Все опубликовано: PR #262' });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 2; }\n', 'TEAM-8 еще правка');
    const { preview } = await t.gate();
    expect(preview.actions).toContain('Jira: задача остается в статусе In Progress, перевод по доске выключен в настройках шага');
    expect(preview.actions.some((a) => a.includes('Ready to Review'))).toBe(false);
  });

  it('refuses to force push over a commit a colleague pushed to the branch', async () => {
    const t = setup({ status: 'Ready to Review' });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 моя версия');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    const colleague = join(t.root, 'colleague');
    git(t.root, 'clone', '-q', '-b', 'feature/TEAM-8', t.origin, colleague);
    commit(colleague, 'src/main/java/demo/B.java', 'class B {}\n', 'TEAM-8 правка коллеги');
    git(colleague, 'push', '-q', 'origin', 'feature/TEAM-8');
    git(t.work, 'commit', '-q', '--amend', '-m', 'TEAM-8 переписано');
    await expect(t.gate()).rejects.toThrow('правка коллеги');
    expect(git(t.origin, 'log', '-1', '--format=%s', 'feature/TEAM-8').trim()).toBe('TEAM-8 правка коллеги');
  });

  it('refuses to publish when the local branch is only behind the remote one', async () => {
    const t = setup({ status: 'Ready to Review' });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 версия');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    const colleague = join(t.root, 'colleague');
    git(t.root, 'clone', '-q', '-b', 'feature/TEAM-8', t.origin, colleague);
    commit(colleague, 'src/main/java/demo/B.java', 'class B {}\n', 'TEAM-8 новее');
    git(colleague, 'push', '-q', 'origin', 'feature/TEAM-8');
    write(t.work, 'src/main/java/demo/A.java', 'class A { int v = 2; }\n');
    await expect(t.gate()).rejects.toThrow('Подтяните их, повторив шаг "Ветка"');
  });

  it('stops on unresolved conflicts and on an unfinished merge', async () => {
    const t = setup();
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 ветка');
    git(t.work, 'switch', '-q', 'master');
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 2; }\n', 'master');
    git(t.work, 'switch', '-q', 'feature/TEAM-8');
    try {
      git(t.work, 'merge', '-q', 'master');
    } catch {
      // ожидаемый конфликт
    }
    await expect(t.gate()).rejects.toThrow('не закончена операция git (MERGE_HEAD)');
  });

  it('commits a case-only rename made with git mv exactly as approved', async () => {
    const t = setup();
    commit(t.work, 'src/main/java/demo/foo.java', 'class foo {}\n', 'TEAM-8 было');
    git(t.work, 'mv', 'src/main/java/demo/foo.java', 'src/main/java/demo/Foo.java');
    write(t.work, 'src/main/java/demo/Foo.java', 'class Foo {}\n');
    const { draft, preview } = await t.gate();
    expect((preview.payload as { files: string[] }).files).toEqual(expect.arrayContaining(['R src/main/java/demo/Foo.java', 'D src/main/java/demo/foo.java']));
    await step.run(t.ctx({ draft }));
    const tree = git(t.work, 'ls-tree', '--name-only', 'HEAD', 'src/main/java/demo/').trim().split('\n');
    expect(tree).toContain('src/main/java/demo/Foo.java');
    expect(tree).not.toContain('src/main/java/demo/foo.java');
    expect(git(t.work, 'show', 'HEAD:src/main/java/demo/Foo.java')).toBe('class Foo {}\n');
  });

  it('does not commit a file that changed between the approval and the commit', async () => {
    const t = setup();
    write(t.work, 'src/main/java/demo/A.java', 'class A { int approved = 1; }\n');
    const draft = await step.prepare!(t.ctx());
    const c = t.ctx({ draft });
    await step.preview!(c);
    write(t.work, 'src/main/java/demo/A.java', 'class A { int sneaky = 1; }\n');
    await expect(step.run(c)).rejects.toThrow('Файлы изменились после подтверждения: src/main/java/demo/A.java');
    expect(git(t.work, 'log', '-1', '--format=%s').trim()).toBe('init');
  });

  it('does not push a commit that a repository hook rewrote', async () => {
    const t = setup();
    write(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n');
    const hook = join(t.work, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\necho "Подмена заголовка" > "$1"\n');
    chmodSync(hook, 0o755);
    const { draft } = await t.gate();
    await expect(step.run(t.ctx({ draft }))).rejects.toThrow('отличается от подтвержденного (сообщение коммита), пуш не выполнен');
    expect(git(t.origin, 'branch', '--list', 'feature/TEAM-8').trim()).toBe('');
  });

  it('says there is nothing to publish when the branch has no commits and no allowlisted changes', async () => {
    const t = setup();
    write(t.work, 'notes.txt', 'черновик\n');
    await expect(step.prepare!(t.ctx())).rejects.toThrow('Публиковать нечего: в ветке feature/TEAM-8 нет коммитов и изменений из allowlist; вне allowlist: notes.txt');
    expect(t.agent.requests).toHaveLength(0);
  });

  it('does not take a PR into another branch for the task PR', async () => {
    const t = setup({ status: 'Ready to Review', open: [{ id: 300, title: 'бэкпорт', url: 'u', to: 'release/1.2' }] });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 готово');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    const { preview } = await t.gate();
    expect(preview.actions).toEqual(['Создать PR feature/TEAM-8 → master в CLOUD/demo']);
  });

  it('stops when Bitbucket does not see a branch that exists on the remote', async () => {
    const scm: ScmPort = {
      openPullRequests: async () => null,
      createPullRequest: async () => ({ id: 1, title: '', url: '' }),
      findPullRequest: async () => null,
      pullRequest: async () => {
        throw new Error('не нужно');
      },
      reply: async () => {},
    };
    const t = setup({ status: 'Ready to Review', scm });
    commit(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n', 'TEAM-8 готово');
    git(t.work, 'push', '-q', '-u', 'origin', 'feature/TEAM-8');
    await expect(t.gate()).rejects.toThrow('проверьте bitbucket.project и bitbucket.repo в профиле');
  });

  it('does not fail a dry run before the branch folder exists', async () => {
    const t = setup({ dryRun: true, worktree: '/нет/такой/папки' });
    expect(await step.done!(t.ctx())).toBeNull();
    expect((await step.preview!(t.ctx({ draft: {} }))).warnings?.[0]).toContain('Пробный прогон: рабочей папки ветки еще нет');
  });

  it('warns about owner text style inside the changed code', async () => {
    const t = setup();
    write(t.work, 'src/main/java/demo/A.java', 'class A {\n  // Проверка — вход\n}\n');
    const { preview } = await t.gate();
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringContaining('В текстах кода (Javadoc, комментарии, строки) есть то, что запрещает личный стиль (е с точками, длинное тире, типографские кавычки): src/main/java/demo/A.java')]));
  });

  it('keeps е с точками, long dashes and typographic quotes in texts and code of someone without a personal style', async () => {
    const t = setup({ style: { yo: false, dash: false, quotes: false } });
    write(t.work, 'src/main/java/demo/A.java', 'class A {\n  // Проверка — вход\n}\n');
    const { draft, preview } = await t.gate();
    expect(draft).toMatchObject({ subject: 'TEAM-8 Лимит попыток входа — «пять»', prDescription: '- Счётчик попыток\n- Проверено тестами' });
    expect(preview.warnings?.some((w) => w.includes('личный стиль'))).toBe(false);
    expect(preview.lint?.filter((i) => i.severity === 'fixed')).toEqual([]);
  });

  it('asks to prepare the texts again when a commit became necessary after an empty draft', async () => {
    const t = setup();
    write(t.work, 'src/main/java/demo/A.java', 'class A { int v = 1; }\n');
    const stale = { sessionId: null, subject: '', body: '', prTitle: '', prDescription: '', fixed: [], needs: { commit: false, pr: false } };
    await expect(step.preview!(t.ctx({ draft: stale }))).rejects.toThrow('Состав публикации изменился');
  });

  it('passes paths to git literally, so brackets in a name do not match other files', async () => {
    const t = setup();
    commit(t.work, 'src/pages/i.tsx', 'export {};\n', 'TEAM-8 страница');
    write(t.work, 'src/pages/[id].tsx', 'export {};\n');
    const draft = await step.prepare!(t.ctx());
    const c = t.ctx({ draft });
    await step.preview!(c);
    // Файл, подходящий под шаблон [id] как glob, меняется после подтверждения: в коммит он попасть не должен.
    write(t.work, 'src/pages/i.tsx', 'export const changed = 1;\n');
    await step.run(c);
    expect(git(t.work, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('src/pages/[id].tsx');
    expect(git(t.work, 'status', '--porcelain')).toContain(' M src/pages/i.tsx');
  });

  it('refuses to work in a worktree where another branch is checked out', async () => {
    const t = setup();
    git(t.work, 'switch', '-q', 'master');
    await expect(step.prepare!(t.ctx())).rejects.toThrow('а не feature/TEAM-8');
  });
});
