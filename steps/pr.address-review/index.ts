import type { Issue, Plan, PrComment, PrReview, PullRequestState, ReviewReply, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { branchFor, commentsToAnswer, renderTemplate } from '../../packages/step-kit/src/index.ts';
import { agentRules, buildCommand, buildEnv, buildRule, GIT_READ, readText, worktreeOf } from '../_shared/agent.ts';
import { prOf, reviewSummary, whereOf } from '../_shared/pr.ts';

const LABEL = 'ответ на ревью';

const SCHEMA = {
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          commentId: { type: 'integer', description: 'Номер замечания' },
          text: { type: 'string', description: 'Ответ ревьюеру' },
          fixed: { type: 'boolean', description: 'По замечанию менялся код' },
        },
        required: ['commentId', 'text', 'fixed'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'Что сделано по замечаниям, 1-3 предложения' },
    files: { type: 'array', items: { type: 'string' }, description: 'Измененные файлы' },
    tests: { type: 'array', items: { type: 'string' }, description: 'Новые и измененные тесты' },
    buildGreen: { type: 'boolean' },
  },
  required: ['replies', 'summary', 'files', 'tests', 'buildGreen'],
  additionalProperties: false,
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Замечание для промпта: номер, место, текст и прежние ответы в ветке без имен людей. */
function commentText(c: PrComment, author: string): string {
  const thread = c.replies.map((r) => `${r.author === author ? 'вы' : 'ревьюер'}: ${r.text}`).join('; ');
  return `- Замечание ${c.id} (${whereOf(c)}): ${c.text}${thread ? `\n  Ветка ответов: ${thread}` : ''}`;
}

/** Замечания, на которые нужен ответ, и уже готовые, но еще не опубликованные ответы этого PR. */
function openOf(c: StepContext, pr: PullRequestState): { open: PrComment[]; drafted: ReviewReply[] } {
  const open = commentsToAnswer(pr);
  const review = c.get<PrReview>('prReview');
  const drafted = review?.pending && review.pr === pr.id ? review.replies.filter((r) => open.some((o) => o.id === r.commentId)) : [];
  return { open, drafted };
}

/**
 * Ответ на замечания ревьюеров в PR. Агент в рабочей папке ветки решает по каждому замечанию, править ли код, правит
 * с тестами и проверяет сборкой, и готовит ответ на каждое. Если код менялся, петля манифеста проводит проверку,
 * коммит и пуш через подтверждение и сборку; ответы публикует шаг "Мерж и доска" после пуша, с коммитом в ответах
 * на исправленные замечания. Без правок нового круга нет: ответы сразу идут на публикацию. Шаг "уже сделан", когда
 * замечаний без ответа нет или ответы на все готовы.
 */
const step: StepModule = {
  async done(c) {
    const { pr } = await prOf(c);
    const { open, drafted } = openOf(c, pr);
    if (!open.length) return { note: `В PR #${pr.id} замечаний без ответа нет: ${reviewSummary(pr)}` };
    if (open.every((o) => drafted.some((d) => d.commentId === o.id))) return { note: `Ответы на замечания готовы: их публикует шаг "Мерж и доска"` };
    return null;
  },

  async simulate() {
    return {};
  },

  async run(c) {
    const worktree = worktreeOf(c);
    const issue = c.get<Issue>('issue');
    if (!issue) throw new Error('Задача не загружена из Jira');
    const { pr } = await prOf(c);
    const { open, drafted } = openOf(c, pr);
    const todo = open.filter((o) => !drafted.some((d) => d.commentId === o.id));
    const plan = c.get<Plan>('plan');
    const prompt = `${renderTemplate(readText(import.meta.url, './prompt.md'), {
      key: issue.key,
      summary: issue.summary,
      repo: c.repo.title,
      branch: c.get<string>('branch') ?? branchFor(c.repo.branchPattern, issue.key),
      pr: pr.id,
      prUrl: pr.url,
      reviewers: reviewSummary(pr),
      plan: plan ? `Суть утвержденного плана: ${plan.summary}` : '',
      comments: todo.map((o) => commentText(o, pr.author)).join('\n'),
      build: buildCommand(c.repo),
    })}\n\nРабочая папка: ${worktree}.\n\n${agentRules(c, true)}`;
    const r = await c.agent.run({
      label: LABEL,
      prompt,
      cwd: worktree,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      allow: [...GIT_READ, ...buildRule(c.repo)],
      env: buildEnv(c.repo),
      schema: SCHEMA,
    });
    const o = (r.output ?? {}) as Record<string, unknown>;
    const replies = (Array.isArray(o.replies) ? o.replies : [])
      .map((x) => x as Record<string, unknown>)
      .filter((x) => typeof x.commentId === 'number' && typeof x.text === 'string' && x.text.trim() && todo.some((t) => t.id === x.commentId))
      .map((x): ReviewReply => ({ commentId: x.commentId as number, text: (x.text as string).trim(), fixed: x.fixed === true }));
    const missing = todo.filter((t) => !replies.some((x) => x.commentId === t.id)).map((t) => t.id);
    if (missing.length) throw new Error(`Агент не ответил на замечания ${missing.join(', ')}: повторите шаг`);
    const files = strings(o.files);
    const base = (await c.ports.git.run(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    c.log(`Ответы готовы: ${replies.length}${files.length ? `, изменено файлов ${files.length}${o.buildGreen === true ? ', сборка зеленая' : ', сборка не зеленая'}` : ', код не менялся'}`);
    const review: PrReview = {
      pr: pr.id,
      replies: [...drafted, ...replies],
      summary: typeof o.summary === 'string' ? o.summary : r.text,
      files,
      tests: strings(o.tests),
      pending: true,
      base,
      at: new Date().toISOString(),
    };
    return { prReview: review };
  },

  // Новый круг проверки, коммита и сборки нужен только, если по замечаниям менялся код.
  again(_c, outputs) {
    return ((outputs.prReview as PrReview | undefined)?.files.length ?? 0) > 0;
  },
};

export default step;
