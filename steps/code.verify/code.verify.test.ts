import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGit } from '../../apps/server/src/integrations/git.ts';
import type { Issue, Ports, ShellPort, ShellResult, TestReport } from '../../packages/step-kit/src/index.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import { branchRepo, gitIdentity, write } from '../_test/git.ts';
import step, { problemsOf } from './index.ts';
import { declaresTests, parseSuite, testClassOf } from './surefire.ts';

const roots: string[] = [];
beforeAll(gitIdentity);
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Suites = Record<string, { tests: number; failures?: number }>;

/** Сборка в тесте: пишет отчеты surefire и возвращает код выхода по сценарию. */
function fakeShell(script: ((n: number) => { code: number; output?: string; suites?: Suites; aborted?: boolean })[]) {
  const calls: { command: string; env?: Record<string, string>; logFile?: string }[] = [];
  const shell: ShellPort = {
    async run(command, options) {
      calls.push({ command, env: options.env, logFile: options.logFile });
      const step = script[Math.min(calls.length, script.length) - 1]!(calls.length);
      const dir = join(options.cwd, 'target', 'surefire-reports');
      mkdirSync(dir, { recursive: true });
      for (const [name, s] of Object.entries(step.suites ?? {})) {
        writeFileSync(join(dir, `TEST-${name}.xml`), `<?xml version="1.0"?>\n<testsuite name="${name}" tests="${s.tests}" failures="${s.failures ?? 0}" errors="0" skipped="0" time="0.1">\n</testsuite>`);
      }
      return { code: step.code, output: step.output ?? 'BUILD', durationMs: 1, timedOut: false, aborted: step.aborted ?? false } satisfies ShellResult;
    },
  };
  return { shell, calls };
}

function setup(shellScript: Parameters<typeof fakeShell>[0], agentScript?: Parameters<typeof fakeAgent>[0], values: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  const { root, work } = branchRepo('TEAM-7', { 'src/main/java/demo/A.java': 'class A {}\n', 'src/test/java/demo/OldTest.java': 'class OldTest { @Test void old() {} }\n' });
  roots.push(root);
  write(work, 'src/test/java/demo/ATest.java', 'class ATest { @Test void works() {} }\n');
  // Вспомогательный класс с подходящим именем: surefire его не запускает, и отчета по нему не ждут.
  write(work, 'src/test/java/demo/TestData.java', 'class TestData { static final int N = 1; }\n');
  const shell = fakeShell(shellScript);
  const agent = fakeAgent(agentScript ?? ((req) => (req.label === 'ревью' ? { output: { findings: [] } } : {})));
  const repo = { ...testRepo(join(root, 'repo'), join(root, 'wt')), build: { javaHome: '/jdk21', command: 'mvn -o package' } };
  const issue = { key: 'TEAM-7', summary: 'Проверка', status: 'In Progress', url: '', labels: [], components: [], sprint: null, assignee: null, description: '' } as Issue;
  const c = testContext({
    issueKey: 'TEAM-7',
    repo,
    ports: { git: createGit(), shell: shell.shell } as unknown as Ports,
    agent: agent.agent,
    values: { worktree: work, issue, ...values },
    params,
  });
  return { c, work, shell, agent };
}

const GREEN: Suites = { 'demo.ATest': { tests: 3 }, 'demo.OldTest': { tests: 5 } };

describe('surefire helpers', () => {
  it('reads the testsuite header and ignores other xml', () => {
    expect(parseSuite('<testsuite name="demo.ATest" time="0.2" tests="4" errors="1" skipped="1" failures="2">')).toEqual({ name: 'demo.ATest', tests: 4, failures: 2, errors: 1, skipped: 1 });
    expect(parseSuite('<project/>')).toBeNull();
  });

  it('counts test cases in the body when the header undercounts them, as for @Nested classes', () => {
    const xml = [
      '<testsuite name="demo.CookieTest" tests="0" errors="0" skipped="0" failures="0">',
      '<testcase name="a" classname="demo.CookieTest"/>',
      '<testcase name="b" classname="demo.CookieTest$Nested"><failure message="x">boom</failure></testcase>',
      '<testcase name="c" classname="demo.CookieTest$Nested"><skipped/></testcase>',
      '<system-out><![CDATA[log: <error in text> <failure> <testcase>]]></system-out>',
      '</testsuite>',
    ].join('\n');
    expect(parseSuite(xml)).toEqual({ name: 'demo.CookieTest', tests: 3, failures: 1, errors: 0, skipped: 1 });
  });

  it('treats only concrete classes with JUnit test annotations as runnable tests', () => {
    expect(declaresTests('class ATest { @Test void a() {} }')).toBe(true);
    expect(declaresTests('class BTest { @ParameterizedTest @ValueSource(ints = 1) void b(int x) {} }')).toBe(true);
    expect(declaresTests('abstract class AbstractUnitTest { @Test void base() {} }')).toBe(false);
    expect(declaresTests('class TestOpenIdProvider { void start() {} }')).toBe(false);
    expect(declaresTests('interface ContractTest { @Test default void c() {} }')).toBe(false);
    expect(declaresTests('class CTest { // @Test void off() {}\n }')).toBe(false);
  });

  it('maps only test files surefire runs by default to class names', () => {
    expect(testClassOf('src/test/java/com/example/FooTest.java')).toBe('com.example.FooTest');
    expect(testClassOf('module/src/test/java/ru/TestBar.java')).toBe('ru.TestBar');
    expect(testClassOf('src/test/java/ru/FooTests.java')).toBe('ru.FooTests');
    expect(testClassOf('src/test/java/ru/Fixtures.java')).toBeNull();
    expect(testClassOf('src/main/java/ru/FooTest.java')).toBeNull();
  });

  it('reports a failed build, failed suites and changed tests that did not run', () => {
    expect(problemsOf({ code: 1, timedOut: false }, [{ name: 'a.BTest', tests: 2, failures: 1, errors: 0, skipped: 0 }], [{ name: 'a.CTest', executed: false }])).toEqual([
      'сборка завершилась с кодом 1',
      'упали тесты: a.BTest',
      'новые или измененные тесты не выполнились: a.CTest',
    ]);
    expect(problemsOf({ code: 0, timedOut: false }, [], [])).toEqual([]);
  });
});

