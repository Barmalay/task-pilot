import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Changes, Finding, Issue, Plan, StepContext, StepModule, TestReport } from '../../packages/step-kit/src/index.ts';
import { renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, buildCommand, buildEnv, buildRule, GIT_READ, mergeBase, readText, sha256, worktreeOf } from '../_shared/agent.ts';
import { clearSurefire, declaresTests, readSurefire, testClassOf, type Suite } from './surefire.ts';

const BUILD_TIMEOUT_MS = 40 * 60_000;
const OUTPUT_LINES = 150;
const AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          fixed: { type: 'boolean' },
        },
        required: ['file', 'summary', 'fixed'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

/**
 * Классы тестов, которые ветка добавила или изменила, включая еще не закоммиченные. В список попадают
 * только файлы с запускаемыми тестами: от вспомогательного или абстрактного класса отчета не будет.
 */
async function changedTestClasses(c: StepContext, cwd: string): Promise<string[]> {
  const base = await mergeBase(c, cwd);
  const diff = (await c.ports.git.run(cwd, ['diff', '--name-status', '--no-renames', base])).stdout;
  const untracked = (await c.ports.git.run(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout;
  const paths = [
    ...diff
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([status, path]) => path && (status === 'A' || status === 'M'))
      .map(([, path]) => path!),
    ...untracked.split('\n').filter(Boolean),
  ];
  const runnable = paths.filter((p) => {
    const file = join(cwd, p);
    return testClassOf(p) !== null && existsSync(file) && declaresTests(readFileSync(file, 'utf8'));
  });
  return [...new Set(runnable.map(testClassOf).filter((name): name is string => !!name))].sort();
}

/** Отпечаток рабочей папки: изменения отслеживаемых файлов и содержимое новых. */
async function treeHash(c: StepContext, cwd: string): Promise<string> {
  const { git } = c.ports;
  const diff = (await git.run(cwd, ['diff', 'HEAD', '--no-color', '--binary'])).stdout;
  const untracked = (await git.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
    .split('\0')
    .filter(Boolean)
    .map((p) => `${p}:${sha256(readFileSync(join(cwd, p)).toString('base64'))}`);
  return sha256(`${diff}\n${untracked.join('\n')}`);
}

/** Чем сборка не устраивает; пустой список - сборка зеленая. */
export function problemsOf(build: { code: number; timedOut: boolean }, suites: Suite[], changed: TestReport['changedTests']): string[] {
  const problems: string[] = [];
  if (build.timedOut) problems.push(`сборка не уложилась в ${BUILD_TIMEOUT_MS / 60_000} минут`);
  else if (build.code !== 0) problems.push(`сборка завершилась с кодом ${build.code}`);
  const failed = suites.filter((s) => s.failures + s.errors > 0).map((s) => s.name);
  if (failed.length) problems.push(`упали тесты: ${failed.join(', ')}`);
  const missed = changed.filter((t) => !t.executed).map((t) => t.name);
  if (missed.length) problems.push(`новые или измененные тесты не выполнились: ${missed.join(', ')}`);
  return problems;
}

function findings(value: unknown): Finding[] {
  const list = (value as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return [];
  return list.map((f: Record<string, unknown>) => ({
    file: String(f.file ?? ''),
    line: typeof f.line === 'number' ? f.line : null,
    summary: String(f.summary ?? ''),
    fixed: f.fixed === true,
  }));
}

async function fix(c: StepContext, cwd: string, problems: string[], output: string, command: string, env: Record<string, string>): Promise<void> {
  // Сборку чинит та же сессия, что писала код: она помнит задачу и свои решения.
  const resume = c.get<Changes>('changes')?.sessionId || undefined;
  const issue = c.get<Issue>('issue');
  const intro = resume ? '' : `Задача ${issue?.key ?? c.run.issueKey}: ${issue?.summary ?? ''}. Рабочая папка ветки - текущая папка, изменения задачи уже в ней.\n\n`;
  const prompt = renderTemplate(readText(import.meta.url, './fix.md'), {
    intro,
    problems: problems.map((p) => `- ${p}`).join('\n'),
    build: command,
    output: output.split('\n').slice(-OUTPUT_LINES).join('\n'),
  });
  await c.agent.run({
    label: 'исправление сборки',
    prompt: resume ? prompt : `${prompt}\n\n${agentRules(c, true)}`,
    cwd,
    tools: AGENT_TOOLS,
    allow: [...GIT_READ, ...buildRule(c.repo)],
    env,
    resume,
  });
}

async function review(c: StepContext, cwd: string): Promise<Finding[]> {
  const issue = c.get<Issue>('issue');
  const plan = c.get<Plan>('plan');
  const prompt = renderTemplate(readText(import.meta.url, './review.md'), {
    key: issue?.key ?? c.run.issueKey,
    summary: issue?.summary ?? '',
    mergeBase: await mergeBase(c, cwd),
    plan: plan ? `Утвержденный план задачи: ${plan.file}.` : '',
  });
  const r = await c.agent.run({ label: 'ревью', prompt: `${prompt}\n\n${agentRules(c, true)}`, cwd, tools: AGENT_TOOLS, allow: GIT_READ, schema: REVIEW_SCHEMA });
  return findings(r.output);
}

/**
 * Проверка ветки: сборка и тесты командой профиля под его JDK, разбор отчетов surefire и
 * проверка, что новые и измененные тесты действительно выполнились. Проблемы чинит агент,
 * не больше заданного числа раз; после зеленой сборки один проход ревью, и если ревью что-то
 * исправило, сборка повторяется.
 */
const step: StepModule = {
  async simulate() {
    return {
      testReport: { tests: 0, failures: 0, errors: 0, skipped: 0, suites: 0, changedTests: [], builds: 0, logFile: '' } satisfies TestReport,
      findings: [] as Finding[],
    };
  },

  async run(c) {
    const worktree = worktreeOf(c);
    const command = buildCommand(c.repo);
    const env = buildEnv(c.repo);
    const maxFixes = Number(c.params.attempts ?? 3) || 3;
    mkdirSync(c.paths.run, { recursive: true });
    let fixes = 0;
    let builds = 0;
    let reviewed = false;
    let found: Finding[] = [];
    for (;;) {
      builds += 1;
      const logFile = join(c.paths.run, `verify-build-${builds}.log`);
      c.log(`Сборка и тесты: ${command}`);
      clearSurefire(worktree);
      const build = await c.ports.shell.run(command, { cwd: worktree, env, timeoutMs: BUILD_TIMEOUT_MS, signal: c.signal, logFile });
      if (build.aborted) throw new Error('Остановлено владельцем');
      const suites = readSurefire(worktree);
      const executed = new Map(suites.map((s) => [s.name, s.tests]));
      const changed = (await changedTestClasses(c, worktree)).map((name) => ({ name, executed: (executed.get(name) ?? 0) > 0 }));
      const sum = (k: 'tests' | 'failures' | 'errors' | 'skipped') => suites.reduce((acc, s) => acc + s[k], 0);
      const report: TestReport = {
        tests: sum('tests'),
        failures: sum('failures'),
        errors: sum('errors'),
        skipped: sum('skipped'),
        suites: suites.length,
        changedTests: changed,
        builds,
        logFile,
      };
      const problems = problemsOf(build, suites, changed);
      if (problems.length) {
        c.log(`Проверка не прошла: ${problems.join('; ')}`);
        if (fixes >= maxFixes) throw new Error(`Сборка не зеленая после исправлений агентом (${fixes}): ${problems.join('; ')}. Журнал сборки: ${logFile}`);
        fixes += 1;
        await fix(c, worktree, problems, build.output, command, env);
        continue;
      }
      c.log(`Сборка зеленая: тестов ${report.tests}, пропущено ${report.skipped}${changed.length ? `, новые и измененные тесты выполнились: ${changed.length}` : ''}`);
      if (!reviewed) {
        reviewed = true;
        // Повторная сборка нужна, если ревью что-то поменяло в файлах, даже если агент не отметил правку как fixed.
        const before = await treeHash(c, worktree);
        found = await review(c, worktree);
        const fixed = found.filter((f) => f.fixed).length;
        if (fixed || (await treeHash(c, worktree)) !== before) {
          c.log(`Ревью изменило код (исправлено находок: ${fixed}), сборка повторяется`);
          continue;
        }
      }
      return { testReport: report, findings: found };
    }
  },
};

export default step;
