import type { RunJournal } from '@task-pilot/step-kit';
import { RESTARTED, STOPPED } from './engine/engine.ts';
import type { Redactor } from './lib/redact.ts';
import type { Store } from './store/db.ts';

const INTERRUPTED = new Set([STOPPED, RESTARTED]);

const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * Журнал прогона: решения владельца на подтверждениях (переделать, отклонить) и повторы упавших шагов с его
 * замечанием агенту, вопросы агентов с ответами, падения шагов, отказы агентам в инструментах и круги петель. Остановка владельцем и перезапуск сервера
 * падениями не считаются. Тексты владельца проходят маскирование секретов.
 */
export function journalOf(store: Store, runId: string, title: (stepId: string) => string, redact: Redactor): RunJournal {
  const journal: RunJournal = { corrections: [], questions: [], failures: [], denials: [], loops: [] };
  const entry = (stepId: string, at: string) => ({ stepId, step: title(stepId), at });
  for (const e of store.journalEvents(runId)) {
    if (!e.stepId) continue;
    const data = (e.data ?? {}) as Record<string, unknown>;
    const from = { ...entry(e.stepId, e.ts), eventId: e.id };
    if (e.type === 'approval.decided' && (data.decision === 'rework' || data.decision === 'rejected')) {
      const approval = isString(data.approvalId) ? store.getApproval(data.approvalId) : undefined;
      const comment = isString(data.comment) && data.comment.trim() ? redact.text(data.comment.trim()) : null;
      journal.corrections.push({ ...from, decision: data.decision, title: approval?.preview.title ?? e.message ?? '', comment });
    } else if (e.type === 'step.status' && data.status === 'pending' && isString(data.note)) {
      // Повтор упавшего шага с замечанием агенту: заголовок записи - ошибка, к которой относится замечание.
      journal.corrections.push({ ...from, decision: 'retry', title: isString(data.error) ? data.error : '', comment: redact.text(data.note) });
    } else if (e.type === 'step.status' && data.status === 'failed') {
      // До того как ошибка попала в данные события, она была только в тексте: "Шаг: упал. ошибка".
      const error = isString(data.error) ? data.error : (e.message ?? '').replace(/^[^:]*: [^.]*\.\s*/, '');
      if (!INTERRUPTED.has(error)) journal.failures.push({ ...from, error });
    } else if (e.type === 'agent.denied' && Array.isArray(data.denials)) {
      journal.denials.push({ ...from, tools: data.denials.filter(isString) });
    } else if (e.type === 'loop.restart' && typeof data.round === 'number') {
      journal.loops.push({ ...from, round: data.round, max: Number(data.max) || data.round });
    }
  }
  for (const q of store.questionsOf(runId)) {
    if (q.status === 'answered' && q.answer) journal.questions.push({ ...entry(q.stepId, q.answeredAt ?? q.createdAt), question: redact.text(q.question), answer: redact.text(q.answer) });
  }
  return journal;
}
