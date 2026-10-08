import { acceptanceCriteriaOf } from './ac.ts';
import { boardStatuses, normalizeName } from './milestones.ts';
import type { JiraConfig } from './profiles.ts';
import type { Issue } from './types.ts';

/** Что изменилось в задаче Jira с тех пор, как ее видел прогон. */
export interface IssueChange {
  kind: 'status' | 'description' | 'ac' | 'comments' | 'fields';
  text: string;
  /** Задачу вернули назад по доске: на доработку или в работу. */
  returned?: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Изменения задачи по сравнению со снимком прогона: статус (и вернули ли задачу назад по доске), описание и критерии
 * приемки, новые комментарии не от владельца (board.me) и поля: метки, компоненты, исполнитель. Переход в другой спринт
 * доработки не требует, а время обновления само по себе изменением не считается: его сдвигают и действия самого прогона.
 */
export function issueChanges(before: Issue, after: Issue, board: Pick<JiraConfig, 'path' | 'after' | 'me'>): IssueChange[] {
  const changes: IssueChange[] = [];
  if (normalizeName(before.status) !== normalizeName(after.status)) {
    const order = boardStatuses(board).map(normalizeName);
    const was = order.indexOf(normalizeName(before.status));
    const now = order.indexOf(normalizeName(after.status));
    const returned = was >= 0 && now >= 0 && now < was;
    changes.push({ kind: 'status', text: `статус ${before.status} → ${after.status}${returned ? ', задачу вернули' : ''}`, returned });
  }
  const acBefore = acceptanceCriteriaOf(before);
  const acAfter = acceptanceCriteriaOf(after);
  if (!same(acBefore, acAfter)) {
    changes.push({ kind: 'ac', text: `критерии приемки: было ${acBefore?.length ?? 0}, стало ${acAfter?.length ?? 0}` });
  } else if (before.description.trim() !== after.description.trim()) {
    changes.push({ kind: 'description', text: 'изменилось описание' });
  }
  // Снимок без комментариев сделан до того, как порт стал их читать: сравнивать не с чем.
  if (before.comments && after.comments) {
    const known = new Set(before.comments.map((c) => c.id));
    const fresh = after.comments.filter((c) => !known.has(c.id) && c.author !== board.me);
    if (fresh.length) changes.push({ kind: 'comments', text: `новые комментарии: ${fresh.length}` });
  }
  const fields = [
    ['метки', before.labels, after.labels],
    ['компоненты', before.components, after.components],
    ['исполнитель', before.assignee?.name, after.assignee?.name],
  ].filter(([, a, b]) => !same(a, b));
  if (fields.length) changes.push({ kind: 'fields', text: `изменились поля: ${fields.map(([name]) => name).join(', ')}` });
  return changes;
}
