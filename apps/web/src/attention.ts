import type { AttentionDto } from '@task-pilot/api-types';

/** Прогон, который ждет владельца, и что в нем ждет: подтверждения и вопросы в порядке запросов. */
export interface AttentionRun {
  runId: string;
  issueKey: string;
  items: AttentionDto[];
}

/** Прогоны, которые ждут владельца: по одному на прогон, первым - тот, что ждет дольше всех. */
export function attentionRuns(items: AttentionDto[]): AttentionRun[] {
  const runs = new Map<string, AttentionRun>();
  for (const item of [...items].sort((a, b) => a.at.localeCompare(b.at))) {
    const run = runs.get(item.runId);
    if (run) run.items.push(item);
    else runs.set(item.runId, { runId: item.runId, issueKey: item.issueKey, items: [item] });
  }
  return [...runs.values()];
}

/** Что сделать владельцу, словами: подтвердить шаг или ответить агенту. */
export function attentionAction(item: Pick<AttentionDto, 'kind' | 'step'>): string {
  return item.kind === 'approval' ? `подтвердить шаг "${item.step}"` : `ответить агенту шага "${item.step}"`;
}

/** Подпись счетчика в шапке: сколько прогонов ждут. */
export function attentionCount(runs: number): string {
  const last = runs % 10;
  const teen = runs % 100 >= 11 && runs % 100 <= 14;
  const word = !teen && last === 1 ? 'прогон ждет' : !teen && last >= 2 && last <= 4 ? 'прогона ждут' : 'прогонов ждут';
  return `${runs} ${word} вас`;
}

/** События, после которых список того, что ждет владельца, стал другим: его надо перечитать. */
const CHANGES = new Set(['approval.requested', 'approval.decided', 'approval.stale', 'question.asked', 'question.answered', 'question.expired', 'run.deleted']);

/** Меняет ли событие общего потока список "Ждут вас". */
export function changesAttention(type: string): boolean {
  return CHANGES.has(type);
}
