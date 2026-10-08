import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest, Issue, JiraConfig, JiraPort, Preview } from '../../packages/step-kit/src/index.ts';
import { memoryJiraFiles } from '../../apps/server/src/demo/jira-files.ts';
import { fakeAgent, TEST_JIRA, testContext, testRepo } from '../_test/context.ts';
import type { Plan } from '../../packages/step-kit/src/index.ts';
import step from './index.ts';

const KEY = 'TEAM-9';
/** Доска с путем до MERGED: In Testing на ней после In Progress. */
const JIRA: JiraConfig = {
  ...TEST_JIRA,
  path: [...TEST_JIRA.path, { from: 'To Testing', id: '751', name: 'Взять в тестирование', to: 'In Testing' }],
};
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  key: KEY,
  summary: 'Капча перед SMS',
  status: 'In Testing',
  url: '',
  labels: [],
  components: [],
  sprint: null,
  assignee: null,
  updated: '2026-09-23T10:00:00.000+0300',
  description: 'Показывать капчу.\n\n## Критерии приемки\n- капча при фроде\n- SMS после капчи',
  ...over,
});

function setup(opts: { snapshot?: Issue; fresh?: Issue; values?: Record<string, unknown>; plan?: boolean; agentPlan?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-rework-')));
  roots.push(root);
  const repoPath = join(root, 'repo');
  mkdirSync(join(repoPath, '.claude', KEY), { recursive: true });
  if (opts.plan !== false) writeFileSync(join(repoPath, '.claude', KEY, 'plan.md'), '# План\n\nКапча перед SMS.\n');
  const fresh = opts.fresh ?? issue();
  const jira: JiraPort = {
    search: async () => [],
    getIssue: async () => fresh,
    getTransitions: async () => [],
    transition: async () => {},
    assign: async () => {},
    sprints: async () => [],
    ...memoryJiraFiles().port,
  };
  const agent = fakeAgent((req: AgentRequest) => {
    writeFileSync(join(req.writeDirs![0]!, 'plan.md'), opts.agentPlan ?? '# План\n\nКапча перед SMS.\n\n## Доработка\n\nТретий критерий: капча на входе по QR.\n');
    return { output: { summary: 'Добавить капчу на вход по QR', questions: ['Капча на QR тоже с порогом фрода?'] } };
  });
  const c = testContext({ issueKey: KEY, repo: testRepo(repoPath, join(root, 'wt')), ports: { jira }, jira: JIRA, agent: agent.agent, values: { issue: opts.snapshot ?? issue(), ...opts.values } });
  return { c, agent, repoPath, fresh };
}

const RETURNED = issue({
  status: 'In Progress',
  updated: '2026-09-23T12:00:00.000+0300',
  description: 'Показывать капчу.\n\n## Критерии приемки\n- капча при фроде\n- SMS после капчи\n- капча на входе по QR',
});

describe('task.rework', () => {
  it('shows what changed in the task and has the agent update the plan without touching the code', async () => {
    const t = setup({ fresh: RETURNED, values: { worktree: '/wt/demo-TEAM-9' } });
    const draft = await step.prepare!(t.c);
    const preview = (await step.preview!({ ...t.c, draft })) as Preview;

    const req = t.agent.requests[0]!;
    expect(req).toMatchObject({ label: 'доработка задачи', cwd: '/wt/demo-TEAM-9', writeCwd: false, mcp: ['atlassian'] });
    expect(req.prompt).toContain('- статус In Testing → In Progress, задачу вернули');
    expect(req.prompt).toContain('- критерии приемки: было 2, стало 3');
    expect(req.prompt).toContain('+ - капча на входе по QR');
    expect(req.prompt).toContain('3. капча на входе по QR');
    expect(req.prompt).toContain('Утвержденный план лежит в файле');

    expect(preview.texts?.map((x) => [x.id, x.publish])).toEqual([
      ['changes', false],
      ['plan', false],
    ]);
    expect(preview.texts![0]!.text).toContain('+ - капча на входе по QR');
    expect(preview.questions).toEqual(['Капча на QR тоже с порогом фрода?']);
    expect(readFileSync(join(t.repoPath, '.claude', KEY, 'plan.md'), 'utf8')).toContain('## Доработка');
  });

  it('takes the fresh task into the run and clears the found changes once the plan is approved', async () => {
    const t = setup({ fresh: RETURNED });
    const draft = await step.prepare!(t.c);
    const out = (await step.run({ ...t.c, draft })) as { plan: Plan; issue: Issue; ac: string[]; issueChanged: null; issueSeen: string };
    expect(out.plan).toMatchObject({ summary: 'Добавить капчу на вход по QR', questions: ['Капча на QR тоже с порогом фрода?'] });
    expect(out.issue.status).toBe('In Progress');
    expect(out.ac).toEqual(['капча при фроде', 'SMS после капчи', 'капча на входе по QR']);
    expect(out).toMatchObject({ status: 'In Progress', issueChanged: null, issueSeen: '2026-09-23T12:00:00.000+0300' });
  });

  it('compares the task with the status the run put it in, not with the status it had when the run opened', async () => {
    const opened = issue({ status: 'In Progress' });
    expect(await step.done!(setup({ snapshot: opened, fresh: { ...opened, status: 'In Testing' }, values: { status: 'In Testing' } }).c)).toEqual({ note: 'Постановка задачи не менялась: план остается прежним' });
    const t = setup({ snapshot: opened, fresh: RETURNED, values: { status: 'In Testing' } });
    await step.prepare!(t.c);
    expect(t.agent.requests[0]!.prompt).toContain('- статус In Testing → In Progress, задачу вернули');
  });

  it('asks to write a plan from scratch when the task has none', async () => {
    const t = setup({ fresh: RETURNED, plan: false });
    await step.prepare!(t.c);
    expect(t.agent.requests[0]!.prompt).toContain('Плана еще нет: составь его в файле');
  });

  it('is done when the task did not change, and not done when the watcher flagged changes', async () => {
    expect(await step.done!(setup().c)).toEqual({ note: 'Постановка задачи не менялась: план остается прежним' });
    const flagged = { at: 'x', status: 'In Testing', changes: [{ kind: 'comments', text: 'новые комментарии: 1' }] };
    expect(await step.done!(setup({ values: { issueChanged: flagged } }).c)).toBeNull();
    expect(await step.done!(setup({ fresh: RETURNED }).c)).toBeNull();
  });

  it('keeps the criteria of the plan up to date while the task description has none', async () => {
    const plan = { file: '/repo/.claude/TEAM-9/plan.md', hash: 'h', summary: 's', questions: [], ac: ['капча при фроде'] };
    const t = setup({
      snapshot: issue({ description: 'Показывать капчу.' }),
      fresh: issue({ description: 'Показывать капчу.', status: 'In Progress', updated: '2026-09-23T12:00:00.000+0300' }),
      values: { ac: null, plan },
      agentPlan: '# План\n\n## Критерии приемки\n\n1. капча при фроде\n2. капча на входе по QR\n',
    });
    const draft = await step.prepare!(t.c);
    const prompt = t.agent.requests[0]!.prompt;
    expect(prompt).toContain('Критерии приемки сейчас:\nв описании задачи их нет, список утвержден с планом (раздел "Критерии приемки" в /repo/.claude/TEAM-9/plan.md):\n1. капча при фроде');
    expect(prompt).toContain('Если раздел в плане уже есть, сохрани номера пунктов');
    const preview = (await step.preview!({ ...t.c, draft })) as Preview;
    expect(preview.actions).toContain('Критерии приемки из раздела плана (2): по ним пойдут реализация, тест на стенде и итоги в Jira, в описании задачи их нет');
    const out = (await step.run({ ...t.c, draft })) as { plan: Plan; ac: string[] | null };
    expect(out.plan.ac).toEqual(['капча при фроде', 'капча на входе по QR']);
    expect(out.ac).toBeNull();
  });

  it('asks the agent to drop the criteria section of the plan once the task description has criteria', async () => {
    const plan = { file: '/repo/.claude/TEAM-9/plan.md', hash: 'h', summary: 's', questions: [], ac: ['капча при фроде'] };
    const t = setup({ snapshot: issue({ description: 'Показывать капчу.' }), fresh: RETURNED, values: { ac: null, plan } });
    const draft = await step.prepare!(t.c);
    expect(t.agent.requests[0]!.prompt).toContain('раздел "Критерии приемки" в плане больше не нужен, убери его');
    const out = (await step.run({ ...t.c, draft })) as { plan: Plan; ac: string[] | null };
    expect(out.plan).not.toHaveProperty('ac');
    expect(out.ac).toEqual(['капча при фроде', 'SMS после капчи', 'капча на входе по QR']);
  });
});
