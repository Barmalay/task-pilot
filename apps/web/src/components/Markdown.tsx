import { Code2, Eye } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PreviewText } from '@task-pilot/step-kit';
import { Button, cx } from '../ui.tsx';
import { JiraMarkup, type FileUrl } from './JiraMarkup.tsx';

const PLUGINS = [remarkGfm];
const HIDDEN = ['img'];
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

/**
 * Текст в markdown так, как его увидит человек: заголовки, списки, таблицы, код и ссылки (GFM). Сырой HTML в тексте
 * не отрисовывается, картинки тоже: тексты пишет агент, и внешний адрес из них не должен грузиться сам. Ссылки
 * открываются в новой вкладке. Цвет текста берется от родителя.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx('md', className)}>
      <ReactMarkdown remarkPlugins={PLUGINS} skipHtml disallowedElements={HIDDEN} unwrapDisallowed components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Тело текста превью подтверждения в рамке с прокруткой. Текст в markdown и в wiki-разметке Jira показывается
 * отрисованным, а кнопка "Исходник" переключает на сам текст, как его получит система; обычный текст - как есть.
 * Миниатюры текста Jira берутся из файлов прогона по fileUrl.
 */
export function PreviewTextBody({
  text,
  format,
  className,
  boxClassName,
  fileUrl,
}: {
  text: string;
  format: PreviewText['format'];
  className?: string;
  boxClassName?: string;
  fileUrl?: FileUrl;
}) {
  const [raw, setRaw] = useState(false);
  const rich = format === 'markdown' || format === 'jira';
  const box = cx('overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100', rich && 'pr-28', boxClassName);
  return (
    <div className={cx('relative', className)}>
      {/* Кнопка поверх рамки: обертка подсказки у кнопки иначе заняла бы строку над текстом. */}
      {rich && (
        <div className="absolute top-1.5 right-1.5 z-10">
          <Button
            variant="ghost"
            size="sm"
            icon={raw ? Eye : Code2}
            className="bg-white/90 dark:bg-slate-950/90"
            onClick={() => setRaw((r) => !r)}
            title={raw ? 'Показать текст отрисованным, как его увидит человек' : `Показать исходный текст ${format === 'jira' ? 'в разметке Jira' : 'markdown'}, как его получит система`}
          >
            {raw ? 'Как выглядит' : 'Исходник'}
          </Button>
        </div>
      )}
      {rich && !raw ? (
        format === 'jira' ? (
          <JiraMarkup text={text || '(пусто)'} fileUrl={fileUrl} className={box} />
        ) : (
          <Markdown text={text || '(пусто)'} className={box} />
        )
      ) : (
        <pre className={cx(box, 'whitespace-pre-wrap wrap-anywhere', rich ? 'font-mono text-xs' : 'font-sans')}>{text || '(пусто)'}</pre>
      )}
    </div>
  );
}
