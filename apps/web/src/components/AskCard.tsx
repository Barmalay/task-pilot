import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Send } from 'lucide-react';
import { useEffect, useRef, type Ref } from 'react';
import { api } from '../api.ts';
import { Button, Card, ErrorBox } from '../ui.tsx';
import { Markdown } from './Markdown.tsx';

const stamp = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Карточка вопросов о прогоне: владелец спрашивает, что происходит, почему шаг стоит или упал, а агент, который только
 * читает ленту, шаги, код шагов и рабочую папку задачи, отвечает здесь же. Вопросы идут по порядку, свежий внизу у поля.
 * Пока агент отвечает, новый вопрос не отправляется. Черновик вопроса живет у страницы: его подставляет кнопка
 * "Спросить" строки "сейчас".
 */
export function AskCard({ runId, draft, onDraft, inputRef }: { runId: string; draft: string; onDraft: (text: string) => void; inputRef?: Ref<HTMLTextAreaElement> }) {
  const qc = useQueryClient();
  const asks = useQuery({ queryKey: ['asks', runId], queryFn: () => api.asks(runId) });
  const send = useMutation({
    mutationFn: (question: string) => api.ask(runId, question),
    onSuccess: () => {
      onDraft('');
      void qc.invalidateQueries({ queryKey: ['asks', runId] });
    },
  });
  const list = asks.data ?? [];
  const pending = list.some((a) => a.status === 'pending');
  const question = draft.trim();
  const submit = () => {
    if (question && !pending && !send.isPending) send.mutate(question);
  };
  // Новый вопрос и ответ видны сразу: список прокручивается к последнему.
  const listRef = useRef<HTMLOListElement>(null);
  const last = list.at(-1);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [last?.id, last?.status]);
  return (
    <Card>
      <div data-asks>
        <h2 className="border-b border-slate-100 px-4 py-2 font-semibold dark:border-slate-800">Вопросы о прогоне</h2>
        {list.length > 0 && (
          <ol ref={listRef} className="max-h-[28rem] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {list.map((a) => (
              <li key={a.id} className="space-y-1.5 px-4 py-3 text-sm">
                <p className="whitespace-pre-wrap font-medium wrap-anywhere text-slate-800 dark:text-slate-100">{a.question}</p>
                {a.status === 'pending' && (
                  <p className="flex items-center gap-2 text-slate-500">
                    <LoaderCircle className="size-4 animate-spin" aria-hidden />
                    Агент читает ленту, шаги и код
                  </p>
                )}
                {a.status === 'failed' && <p className="text-red-700 dark:text-red-400">{a.error}</p>}
                {a.status === 'answered' && a.answer && <Markdown text={a.answer} className="text-slate-700 dark:text-slate-200" />}
                <p className="text-xs tabular-nums text-slate-400">
                  {stamp(a.createdAt)}
                  {a.costUsd !== null && `, $${a.costUsd.toFixed(2)}`}
                </p>
              </li>
            ))}
          </ol>
        )}
        <div className="space-y-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          <textarea
            ref={inputRef}
            rows={3}
            className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            placeholder="Что происходит с прогоном, почему шаг стоит или упал"
            aria-label="Вопрос о прогоне"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">
              Агент только читает и ничего не меняет, ответ обычно стоит <span className="whitespace-nowrap">$0.1-0.5</span>
            </span>
            <Button
              size="sm"
              icon={Send}
              spin={send.isPending}
              disabled={!question || pending || send.isPending}
              onClick={submit}
              title={pending ? 'Агент еще отвечает на прошлый вопрос' : 'Спросить агента о прогоне. Cmd+Enter тоже отправляет'}
            >
              Спросить
            </Button>
          </div>
          {send.error && <ErrorBox error={send.error} title="Вопрос не отправлен" />}
        </div>
      </div>
    </Card>
  );
}
