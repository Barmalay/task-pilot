import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Issue, Plan, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { branchFor, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, GIT_READ, jiraTools, readText, sha256, stageDocs, worktreeOf } from '../_shared/agent.ts';
import { acOf, acPlanTask, acText, planAcOf, planAcPreview } from '../_shared/ac.ts';

const LABEL = 'план';

/** Черновик плана до утверждения. */
interface Draft {
  sessionId: string;
  file: string;
  summary: string;
  questions: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Суть плана в 2-4 предложениях' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Открытые вопросы владельцу' },
  },
  required: ['summary', 'questions'],
  additionalProperties: false,
};

/** Чтение Jira и Confluence для анализа. */
/** Инструменты Jira и Confluence только на чтение. */
const JIRA_READ = ['jira_get_issue', 'jira_search', 'confluence_search', 'confluence_get_page', 'confluence_get_page_children'];

function output(value: unknown): { summary: string; questions: string[] } {
  const o = value as { summary?: unknown; questions?: unknown } | null;
  if (!o || typeof o.summary !== 'string') throw new Error('Агент не вернул суть плана');
  const questions = Array.isArray(o.questions) ? o.questions.filter((q): q is string => typeof q === 'string') : [];
  return { summary: o.summary, questions };
}

function draftOf(c: StepContext): Draft {
  const d = c.draft as Draft | undefined;
  if (!d) throw new Error('Черновика плана нет');
  if (!existsSync(d.file)) throw new Error(`Файл плана ${d.file} пропал, повторите шаг`);
  return d;
}

function prompt(c: StepContext, worktree: string, file: string, docs: string): string {
  const issue = c.get<Issue>('issue');
  if (!issue) throw new Error('Задача не загружена из Jira');
  const vars = {
    key: issue.key,
    summary: issue.summary,
    type: issue.type ?? 'не указан',
    status: issue.status,
    labels: issue.labels.join(', ') || 'нет',
    components: issue.components.join(', ') || 'нет',
    sprint: issue.sprint?.name ?? 'нет',
    description: issue.description.trim() || 'описания нет',
    ac: acText(acOf(c)),
    repo: c.repo.title,
    branch: c.get<string>('branch') ?? branchFor(c.repo.branchPattern, issue.key),
    base: `${c.repo.remote}/${c.repo.baseBranch}`,
    planFile: file,
    worktree,
  };
  return [renderTemplate(readText(import.meta.url, './prompt.md'), vars), acPlanTask(c.get<string[] | null>('ac'), docs), agentRules(c)].filter(Boolean).join('\n\n');
}

/**
 * Анализ задачи агентом: план в рабочих доках задачи, код не меняется. Владелец утверждает план
 * или возвращает его с замечанием, и агент дорабатывает план в той же сессии. "Повторить" всегда
 * начинает анализ заново: постановка могла измениться. Если в описании задачи нет критериев приемки,
 * план фиксирует их своим разделом: владелец утверждает их вместе с планом, и они уходят в контекст с ним.
 */
const step: StepModule = {
  async prepare(c) {
    const worktree = worktreeOf(c);
    const file = join(c.paths.docs, 'plan.md');
    const docs = stageDocs(c);
    const agentFile = join(docs.dir, 'plan.md');
    const previous = c.draft as Draft | undefined;
    const resume = c.feedback && previous ? previous.sessionId : undefined;
    const jira = c.get<string[] | null>('ac');
    // Задание про критерии приемки повторяется в доработке, пока их раздела в плане нет: сессию могли начать без него.
    const acTask = resume && existsSync(agentFile) && !planAcOf(readFileSync(agentFile, 'utf8'), jira) ? acPlanTask(jira, docs.dir) : '';
    const text = resume
      ? [renderTemplate(readText(import.meta.url, './rework.md'), { feedback: c.feedback, planFile: agentFile }), acTask].filter(Boolean).join('\n\n')
      : prompt(c, worktree, agentFile, docs.dir);
    const r = await c.agent.run({
      label: LABEL,
      prompt: text,
      cwd: worktree,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      // Анализ не меняет код: писать можно только в папку доков, даже если ветка открыта в основной папке.
      writeCwd: false,
      writeDirs: [docs.dir],
      allow: [...GIT_READ, ...jiraTools(c, JIRA_READ)],
      mcp: [c.jira.mcp],
      schema: SCHEMA,
      resume,
    });
    if (!existsSync(agentFile)) throw new Error(`Агент не записал план в ${agentFile}`);
    docs.back();
    return { sessionId: r.sessionId, file, ...output(r.output) } satisfies Draft;
  },

  async preview(c) {
    const d = draftOf(c);
    const text = readFileSync(d.file, 'utf8');
    const ac = planAcPreview(text, c.get<string[] | null>('ac'));
    return {
      title: 'Утвердить план',
      summary: d.summary,
      actions: ['Реализация пойдет по этому плану', ...ac.actions],
      ...(ac.warnings.length ? { warnings: ac.warnings } : {}),
      // Вопросы плана видны прямо на подтверждении, с полем ответа у каждого: искать их в тексте плана не нужно.
      questions: d.questions,
      texts: [{ id: 'plan', label: 'План', text, publish: false, format: 'markdown' }],
      payload: { file: d.file, hash: sha256(text) },
    };
  },

  async simulate() {
    // Пробный прогон плана не составляет, и в контекст ничего не кладется: неутвержденного плана не бывает.
    return {};
  },

  async run(c) {
    const d = draftOf(c);
    const text = readFileSync(d.file, 'utf8');
    const ac = planAcOf(text, c.get<string[] | null>('ac'));
    return { plan: { file: d.file, hash: sha256(text), summary: d.summary, questions: d.questions, ...(ac ? { ac } : {}) } satisfies Plan };
  },
};

export default step;
