import type { Issue, LinkedRun, LintIssue, MilestonePlan, PreviewText, PrReview, PullRequestState, ReviewReply, ScmRepoRef, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { commentsToAnswer, StepWaiting, walkTransitions } from '../../packages/step-kit/src/index.ts';
import { moveOf, moveOffText, transitionIds, transitionText } from '../_shared/board.ts';
import { openLinkedPrs } from '../_shared/linked.ts';
import { prOf, reviewSummary, whereOf } from '../_shared/pr.ts';

const MILESTONE = 'merged';

/** Что шаг узнал за одно выполнение: задача, PR, ответы к публикации и путь по доске. */
interface State {
  issue: Issue;
  scm: ScmRepoRef;
  pr: PullRequestState;
  /** Ответы, которые еще нужны: на замечания, у которых последнее слово не за автором. */
  replies: (ReviewReply & { where: string; comment: string; published: string; autofix: LintIssue[] })[];
  plan: MilestonePlan;
  /** Перевод по доске выключен настройкой шага: после мержа задача остается в своем статусе. */
  moveOff: boolean;
  /** Перевод выключен пустой вехой доски, а не настройкой шага. */
  moveByBoard: boolean;
  /** Статус, к которому шаг ведет задачу после мержа: веха merged доски или статус из настройки; null - не ведет. */
  goal: string | null;
  /** Открытые PR связанных прогонов задачи; смотрятся после мержа своего PR. */
  linked: { run: LinkedRun; pr: PullRequestState }[];
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
}

function clip(text: string, size = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > size ? `${one.slice(0, size - 3)}...` : one;
}

async function inspect(c: StepContext): Promise<State> {
  const cached = c.scratch.get('state') as State | undefined;
  if (cached) return cached;
  const issue = await c.ports.jira.getIssue(c.run.issueKey);
  const { scm, pr } = await prOf(c);
  const review = c.get<PrReview>('prReview');
  const open = new Map(commentsToAnswer(pr).map((cm) => [cm.id, cm]));
  // Ответ на замечание, где последнее слово уже за автором (опубликован раньше или ответил сам), не повторяется.
  const drafts = review?.pending && review.pr === pr.id ? review.replies.filter((r) => open.has(r.commentId)) : [];
  if (drafts.some((r) => r.fixed) && review!.files.length && (!c.get<string>('commitSha') || c.get<string>('commitSha') === review!.base)) {
    throw new Error('Исправления по замечаниям ревьюеров еще не запушены: сначала шаг "Коммит, пуш и PR"');
  }
  const commit = c.get<string>('commitSha')?.slice(0, 8);
  const replies = drafts.map((r) => {
    const comment = open.get(r.commentId)!;
    const text = r.fixed && commit ? `${r.text.trim()} Исправлено в коммите ${commit}.` : r.text.trim();
    const linted = c.lint(text);
    return { ...r, where: whereOf(comment), comment: comment.text, published: linted.text, autofix: linted.issues.filter((i) => i.severity === 'fixed') };
  });
  const move = moveOf(c, issue.status, MILESTONE);
  // PR связанных прогонов смотрятся только после мержа своего: до него задача дальше по доске не идет все равно.
  const linked = pr.state === 'MERGED' ? await openLinkedPrs(c) : [];
  const state: State = { issue, scm, pr, replies, plan: move.plan, moveOff: move.off, moveByBoard: move.byBoard, goal: move.target, linked };
  c.scratch.set('state', state);
  return state;
}

/** Открытые PR связанных прогонов одной строкой: "adapter #12, mobile #7". */
function linkedPrsText(s: State): string {
  return s.linked.map((l) => `${l.run.repo.title} #${l.pr.id}`).join(', ');
}

/**
 * Шаг ждет мержа, наблюдатель продолжит прогон сам. После публикации ответов шаг ждет всегда, даже если PR уже
 * смержен: перевод по доске - отдельное подтверждение, и наблюдатель запустит его при следующей проверке.
 */
function waitForMerge(s: State, posted = 0, outputs?: Record<string, unknown>): never {
  const left = commentsToAnswer(s.pr).length - posted;
  const done = posted ? `ответов опубликовано: ${posted}. ` : '';
  const text =
    s.pr.state === 'OPEN'
      ? `${done}Жду мерж PR #${s.pr.id}: ${reviewSummary(s.pr)}${left > 0 ? `, замечаний без ответа ${left}` : ''}`
      : `${done}PR #${s.pr.id} уже смержен: ${s.goal ? `перевод задачи до ${s.goal} будет следующим подтверждением` : 'шаг закончится при следующей проверке'}`;
  throw new StepWaiting(text, { kind: 'pr', scm: s.scm, pr: s.pr.id }, outputs);
}

/**
 * Завершение задачи. Если шаг "Ответ на ревью" подготовил ответы, шаг сначала публикует их одним подтверждением:
 * после пуша исправлений, с коммитом в ответах на исправленные замечания. Пока PR не смержен, шаг ждет: движок
 * ставит его на паузу, а наблюдатель продолжает прогон после мержа или запускает ответ на ревью при новых
 * замечаниях. После мержа одно подтверждение проводит задачу по доске до вехи merged, как владелец прокликивает
 * сам. Рабочую папку и ветку шаг не трогает.
 */
const step: StepModule = {
  async done(c) {
    const issue = await c.ports.jira.getIssue(c.run.issueKey);
    const move = moveOf(c, issue.status, MILESTONE);
    // Без перевода по доске шаг все равно публикует ответы и ждет мерж: "уже сделано" - только задача, дошедшая до цели.
    if (move.off || move.plan.kind !== 'done') return null;
    return { note: `Задача уже в статусе ${issue.status}`, outputs: { status: issue.status } };
  },

  async preview(c) {
    const s = await inspect(c);
    if (s.replies.length) {
      // Что линтер исправил сам, видно на подтверждении; остальные замечания к текстам добавит движок.
      const lint: LintIssue[] = s.replies.flatMap((r) => r.autofix.map((i) => ({ ...i, message: `Ответ на ${r.commentId}: ${i.message}` })));
      const texts: PreviewText[] = s.replies.map((r) => ({
        id: `reply-${r.commentId}`,
        label: `Ответ на замечание (${r.where}): "${clip(r.comment)}"`,
        text: r.published,
        publish: true,
        format: 'markdown',
      }));
      const n = s.replies.length;
      return {
        title: `${c.run.issueKey}: ответы в PR #${s.pr.id}`,
        summary: `PR #${s.pr.id}: ${reviewSummary(s.pr)}. ${s.pr.url}`,
        actions: [`Ответить в PR #${s.pr.id} на ${n} ${plural(n, 'замечание', 'замечания', 'замечаний')}`],
        texts,
        lint,
        payload: { pr: s.pr.id, replies: s.replies.map((r) => ({ id: r.commentId, text: r.published })) },
      };
    }
    if (s.pr.state === 'OPEN') waitForMerge(s);
    if (s.pr.state !== 'MERGED') throw new Error(`PR #${s.pr.id} ${s.pr.state === 'DECLINED' ? 'отклонен' : `в состоянии ${s.pr.state}`}: задачу дальше по доске не вести`);
    if (s.linked.length) {
      return {
        title: `${c.run.issueKey}: ${s.goal ?? 'мерж'} после связанных прогонов`,
        summary: `PR #${s.pr.id} смержен: ${s.pr.url}. Задачу дальше по доске переведет прогон, чей PR смержат последним`,
        actions: [`Задачу по доске не вести: ждут мержа ${linkedPrsText(s)}`],
        requiresApproval: false,
        payload: { pr: s.pr.id, transitions: [], waiting: s.linked.map((l) => l.pr.id) },
      };
    }
    if (s.plan.kind === 'blocked') throw new Error(s.plan.reason);
    const steps = s.plan.kind === 'transitions' ? s.plan.steps : [];
    return {
      title: `${c.run.issueKey}: ${s.goal ?? 'мерж'}`,
      summary: `PR #${s.pr.id} смержен: ${s.pr.url}`,
      actions: s.moveOff ? [moveOffText(s.issue.status, s.moveByBoard)] : steps.map((t) => `Jira: ${transitionText(t)}`),
      requiresApproval: steps.length > 0,
      payload: { pr: s.pr.id, transitions: transitionIds(steps) },
    };
  },

  async simulate(c) {
    return { merged: { pr: 0, at: 'dry-run' }, status: c.get<Issue>('issue')?.status };
  },

  async run(c) {
    const s = await inspect(c);
    if (s.replies.length) {
      for (const r of s.replies) await c.ports.scm.reply(s.scm, s.pr.id, r.commentId, r.published);
      c.log(`Опубликованы ответы в PR #${s.pr.id}: ${s.replies.length}`);
      // Опубликованные ответы следующий запуск отфильтрует и сам: последнее слово в этих ветках теперь за автором.
      waitForMerge(s, s.replies.length, { prReview: { ...c.get<PrReview>('prReview')!, pending: false } });
    }
    if (s.pr.state !== 'MERGED') throw new Error(`PR #${s.pr.id} в состоянии ${s.pr.state}`);
    if (s.linked.length) {
      c.log(`PR #${s.pr.id} смержен; задачу дальше по доске переведет прогон, чей PR смержат последним: ждут ${linkedPrsText(s)}`);
      return { merged: { pr: s.pr.id, at: new Date().toISOString() }, status: s.issue.status };
    }
    const status = s.plan.kind === 'transitions' ? await walkTransitions(c.ports.jira, s.issue.key, s.issue.status, s.plan.steps, c.log) : s.issue.status;
    return { merged: { pr: s.pr.id, at: new Date().toISOString() }, status };
  },
};

export default step;