describe('code.verify', () => {
  it('builds under the JDK of the profile, confirms new tests ran and reviews once', async () => {
    const t = setup([() => ({ code: 0, suites: GREEN })]);
    // Старый зеленый отчет от прошлой сборки не должен засчитаться.
    write(t.work, 'target/surefire-reports/TEST-demo.Stale.xml', '<testsuite name="demo.Stale" tests="1" failures="1" errors="0" skipped="0">');
    const out = (await step.run(t.c)) as { testReport: TestReport; findings: unknown[] };
    expect(out.testReport).toMatchObject({ tests: 8, failures: 0, suites: 2, builds: 1, changedTests: [{ name: 'demo.ATest', executed: true }] });
    expect(out.findings).toEqual([]);
    expect(t.shell.calls[0]).toMatchObject({ command: 'mvn -o package', env: { JAVA_HOME: '/jdk21' } });
    expect(t.shell.calls[0]!.logFile).toContain('verify-build-1.log');
    expect(t.agent.requests.map((r) => r.label)).toEqual(['ревью']);
    expect(t.agent.requests[0]!.prompt).toMatch(/git diff [0-9a-f]{40}/);
  });

  it('lets the implementing session fix a red build and builds again', async () => {
    const t = setup(
      [() => ({ code: 1, output: 'line\n[ERROR] COMPILATION ERROR A.java', suites: {} }), () => ({ code: 0, suites: GREEN })],
      undefined,
      { changes: { summary: '', files: [], tests: [], buildGreen: false, sessionId: 'impl-1' } },
    );
    const out = (await step.run(t.c)) as { testReport: TestReport };
    expect(out.testReport.builds).toBe(2);
    const fix = t.agent.requests[0]!;
    expect(fix).toMatchObject({ label: 'исправление сборки', resume: 'impl-1' });
    expect(fix.prompt).toContain('- сборка завершилась с кодом 1');
    expect(fix.prompt).toContain('- новые или измененные тесты не выполнились: demo.ATest');
    expect(fix.prompt).toContain('[ERROR] COMPILATION ERROR A.java');
    expect(fix.allow).toContain('Bash(mvn *)');
    expect(t.agent.requests.map((r) => r.label)).toEqual(['исправление сборки', 'ревью']);
  });

  it('gives up after the allowed number of fixes and names the problems', async () => {
    const t = setup([() => ({ code: 0, suites: { 'demo.OldTest': { tests: 5 } } })], undefined, {}, { attempts: '1' });
    await expect(step.run(t.c)).rejects.toThrow('новые или измененные тесты не выполнились: demo.ATest');
    expect(t.shell.calls).toHaveLength(2);
    expect(t.agent.requests.map((r) => r.label)).toEqual(['исправление сборки']);
  });

  it('builds again when the review changed files without marking anything fixed', async () => {
    const t = setup([() => ({ code: 0, suites: GREEN })], (req) => {
      if (req.label !== 'ревью') return {};
      write(t.work, 'src/main/java/demo/A.java', 'class A { int fixed = 1; }\n');
      return { output: { findings: [{ file: 'src/main/java/demo/A.java', line: 1, summary: 'частично', fixed: false }] } };
    });
    const out = (await step.run(t.c)) as { testReport: TestReport };
    expect(out.testReport.builds).toBe(2);
  });

  it('builds again after the review fixed something', async () => {
    let reviews = 0;
    const t = setup([() => ({ code: 0, suites: GREEN })], (req) => {
      if (req.label !== 'ревью') return {};
      reviews += 1;
      return { output: { findings: [{ file: 'src/main/java/demo/A.java', line: 1, summary: 'перевернуто условие', fixed: true }] } };
    });
    const out = (await step.run(t.c)) as { testReport: TestReport; findings: { fixed: boolean }[] };
    expect(reviews).toBe(1);
    expect(out.testReport.builds).toBe(2);
    expect(out.findings).toEqual([{ file: 'src/main/java/demo/A.java', line: 1, summary: 'перевернуто условие', fixed: true }]);
  });

  it('stops when the owner stops the run', async () => {
    const t = setup([() => ({ code: 143, aborted: true })]);
    await expect(step.run(t.c)).rejects.toThrow('Остановлено владельцем');
    expect(t.agent.requests).toHaveLength(0);
    expect(existsSync(join(t.work, 'target', 'surefire-reports'))).toBe(true);
  });
});
