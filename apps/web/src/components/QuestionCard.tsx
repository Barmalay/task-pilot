import { MessageCircleQuestion, Send } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import type { QuestionDto } from '@task-pilot/api-types';
import { composeAnswers, numberedQuestions } from '../answers.ts';
import { Button } from '../ui.tsx';
import { Markdown } from './Markdown.tsx';

const FIELD = 'w-full rounded-lg border border-amber-300 bg-white p-2 text-sm dark:border-amber-800 dark:bg-slate-950';

/**
 * Вопрос агента владельцу: варианты ответа кнопками и свободный ответ. Если агент спросил несколько пронумерованных
 * вопросов сразу, у каждого свое поле, и ответ уходит агенту списком с номерами вопросов; общее поле - для остального.
 */
export function QuestionCard({ question, stepTitle, busy, onAnswer }: { question: QuestionDto; stepTitle: string; busy: boolean; onAnswer: (answer: string) => void }) {
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const parts = numberedQuestions(question.question);
  const answer = parts ? composeAnswers(answers, text, 'Ответы') : text.trim();
  const send = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answer) onAnswer(answer);
  };
  return (
    <div data-question={question.id} className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 shadow-sm dark:border-amber-700 dark:bg-amber-950/60">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
        <MessageCircleQuestion className="size-4" aria-hidden />
        Агент спрашивает, шаг "{stepTitle}"
        <span className="ml-auto text-xs font-normal tabular-nums text-amber-700/80">
          {new Date(question.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {parts ? (
        <>
          {parts.intro && <Markdown text={parts.intro} className="mt-2 text-sm text-slate-800 dark:text-slate-100" />}
          <ol className="mt-2 space-y-3">
            {parts.items.map((item, i) => (
              <li key={i}>
                <div className="flex gap-2 text-sm text-slate-800 dark:text-slate-100">
                  <span className="font-medium tabular-nums">{i + 1}.</span>
                  <Markdown text={item} className="min-w-0 flex-1" />
                </div>
                <textarea
                  className={`mt-1 ${FIELD}`}
                  rows={2}
                  placeholder="Ответ"
                  aria-label={`Ответ на вопрос ${i + 1}`}
                  value={answers[i] ?? ''}
                  onKeyDown={send}
                  onChange={(e) => {
                    const next = parts.items.map((_, j) => answers[j] ?? '');
                    next[i] = e.target.value;
                    setAnswers(next);
                  }}
                />
              </li>
            ))}
          </ol>
          {parts.outro && <Markdown text={parts.outro} className="mt-2 text-sm text-slate-800 dark:text-slate-100" />}
        </>
      ) : (
        <Markdown text={question.question} className="mt-2 text-sm text-slate-800 dark:text-slate-100" />
      )}
      {question.options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {question.options.map((o) => (
            <Button key={o} variant="secondary" size="sm" disabled={busy} onClick={() => onAnswer(o)} title="Ответить агенту этим вариантом">
              {o}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-end gap-2">
        <textarea
          className={`min-h-10 flex-1 ${FIELD}`}
          rows={2}
          placeholder={parts ? 'Еще что-то агенту, по желанию' : 'Ответ агенту'}
          aria-label={parts ? 'Дополнение к ответам' : 'Ответ агенту'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={send}
        />
        <Button
          icon={Send}
          disabled={busy || !answer}
          onClick={() => onAnswer(answer)}
          title={answer ? 'Отправить ответ агенту. Cmd+Enter тоже отправляет' : parts ? 'Ответьте хотя бы на один вопрос' : 'Напишите ответ в поле слева или выберите вариант выше'}
        >
          Ответить
        </Button>
      </div>
    </div>
  );
}
