import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { JiraAttachment, JiraPort } from '@task-pilot/step-kit';

type StoredAttachment = JiraAttachment & { key: string };

/**
 * Вложения и комментарии Jira в памяти: для демо-режима и тестов. Отрисовка комментария считается как у Jira:
 * миниатюра `!file|thumbnail!` загруженного к задаче файла становится картинкой, миниатюра без файла - нет.
 */
export function memoryJiraFiles(baseUrl = 'https://demo.invalid') {
  const attachments = new Map<string, StoredAttachment>();
  const comments = new Map<string, { key: string; body: string }>();
  let seq = 0;
  const strip = ({ key: _key, ...a }: StoredAttachment): JiraAttachment => a;
  const port: Pick<JiraPort, 'attachments' | 'attach' | 'deleteAttachment' | 'comment'> = {
    async attachments(key) {
      return [...attachments.values()].filter((a) => a.key === key).map(strip);
    },
    async attach(key, file) {
      const a: StoredAttachment = { key, id: String(10_000 + ++seq), filename: basename(file), size: statSync(file).size, created: new Date().toISOString() };
      attachments.set(a.id, a);
      return strip(a);
    },
    async deleteAttachment(id) {
      if (!attachments.delete(id)) throw new Error(`Вложения ${id} нет`);
    },
    async comment(key, body, commentId) {
      if (commentId && !comments.has(commentId)) throw new Error(`Комментария ${commentId} нет`);
      const id = commentId ?? String(20_000 + ++seq);
      comments.set(id, { key, body });
      const names = new Set([...attachments.values()].filter((a) => a.key === key).map((a) => a.filename));
      const thumbnails = [...body.matchAll(/!([^!|\n]+)\|thumbnail!/g)].map((m) => m[1]!);
      const images = thumbnails.filter((n) => names.has(n)).length;
      return {
        id,
        url: `${baseUrl}/browse/${key}?focusedCommentId=${id}#comment-${id}`,
        rendered: { images, rows: body.split('\n').filter((l) => l.startsWith('|')).length, unresolved: thumbnails.length - images },
      };
    },
  };
  return { port, attachments, comments };
}
