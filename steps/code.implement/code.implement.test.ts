import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Issue, Ports } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

const ISSUE = { key: 'TEAM-6', summary: 'Лимит попыток', status: 'In Progress', url: '', labels: [], components: [], sprint: null, assignee: null, description: 'Ограничить попытки' } as Issue;

function setup(values: Record<string, unknown> = {}, script: Parameters<typeof fakeAgent>[0] = () => ({ output: { summary: 'Сделано', files: ['src/A.java'], tests: ['src/ATest.java'], buildGreen: true } })) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'implement-')));
  const repo = { ...testRepo(join(root, 'repo'), join(root, 'wt')), build: { javaHome: '/jdk21', command: 'mvn -o package' } };
  const worktree = join(root, 'wt', 'demo-TEAM-6');
  mkdirSync(worktree, { recursive: true });
  const fake = fakeAgent(script);
  const c = testContext({ issueKey: 'TEAM-6', repo, ports: {} as Ports, agent: fake.agent, values: { issue: ISSUE, ac: [], worktree, ...values } });
  return { c, fake, worktree, repo, root };
}

/** Утвержденный план: файл и его хэш, как их кладет шаг анализа. */
function planIn(root: string, text = '# План\n') {
  const file = join(root, 'plan.md');
  writeFileSync(file, text);
  return { file, hash: createHash('sha256').update(text).digest('hex'), summary: 'Добавить счетчик', questions: [] };
}

describe('code.implement', () => {
  it('implements the approved plan in the worktree with the build of the profile under its JDK', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-')));
    const plan = planIn(root);
    const t = setup({ plan });
    const out = await step.run(t.c);
    expect(out).toEqual({ changes: { summary: 'Сделано', files: ['src/A.java'], tests: ['src/ATest.java'], buildGreen: true, sessionId: 's-1' } });
    const req = t.fake.requests[0]!;
    expect(req).toMatchObject({ label: 'реализация', cwd: t.worktree, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] });
    expect(req.allow).toEqual(expect.arrayContaining(['Bash(mvn *)', 'Bash(git diff *)']));
    expect(req.env).toMatchObject({ JAVA_HOME: '/jdk21' });
    expect(req.env?.PATH?.startsWith('/jdk21/bin:')).toBe(true);
    expect(req.prompt).toContain(`Утвержденный план лежит в файле ${plan.file}`);
    expect(req.prompt).toContain('`mvn -o package`');
    expect(req.prompt).toContain('## Правила для кода');
    expect(req.writeDirs).toEqual([join(t.repo.worktreesDir, '.task-pilot', 'demo-TEAM-6', 'docs')]);
    expect(req.prompt).toContain(join(t.repo.worktreesDir, '.task-pilot', 'demo-TEAM-6', 'docs', 'solution.md'));
  });

  it('refuses to work by a plan whose file is gone', async () => {
    const t = setup({ plan: { file: '/нет/plan.md', hash: 'dry-run', summary: 'x', questions: [] } });
    await expect(step.run(t.c)).rejects.toThrow('Файла утвержденного плана нет');
  });

  it('works by the current plan file when the owner edited it after approval and says so', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-')));
    const plan = planIn(root);
    writeFileSync(plan.file, '# План, правка владельца\n');
    const t = setup({ plan });
    await step.run(t.c);
    expect(t.c.logs[0]).toContain('изменен после утверждения');
  });

  it('works from the issue alone when there is no plan, as in a hotfix', async () => {
    const t = setup();
    await step.run(t.c);
    expect(t.fake.requests[0]!.prompt).toContain('Утвержденного плана нет: это срочная правка');
  });

  it('continues the interrupted agent session instead of starting over', async () => {
    let calls = 0;
    const t = setup({}, () => {
      calls += 1;
      if (calls === 1) throw new Error('Прервано перезапуском сервера');
      return { output: { summary: 'Доделано', files: [], tests: [], buildGreen: false } };
    });
    await expect(step.run(t.c)).rejects.toThrow('Прервано');
    const out = (await step.run(t.c)) as { changes: { buildGreen: boolean } };
    expect(t.fake.requests[1]).toMatchObject({ resume: 's-1' });
    expect(t.fake.requests[1]!.prompt).toContain('Прошлый запуск шага "Реализация" прервался');
    expect(out.changes.buildGreen).toBe(false);
    expect(t.c.logs.at(-1)).toContain('сборка не зеленая');
  });

  it('refuses to run without the build command in the repository profile', async () => {
    const t = setup();
    t.c.repo = { ...t.c.repo, build: undefined };
    await expect(step.run(t.c)).rejects.toThrow('нет команды сборки');
  });

  it('refuses a Java build without the JDK set in the profile or in personal settings', async () => {
    const t = setup();
    t.c.repo = { ...t.c.repo, build: { command: 'mvn package' } };
    await expect(step.run(t.c)).rejects.toThrow('нужен JDK 21: укажите javaHome в личных настройках ~/.task-pilot/profile.yaml');
    expect(t.fake.requests).toHaveLength(0);
  });
});
