import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AcCheck, Issue, Ports, QaFix, QaReport } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

const KEY = 'TEAM-9';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ISSUE = { key: KEY, summary: 'Капча перед SMS', status: 'To Testing', url: '', labels: [], components: [], sprint: null, assignee: null, description: '' } as Issue;

const check = (ac: string, result: AcCheck['result'], files: string[] = []): AcCheck => ({
  ac,
  scenario: `сценарий ${ac}`,
  action: `действие ${ac}`,
  expected: `ожидаемое ${ac}`,
  result,
  note: `факт ${ac}`,
  files,
});

const report = (results: AcCheck[]): QaReport => ({
  at: '2026-09-23T10:00:00.000Z',
  stand: 'testing-5',
  build: '1.0.4-246',
  summary: 'Прогон закончен',
  results,
  remarks: [],
  guide: '/repo/.claude/TEAM-9/qa-guide.md',
  report: '/repo/.claude/TEAM-9/qa-report.md',
  artifacts: '/repo/.claude/artifacts/TEAM-9/qa',
  missing: [],
});

const FIXED = { cause: 'code', summary: 'Капча не показывалась после второй попытки: исправлено условие', files: ['src/main/java/demo/Captcha.java'], tests: ['src/test/java/demo/CaptchaTest.java'], buildGreen: true };

function setup(values: Record<string, unknown> = {}, output: Record<string, unknown> = FIXED) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-fix-')));
  roots.push(root);
  const repo = { ...testRepo(join(root, 'repo'), join(root, 'wt')), build: { javaHome: '/jdk21', command: 'mvn -o verify' } };
  const worktree = join(root, 'wt', `demo-${KEY}`);
  mkdirSync(worktree, { recursive: true });
  const fake = fakeAgent(() => ({ output, text: 'итог' }));
  const qaReport = report([check('1', 'пройден', ['01.png']), check('2', 'не пройден', ['02-no-captcha.png', 'kibana-logs-02.png']), check('3', 'частично'), check('4', 'не проверен')]);
  const c = testContext({ issueKey: KEY, repo, ports: {} as Ports, agent: fake.agent, values: { issue: ISSUE, ac: ['a', 'b', 'c', 'd'], worktree, branch: `feature/${KEY}`, qaReport, ...values } });
  return { c, fake, worktree };
}

describe('qa.fix', () => {
  it('fixes the failed and partly passed AC in the worktree by the report, the evidence and the logs, and does not commit', async () => {
    const t = setup();
    const out = (await step.run(t.c)) as { qaFix: QaFix };

    const req = t.fake.requests[0]!;
    expect(req).toMatchObject({ label: 'доработка по тесту', cwd: t.worktree, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] });
    expect(req.allow).toEqual(expect.arrayContaining(['Bash(git diff *)', 'Bash(mvn *)', 'mcp__pipeline__qa_kibana_logs', 'mcp__pipeline__qa_browser']));
    expect(req.allow?.some((a) => a.includes('commit') || a.includes('push'))).toBe(false);
    expect(req.env).toMatchObject({ JAVA_HOME: '/jdk21' });
    expect(req.prompt).toContain('Это круг доработки 1.');
    expect(req.prompt).toContain('- AC 2 (не пройден): сценарий 2. Действие: действие 2. Ожидалось: ожидаемое 2. Факт: факт 2. Кадры: 02-no-captcha.png, kibana-logs-02.png');
    expect(req.prompt).toContain('- AC 3 (частично)');
    expect(req.prompt).not.toContain('- AC 1 ');
    expect(req.prompt).not.toContain('- AC 4 ');
    expect(req.prompt).toContain('Отчет о прогоне: /repo/.claude/TEAM-9/qa-report.md');
    expect(req.prompt).toContain('/repo/.claude/artifacts/TEAM-9/qa');
    expect(req.prompt).toContain('`mvn -o verify`');
    expect(req.prompt).toContain('## Правила для кода');

    expect(out.qaFix).toMatchObject({ round: 1, failed: ['2', '3'], summary: FIXED.summary, files: FIXED.files, tests: FIXED.tests, buildGreen: true });
    expect(t.c.logs.at(-1)).toBe('Круг 1: исправлено по AC 2, 3, файлов 1, сборка зеленая');
  });

  it('counts the round from the rounds the loop already made', async () => {
    const t = setup({ loops: { 'qa.fix': 2 } });
    const out = (await step.run(t.c)) as { qaFix: QaFix };
    expect(t.fake.requests[0]!.prompt).toContain('Это круг доработки 3.');
    expect(out.qaFix.round).toBe(3);
  });

  it('fails with the reason instead of making a pointless round when the cause is not in the code', async () => {
    const t = setup({}, { ...FIXED, cause: 'config', summary: 'На стенде выключена капча в админке', files: [] });
    await expect(step.run(t.c)).rejects.toThrow('AC 2, 3 кодом не исправить (причина в настройках или конфиге): На стенде выключена капча в админке');
    await expect(step.run(setup({}, { ...FIXED, cause: 'environment', files: [] }).c)).rejects.toThrow('причина в окружении стенда');
    await expect(step.run(setup({}, { ...FIXED, cause: 'странное' }).c)).rejects.toThrow('причина не найдена');
  });

  it('fails when the agent says the cause is in the code but changed nothing', async () => {
    const t = setup({}, { ...FIXED, files: [] });
    await expect(step.run(t.c)).rejects.toThrow('AC 2, 3 кодом не исправить (агент ничего не изменил)');
  });

  it('is done when no AC failed, so the loop ends', async () => {
    expect(await step.done!(setup({ qaReport: report([check('1', 'пройден'), check('2', 'не проверен')]) }).c)).toEqual({ note: 'Непройденных AC нет, не проверено 1: дорабатывать нечего' });
    expect(await step.done!(setup({ qaReport: report([check('1', 'пройден')]) }).c)).toEqual({ note: 'Непройденных AC нет: дорабатывать нечего' });
    expect(await step.done!(setup().c)).toBeNull();
  });

  it('needs the worktree of the branch', async () => {
    const t = setup({ worktree: undefined });
    await expect(step.run(t.c)).rejects.toThrow('Нет рабочей папки ветки');
  });
});
