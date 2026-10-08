import { join } from 'node:path';
import type { Changes, Issue, StepModule } from '../../packages/step-kit/src/index.ts';
import { branchFor, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, buildCommand, buildEnv, buildRule, GIT_READ, readText, stageDocs, worktreeOf } from '../_shared/agent.ts';
import { acOf, acText } from '../_shared/ac.ts';
import { approvedPlan } from '../_shared/plan.ts';

const LABEL = 'реализация';

/** Запуски агента, после которых работу стоит продолжить в той же сессии. */
const UNFINISHED = new Set(['interrupted', 'aborted', 'failed']);

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Что сделано, 2-5 предложений' },
    files: { type: 'array', items: { type: 'string' }, description: 'Измененные и новые файлы' },
    tests: { type: 'array', items: { type: 'string' }, description: 'Новые и измененные тесты' },
    buildGreen: { type: 'boolean', description: 'Сборка и тесты прошли' },
  },
  required: ['summary', 'files', 'tests', 'buildGreen'],
  additionalProperties: false,
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Реализация задачи агентом в рабочей папке ветки: код, тесты, доки и зеленая сборка.
 * Прерванный запуск продолжается в той же сессии агента. Коммит делает следующий шаг.
 */
const step: StepModule = {
  async simulate() {
    return { changes: { summary: 'Пробный прогон: код не менялся', files: [], tests: [], buildGreen: true, sessionId: '' } satisfies Changes };
  },

  async run(c) {
    const worktree = worktreeOf(c);
    const issue = c.get<Issue>('issue');
    if (!issue) throw new Error('Задача не загружена из Jira');
    const build = buildCommand(c.repo);
    const docs = stageDocs(c);
    const solutionFile = join(docs.dir, 'solution.md');
    const found = approvedPlan(c);
    if (c.get('plan') && !found) throw new Error('Файла утвержденного плана нет: повторите шаг "Анализ и план"');
    if (found && !found.hashMatches) c.log(`План ${found.plan.file} изменен после утверждения: реализация идет по текущему файлу`);
    const plan = found?.plan;
    const last = c.agent.lastSession(LABEL);
    const resume = last && UNFINISHED.has(last.status) ? last.sessionId : undefined;
    const prompt = resume
      ? renderTemplate(readText(import.meta.url, './continue.md'), { build, solutionFile })
      : `${renderTemplate(readText(import.meta.url, './prompt.md'), {
          key: issue.key,
          summary: issue.summary,
          repo: c.repo.title,
          branch: c.get<string>('branch') ?? branchFor(c.repo.branchPattern, issue.key),
          plan: plan
            ? `Утвержденный план лежит в файле ${plan.file}: прочитай его первым и работай по нему. Суть плана: ${plan.summary}`
            : 'Утвержденного плана нет: это срочная правка. Реализуй по описанию задачи минимальными изменениями.',
          description: issue.description.trim() || 'описания нет',
          ac: acText(acOf(c)),
          build,
          solutionFile,
        })}\n\n${agentRules(c, true)}`;
    const r = await c.agent.run({
      label: LABEL,
      prompt,
      cwd: worktree,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      writeDirs: [docs.dir],
      allow: [...GIT_READ, ...buildRule(c.repo)],
      env: buildEnv(c.repo),
      schema: SCHEMA,
      resume,
    });
    docs.back();
    const o = (r.output ?? {}) as Record<string, unknown>;
    const changes: Changes = {
      summary: typeof o.summary === 'string' ? o.summary : r.text,
      files: strings(o.files),
      tests: strings(o.tests),
      buildGreen: o.buildGreen === true,
      sessionId: r.sessionId,
    };
    if (!changes.buildGreen) c.log('Агент сообщает, что сборка не зеленая: шаг "Проверка" разберет и исправит');
    return { changes };
  },
};

export default step;
