import type { LinkedRun, PullRequestState, ScmRepoRef, StepContext } from '../../packages/step-kit/src/index.ts';

/** Шаг деплоя прогона: тест на стенде ждет его в связанных прогонах задачи. */
export const DEPLOY_STEP = 'deploy.stand';

/** PR связанного прогона и его репозиторий в Bitbucket; null - PR у прогона еще нет или Bitbucket в профиле нет. */
export function linkedPr(l: LinkedRun): { scm: ScmRepoRef; id: number } | null {
  const id = l.get<{ id?: number }>('pr')?.id;
  const bb = l.repo.bitbucket;
  return id && bb ? { scm: { contour: l.repo.contour, project: bb.project, repo: bb.repo }, id } : null;
}

/** Открытые PR связанных прогонов задачи: пока они есть, задачу рано вести к вехе merged. */
export async function openLinkedPrs(c: StepContext): Promise<{ run: LinkedRun; pr: PullRequestState }[]> {
  const found = await Promise.all(
    c.linked().map(async (run) => {
      const ref = linkedPr(run);
      if (!ref) return null;
      const pr = await c.ports.scm.pullRequest(ref.scm, ref.id);
      return pr.state === 'OPEN' ? { run, pr } : null;
    }),
  );
  return found.filter((x): x is { run: LinkedRun; pr: PullRequestState } => x !== null);
}
