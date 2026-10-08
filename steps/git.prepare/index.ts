import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { branchFor } from '../../packages/step-kit/src/index.ts';
import { parseWorktrees } from '../_shared/worktrees.ts';

type Op = 'worktree-add' | 'worktree-track' | 'worktree-new' | 'ff' | 'rebase';

interface PlanItem {
  op: Op;
  text: string;
}

interface State {
  branch: string;
  path: string;
  remoteExists: boolean;
  plan: PlanItem[];
  blocker: string | null;
}

async function refExists(c: StepContext, cwd: string, ref: string): Promise<boolean> {
  return (await c.ports.git.tryRun(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0;
}

async function count(c: StepContext, cwd: string, range: string): Promise<number> {
  return Number((await c.ports.git.run(cwd, ['rev-list', '--count', range])).stdout.trim());
}

/**
 * Смотрит на состояние ветки и составляет план. Меняет только ссылки remote (fetch):
 * сама ветка и рабочие папки не трогаются.
 */
async function inspect(c: StepContext): Promise<State> {
  if (c.contour && !c.contour.connected) {
    throw new Error(`Контур ${c.contour.title} еще не подключен${c.contour.note ? `: ${c.contour.note}` : ''}`);
  }
  const { git } = c.ports;
  const repo = c.repo.path;
  const remote = c.repo.remote;
  const base = `${remote}/${c.repo.baseBranch}`;
  const branch = branchFor(c.repo.branchPattern, c.run.issueKey);
  if (!c.scratch.has('fetched')) {
    await git.run(repo, ['fetch', remote, '--prune']);
    c.scratch.set('fetched', true);
  }
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const localExists = await refExists(c, repo, localRef);
  const remoteExists = await refExists(c, repo, remoteRef);
  const worktrees = parseWorktrees((await git.run(repo, ['worktree', 'list', '--porcelain'])).stdout);
  const checkedOutAt = worktrees.find((w) => w.branch === localRef)?.path;
  const path = checkedOutAt ?? join(c.repo.worktreesDir, `${c.repo.id}-${c.run.issueKey}`);
  const plan: PlanItem[] = [];
  let blocker: string | null = null;

  if (!checkedOutAt) {
    if (existsSync(path)) blocker = `Папка ${path} уже существует, но ветка ${branch} в ней не открыта`;
    else if (localExists) plan.push({ op: 'worktree-add', text: `Открыть ветку ${branch} в отдельном worktree ${path}` });
    else if (remoteExists) plan.push({ op: 'worktree-track', text: `Взять ветку ${branch} из ${remote} в отдельный worktree ${path}` });
    else plan.push({ op: 'worktree-new', text: `Создать ветку ${branch} от свежего ${base} в отдельном worktree ${path}` });
  }

  let head: string | null = localExists ? localRef : remoteExists ? remoteRef : null;
  if (localExists && remoteExists) {
    const behind = await count(c, repo, `${localRef}..${remoteRef}`);
    const ahead = await count(c, repo, `${remoteRef}..${localRef}`);
    if (behind > 0 && ahead > 0) {
      blocker ??= `Ветка ${branch} разошлась с ${remote}: ${ahead} своих и ${behind} чужих коммитов, нужно разобраться вручную`;
    } else if (behind > 0) {
      plan.push({ op: 'ff', text: `Подтянуть ${behind} новых коммитов из ${remote}/${branch}` });
      head = remoteRef;
    }
  }

  if (head) {
    const behindBase = await count(c, repo, `${head}..${base}`);
    if (behindBase > 0) {
      const pushed = remoteExists ? '; ветка уже запушена, при следующем пуше понадобится --force-with-lease' : '';
      plan.push({ op: 'rebase', text: `Ребейз на ${base}: ветка отстает на ${behindBase} коммитов${pushed}` });
    }
  }

  if (checkedOutAt && plan.some((p) => p.op === 'ff' || p.op === 'rebase')) {
    const dirty = (await git.run(checkedOutAt, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
    if (dirty) blocker ??= `В ${checkedOutAt} есть незакоммиченные изменения, подтянуть коммиты или сделать ребейз нельзя`;
  }

  return { branch, path, remoteExists, plan, blocker };
}

/** Готовит ветку задачи в отдельном worktree, подтягивает ее и ребейзит на master до коммитов. */
const step: StepModule = {
  async done(c) {
    const s = await inspect(c);
    if (!s.blocker && s.plan.length === 0) return { note: `Ветка ${s.branch} готова: ${s.path}`, outputs: { branch: s.branch, worktree: s.path } };
    return null;
  },

  async preview(c) {
    const s = await inspect(c);
    if (s.blocker) throw new Error(s.blocker);
    return {
      title: `Подготовить ветку ${s.branch}`,
      summary: s.path,
      actions: s.plan.map((p) => p.text),
      payload: { branch: s.branch, path: s.path, plan: s.plan.map((p) => p.op) },
      requiresApproval: s.remoteExists && s.plan.some((p) => p.op === 'rebase'),
    };
  },

  async simulate(c) {
    const s = await inspect(c);
    return { branch: s.branch, worktree: s.path };
  },

  async run(c) {
    const s = await inspect(c);
    if (s.blocker) throw new Error(s.blocker);
    const { git } = c.ports;
    const repo = c.repo.path;
    const remote = c.repo.remote;
    const base = `${remote}/${c.repo.baseBranch}`;
    for (const item of s.plan) {
      c.log(item.text);
      if (item.op.startsWith('worktree')) mkdirSync(c.repo.worktreesDir, { recursive: true });
      if (item.op === 'worktree-add') await git.run(repo, ['worktree', 'add', s.path, s.branch]);
      if (item.op === 'worktree-track') await git.run(repo, ['worktree', 'add', '--track', '-b', s.branch, s.path, `${remote}/${s.branch}`]);
      if (item.op === 'worktree-new') await git.run(repo, ['worktree', 'add', '--no-track', '-b', s.branch, s.path, base]);
      if (item.op === 'ff') await git.run(s.path, ['merge', '--ff-only', `${remote}/${s.branch}`]);
      if (item.op === 'rebase') {
        const r = await git.tryRun(s.path, ['rebase', base]);
        if (r.code !== 0) {
          await git.tryRun(s.path, ['rebase', '--abort']);
          throw new Error(`Конфликт при ребейзе на ${base}, ветка возвращена в исходное состояние. Нужен владелец`);
        }
      }
    }
    return { branch: s.branch, worktree: s.path, rebased: s.plan.some((p) => p.op === 'rebase') };
  },
};

export default step;
