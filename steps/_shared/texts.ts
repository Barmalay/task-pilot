import type { LintIssue, StepContext } from '../../packages/step-kit/src/index.ts';

/** Тексты публикации: сообщение коммита и PR. */
export interface PublishTexts {
  subject: string;
  body: string;
  prTitle: string;
  prDescription: string;
}

/** JSON Schema итога агента, который готовит тексты публикации. */
export const TEXTS_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Заголовок коммита с ключом задачи в начале' },
    body: { type: 'string', description: 'Тело коммита, может быть пустым' },
    prTitle: { type: 'string' },
    prDescription: { type: 'string', description: 'Описание PR в Markdown' },
  },
  required: ['subject', 'body', 'prTitle', 'prDescription'],
  additionalProperties: false,
};

/** Разбирает итог агента по TEXTS_SCHEMA; без заголовка коммита - ошибка. */
export function textsOutput(value: unknown): PublishTexts {
  const o = (value ?? {}) as Record<string, unknown>;
  if (typeof o.subject !== 'string' || !o.subject.trim()) throw new Error('Агент не вернул заголовок коммита');
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  return { subject: o.subject, body: str('body'), prTitle: str('prTitle'), prDescription: str('prDescription') };
}

/**
 * Приводит тексты агента к правилам: ключ задачи в начале заголовка коммита и исправления линтера.
 * Что линтер исправил сам, возвращается в fixed: это показывается на подтверждении.
 */
export function finishTexts(c: StepContext, raw: PublishTexts): PublishTexts & { fixed: LintIssue[] } {
  const key = c.run.issueKey;
  const subjectRaw = raw.subject.split('\n')[0]!.trim();
  const subject = subjectRaw.startsWith(key) ? subjectRaw : `${key} ${subjectRaw}`;
  const fixed: LintIssue[] = [];
  const clean = (label: string, text: string) => {
    const r = c.lint(text);
    for (const i of r.issues) if (i.severity === 'fixed') fixed.push({ ...i, message: `${label}: ${i.message}` });
    return r.text;
  };
  return {
    subject: clean('Коммит', subject),
    body: clean('Коммит', raw.body),
    prTitle: clean('Заголовок PR', raw.prTitle.trim() || subject),
    prDescription: clean('Описание PR', raw.prDescription),
    fixed,
  };
}

/** Сообщение коммита: заголовок и, если оно есть, тело через пустую строку. */
export function commitMessage(t: { subject: string; body: string }): string {
  return t.body.trim() ? `${t.subject}\n\n${t.body.trim()}` : t.subject;
}
