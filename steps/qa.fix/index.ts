import type { Issue, Plan, QaFix, QaReport, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { branchFor, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, buildCommand, buildEnv, buildRule, GIT_READ, readText, worktreeOf } from '../_shared/agent.ts';
import { acOf, acText } from '../_shared/ac.ts';
import { failedOf } from '../_shared/qa.ts';

const LABEL = 'доработка по тесту';
const CAUSES = ['code', 'config', 'environment', 'unknown'] as const;

const SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string', enum: [...CAUSES], description: 'Где причина сбоя: code - в коде ветки, остальное код не исправит' },
    summary: { type: 'string', description: 'Почему AC не прошли и что сделано' },
    files: { type: 'array', items: { type: 'string' }, description: 'Измененные файлы' },
    tests: { type: 'array', items: { type: 'string' }, description: 'Новые и измененные тесты' },
    buildGreen: { type: 'boolean' },
  },
  required: ['cause', 'summary', 'files', 'tests', 'buildGreen'],
  additionalProperties: false,
};

const CAUSE_TEXT: Record<Exclude<(typeof CAUSES)[number], 'code'>, string> = {
  config: 'причина в настройках или конфиге',
  environment: 'причина в окружении стенда',
  unknown: 'причина не найдена',
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Номер круга: сколько кругов петля уже прошла, плюс этот. */
function roundOf(c: StepContext): number {
  const loops = c.get<Record<string, number>>('loops');
  return (loops?.['qa.fix'] ?? 0) + 1;
}

function prompt(c: StepContext, report: QaReport, failed: string[], worktree: string): string {
  const issue = c.get<Issue>('issue');
  if (!issue) throw new Error('Задача не загружена из Jira');
  const plan = c.get<Plan>('plan');
  const lines = report.results
    .filter((r) => failed.includes(r.ac))
    .map((r) => `- AC ${r.ac} (${r.result}): ${r.scenario}. Действие: ${r.action}. Ожидалось: ${r.expected}. Факт: ${r.note}.${r.files.length ? ` Кадры: ${r.files.join(', ')}` : ''}`);
  return `${renderTemplate(readText(import.meta.url, './prompt.md'), {
    key: issue.key,
    summary: issue.summary,
    round: roundOf(c),
    repo: c.repo.title,
    branch: c.get<string>('branch') ?? branchFor(c.repo.branchPattern, issue.key),
    plan: plan ? `Суть утвержденного плана: ${plan.summary}` : '',
    ac: acText(acOf(c)),
    stand: report.stand,
    failed: lines.join('\n'),
    report: report.report,
    artifacts: report.artifacts,
    build: buildCommand(c.repo),
  })}\n\nРабочая папка: ${worktree}.\n\n${agentRules(c, true)}`;
}

/**
 * Доработка по непройденным AC теста на стенде. Агент чинит код в рабочей папке ветки по отчету, кадрам и логам,
 * а петля манифеста заново проводит проверку, коммит, сборку, деплой и тест этих AC. Если чинить нечего,
 * шаг "уже сделан", и петля заканчивается; если причина не в коде, шаг падает с объяснением, а не крутит круг.
 */
const step: StepModule = {
  async done(c) {
    const report = c.get<QaReport>('qaReport');
    if (!report || failedOf(report).length) return null;
    const unchecked = report.results.filter((r) => r.result === 'не проверен').length;
    return { note: `Непройденных AC нет${unchecked ? `, не проверено ${unchecked}` : ''}: дорабатывать нечего` };
  },

  async simulate() {
    return {};
  },

  async run(c) {
    const report = c.get<QaReport>('qaReport');
    if (!report) throw new Error('Нет итогов теста на стенде: сначала нужен шаг "Тест на стенде"');
    const failed = failedOf(report);
    const worktree = worktreeOf(c);
    const r = await c.agent.run({
      label: LABEL,
      prompt: prompt(c, report, failed, worktree),
      cwd: worktree,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      allow: [...GIT_READ, ...buildRule(c.repo), 'mcp__pipeline__qa_kibana_logs', 'mcp__pipeline__qa_browser'],
      env: buildEnv(c.repo),
      schema: SCHEMA,
    });
    const o = (r.output ?? {}) as Record<string, unknown>;
    const cause = CAUSES.includes(o.cause as (typeof CAUSES)[number]) ? (o.cause as (typeof CAUSES)[number]) : 'unknown';
    const summary = typeof o.summary === 'string' ? o.summary : r.text;
    const files = strings(o.files);
    if (cause !== 'code' || !files.length) {
      throw new Error(`AC ${failed.join(', ')} кодом не исправить (${cause === 'code' ? 'агент ничего не изменил' : CAUSE_TEXT[cause]}): ${summary}`);
    }
    c.log(`Круг ${roundOf(c)}: исправлено по AC ${failed.join(', ')}, файлов ${files.length}${o.buildGreen === true ? ', сборка зеленая' : ', сборка не зеленая'}`);
    return {
      qaFix: { round: roundOf(c), failed, summary, files, tests: strings(o.tests), buildGreen: o.buildGreen === true, at: new Date().toISOString() } satisfies QaFix,
    };
  },
};

export default step;
