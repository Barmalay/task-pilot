import type { PrComment, PullRequestState } from './types.ts';

/**
 * Замечания PR, на которые автор еще не ответил: открытые комментарии других людей, в ветке которых последнее
 * слово не за автором. Разрешенные ревьюером комментарии не считаются, как и собственные заметки автора.
 */
export function commentsToAnswer(pr: Pick<PullRequestState, 'author' | 'comments'>): PrComment[] {
  return pr.comments.filter((c) => c.state === 'OPEN' && c.author !== pr.author && (c.replies.at(-1)?.author ?? c.author) !== pr.author);
}
