import type { PrComment, PullRequestState, ScmRepoRef, StepContext } from '../../packages/step-kit/src/index.ts';
import { branchFor } from '../../packages/step-kit/src/index.ts';

/** Репозиторий задачи в Bitbucket из профиля; без Bitbucket в профиле PR не посмотреть. */
export function scmOf(c: StepContext): ScmRepoRef {
  const bb = c.repo.bitbucket;
  if (!bb) throw new Error(`В профиле репозитория ${c.repo.id} нет Bitbucket: PR не посмотреть`);
  return { contour: c.repo.contour, project: bb.project, repo: bb.repo };
}

/** PR задачи: из контекста прогона или поиском по ветке задачи, в любом состоянии. */
export async function prOf(c: StepContext): Promise<{ scm: ScmRepoRef; pr: PullRequestState }> {
  const scm = scmOf(c);
  const known = c.get<{ id: number }>('pr');
  const id = known?.id ?? (await c.ports.scm.findPullRequest(scm, c.get<string>('branch') ?? branchFor(c.repo.branchPattern, c.run.issueKey)))?.id;
  if (!id) throw new Error(`PR ветки задачи ${c.run.issueKey} в Bitbucket не найден: сначала нужен шаг "Коммит, пуш и PR"`);
  return { scm, pr: await c.ports.scm.pullRequest(scm, id) };
}

/** Где комментарий: файл и строка или общий комментарий PR. */
export function whereOf(comment: Pick<PrComment, 'file' | 'line'>): string {
  return comment.file ? `${comment.file}${comment.line ? `:${comment.line}` : ''}` : 'общий комментарий';
}

/** Оценки ревьюеров одной фразой: "одобрили 1 из 2, просят доработать 1". */
export function reviewSummary(pr: Pick<PullRequestState, 'reviewers'>): string {
  const approved = pr.reviewers.filter((r) => r.status === 'APPROVED').length;
  const needsWork = pr.reviewers.filter((r) => r.status === 'NEEDS_WORK').length;
  return `одобрили ${approved} из ${pr.reviewers.length}${needsWork ? `, просят доработать ${needsWork}` : ''}`;
}
