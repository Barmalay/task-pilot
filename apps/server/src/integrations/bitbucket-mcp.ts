import type { Contour, PrComment, PrReviewer, PullRequestRef, ScmPort, ScmRepoRef } from '@task-pilot/step-kit';

type Call = (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;

interface RawPr {
  id?: number;
  title?: string;
  web_url?: string;
  source_branch?: string;
  destination_branch?: string;
}

/** Сколько последних PR репозитория просматривать в поисках PR ветки. */
const FIND_LIMIT = 100;

interface RawComment {
  id?: number;
  author?: string;
  text?: string;
  created_on?: string;
  state?: string;
  is_inline?: boolean;
  file_path?: string;
  line_number?: number;
  replies?: RawComment[];
}

/** Сколько комментариев PR читать за раз: активных в PR задачи обычно единицы. */
const COMMENT_LIMIT = 100;

/** Ревьюер из строки сервера: "Имя (APPROVED)" или просто "Имя", если еще не оценил. */
export function parseReviewer(raw: string): PrReviewer {
  const m = /^(.*?)\s*\((APPROVED|NEEDS_WORK|UNAPPROVED)\)$/.exec(raw.trim());
  return m ? { name: m[1]!, status: m[2]! } : { name: raw.trim(), status: 'UNAPPROVED' };
}

/** Ответы в ветке комментария плоским списком по времени: ответ на ответ тоже ответ в этой ветке. */
function flatReplies(list: RawComment[] | undefined): PrComment['replies'] {
  return (list ?? [])
    .flatMap((r) => [
      { id: r.id ?? 0, author: r.author ?? '', text: r.text ?? '', createdAt: r.created_on ?? '' },
      ...flatReplies(r.replies),
    ])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Комментарий PR из ответа сервера. */
export function toComment(raw: RawComment): PrComment {
  return {
    id: raw.id ?? 0,
    author: raw.author ?? '',
    text: raw.text ?? '',
    createdAt: raw.created_on ?? '',
    state: raw.state ?? 'OPEN',
    file: raw.is_inline && raw.file_path ? raw.file_path : null,
    line: raw.is_inline && typeof raw.line_number === 'number' ? raw.line_number : null,
    replies: flatReplies(raw.replies),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Порт Bitbucket поверх MCP-сервера контура: имя сервера берется из профиля контура репозитория,
 * поэтому запрос одного контура никогда не уходит в Bitbucket другого.
 */
export function createScmMcp(call: Call, contours: Contour[]): ScmPort {
  const target = (ref: ScmRepoRef) => {
    const contour = contours.find((c) => c.id === ref.contour);
    if (!contour?.mcp.bitbucket) throw new Error(`Для контура ${ref.contour} не настроен MCP-сервер Bitbucket`);
    return { server: contour.mcp.bitbucket, git: contour.git.replace(/\/+$/, '') };
  };
  const toRef = (pr: RawPr, ref: ScmRepoRef, git: string): PullRequestRef => {
    if (typeof pr.id !== 'number') throw new Error('Bitbucket вернул PR без id');
    return {
      id: pr.id,
      title: pr.title ?? '',
      url: pr.web_url ?? `${git}/projects/${ref.project}/repos/${ref.repo}/pull-requests/${pr.id}`,
      ...(pr.destination_branch ? { to: pr.destination_branch } : {}),
    };
  };
  return {
    async openPullRequests(ref, branch) {
      const t = target(ref);
      let raw: { open_pull_requests?: RawPr[] };
      try {
        raw = (await call(t.server, 'get_branch', { workspace: ref.project, repository: ref.repo, branch_name: branch })) as typeof raw;
      } catch (e) {
        // Только точное сообщение о ветке: так же сервер отвечает на неверный проект или репозиторий,
        // но это решает вызывающий, зная, есть ли ветка на remote.
        const missing = new RegExp(`Branch '${escapeRegExp(branch)}' not found in ${escapeRegExp(ref.project)}/${escapeRegExp(ref.repo)}`, 'i');
        if (e instanceof Error && missing.test(e.message)) return null;
        throw e;
      }
      return (raw.open_pull_requests ?? []).map((pr) => toRef(pr, ref, t.git));
    },
    async createPullRequest(ref, input) {
      const t = target(ref);
      const raw = (await call(t.server, 'create_pull_request', {
        workspace: ref.project,
        repository: ref.repo,
        title: input.title,
        description: input.description,
        source_branch: input.from,
        destination_branch: input.to,
        ...(input.reviewers.length ? { reviewers: input.reviewers } : {}),
      })) as RawPr & { pull_request?: RawPr };
      // Сервер отвечает только id, версией, статусом и ссылкой: заголовок и цель берутся из запроса.
      const created = toRef(raw.pull_request ?? raw, ref, t.git);
      return { ...created, title: created.title || input.title, to: created.to ?? input.to };
    },
    async findPullRequest(ref, branch) {
      const t = target(ref);
      const raw = (await call(t.server, 'list_pull_requests', { workspace: ref.project, repository: ref.repo, state: 'ALL', limit: FIND_LIMIT })) as { pull_requests?: RawPr[] };
      const found = (raw.pull_requests ?? []).filter((p) => p.source_branch === branch && typeof p.id === 'number').sort((a, b) => b.id! - a.id!)[0];
      return found ? toRef(found, ref, t.git) : null;
    },
    async pullRequest(ref, id) {
      const t = target(ref);
      const raw = (await call(t.server, 'get_pull_request', {
        workspace: ref.project,
        repository: ref.repo,
        pull_request_id: id,
        include_file_changes: false,
        comment_limit: COMMENT_LIMIT,
      })) as RawPr & { state?: string; author?: string; reviewers?: string[]; active_comments?: RawComment[] };
      return {
        ...toRef(raw, ref, t.git),
        state: raw.state ?? 'OPEN',
        author: raw.author ?? '',
        reviewers: (raw.reviewers ?? []).map(parseReviewer),
        comments: (raw.active_comments ?? []).map(toComment),
      };
    },
    async reply(ref, prId, commentId, text) {
      const t = target(ref);
      await call(t.server, 'add_comment', { workspace: ref.project, repository: ref.repo, pull_request_id: prId, parent_comment_id: commentId, comment_text: text });
    },
  };
}
