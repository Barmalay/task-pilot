import { useQuery } from '@tanstack/react-query';
import { ImageOff, Paperclip } from 'lucide-react';
import { createElement, useCallback, useMemo, type ReactNode } from 'react';
import { api } from '../api.ts';
import { parseJira, type JiraBlock, type JiraInline, type JiraList, type JiraMark } from '../jira.ts';
import { cx } from '../ui.tsx';

/** Адрес локального файла по имени вложения из текста; null - такого файла среди артефактов прогона нет. */
export type FileUrl = (name: string) => string | null;

const MARK_TAG: Record<JiraMark, string> = { strong: 'strong', em: 'em', del: 'del', ins: 'ins', sup: 'sup', sub: 'sub', cite: 'cite' };
/** Цвет {color} только именем или hex: значение из текста не попадает в стиль как есть. */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i;

/**
 * Файлы папки артефактов прогона по имени: миниатюры текста Jira показываются из них еще до загрузки во вложения.
 * Список грузится, только когда он нужен, и делится с галереей артефактов страницы.
 */
export function useArtifactUrls(runId: string, enabled: boolean): FileUrl {
  const q = useQuery({ queryKey: ['artifacts', runId], queryFn: () => api.artifacts(runId), enabled });
  const files = q.data?.files;
  return useCallback(
    (name: string) => {
      const f = files?.find((x) => x.name === name);
      return f ? `${api.artifactUrl(runId, f.name)}?v=${encodeURIComponent(f.modified)}` : null;
    },
    [files, runId],
  );
}

function inline(nodes: JiraInline[], fileUrl: FileUrl | undefined): ReactNode[] {
  return nodes.map((n, k): ReactNode => {
    switch (n.kind) {
      case 'text':
        return n.text;
      case 'break':
        return <br key={k} />;
      case 'mark':
        return createElement(MARK_TAG[n.mark], { key: k }, ...inline(n.children, fileUrl));
      case 'code':
        return <code key={k}>{n.text}</code>;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer">
            {inline(n.children, fileUrl)}
          </a>
        );
      case 'color':
        return SAFE_COLOR.test(n.color) ? (
          <span key={k} style={{ color: n.color }}>
            {inline(n.children, fileUrl)}
          </span>
        ) : (
          <span key={k}>{inline(n.children, fileUrl)}</span>
        );
      case 'mention':
        return (
          <span key={k} className="rounded bg-blue-50 px-1 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
            @{n.user}
          </span>
        );
      case 'attachment': {
        const url = fileUrl?.(n.name) ?? null;
        const body = (
          <>
            <Paperclip className="size-3.5 shrink-0" aria-hidden />
            {n.name}
          </>
        );
        return url ? (
          <a key={k} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5">
            {body}
          </a>
        ) : (
          <span key={k} className="inline-flex items-center gap-0.5 text-blue-700 dark:text-blue-400" title="Вложение задачи">
            {body}
          </span>
        );
      }
      case 'image': {
        // Картинка по адресу в сети сама не грузится: тексты пишет агент.
        const url = /^https?:/i.test(n.source) ? null : (fileUrl?.(n.source) ?? null);
        if (!url) {
          return (
            <span key={k} className="inline-flex items-center gap-1 rounded bg-amber-50 px-1 font-mono text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-300" title="Файла нет среди артефактов прогона">
              <ImageOff className="size-3.5 shrink-0" aria-hidden />
              {n.source}
            </span>
          );
        }
        // Миниатюра сжимается по ширине ячейки: узкая колонка таблицы не распирает окно подтверждения.
        return (
          <a key={k} href={url} target="_blank" rel="noreferrer" title={`${n.source}. Открыть в новой вкладке`} className="mr-1">
            <img
              src={url}
              alt={n.source}
              loading="lazy"
              className={cx('mb-1 inline-block max-w-full rounded align-top ring-1 ring-slate-200 dark:ring-slate-700', n.thumbnail && 'max-h-24')}
            />
          </a>
        );
      }
    }
  });
}

function list(l: JiraList, key: number, fileUrl: FileUrl | undefined): ReactNode {
  const items = l.items.map((item, k) => (
    <li key={k}>
      {inline(item.content, fileUrl)}
      {item.lists.map((sub, j) => list(sub, j, fileUrl))}
    </li>
  ));
  return l.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
}

function block(b: JiraBlock, key: number, fileUrl: FileUrl | undefined): ReactNode {
  switch (b.kind) {
    case 'heading':
      return createElement(`h${b.level}`, { key }, ...inline(b.content, fileUrl));
    case 'paragraph':
      return <p key={key}>{inline(b.content, fileUrl)}</p>;
    case 'list':
      return list(b, key, fileUrl);
    case 'table':
      return (
        <table key={key}>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={r}>{row.map((cell, c) => (cell.header ? <th key={c}>{inline(cell.content, fileUrl)}</th> : <td key={c}>{inline(cell.content, fileUrl)}</td>))}</tr>
            ))}
          </tbody>
        </table>
      );
    case 'code':
      return (
        <pre key={key}>
          <code>{b.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key}>{b.blocks.map((x, i) => block(x, i, fileUrl))}</blockquote>;
    case 'panel':
      return (
        <div key={key} className="my-2 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          {b.title && <div className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 font-medium dark:border-slate-700 dark:bg-slate-800">{b.title}</div>}
          <div className="px-3 py-2">{b.blocks.map((x, i) => block(x, i, fileUrl))}</div>
        </div>
      );
    case 'rule':
      return <hr key={key} />;
  }
}

/**
 * Текст в wiki-разметке Jira Server так, как его покажет Jira: заголовки, таблицы, списки, выделение, код, ссылки
 * и вложения. Миниатюры берутся из файлов прогона по fileUrl: до публикации их во вложениях Jira еще нет. Картинки по
 * адресу в сети не грузятся, сырой HTML не отрисовывается: разметка разбирается в узлы React.
 */
export function JiraMarkup({ text, fileUrl, className }: { text: string; fileUrl?: FileUrl; className?: string }) {
  const blocks = useMemo(() => parseJira(text), [text]);
  return <div className={cx('md', className)}>{blocks.map((b, i) => block(b, i, fileUrl))}</div>;
}
