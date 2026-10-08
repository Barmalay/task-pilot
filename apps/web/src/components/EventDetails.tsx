import { useQuery } from '@tanstack/react-query';
import { CircleAlert, FileDiff, FolderSearch, Hand, MessageCircleQuestion, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EventDetailsDto, EventDto, PatchHunkDto, ToolCallDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { hasDetails, numberedLines } from '../feed.ts';
import { Chip, cx, ErrorBox, Loading } from '../ui.tsx';
import { useArtifactUrls } from './JiraMarkup.tsx';
import { Markdown, PreviewTextBody } from './Markdown.tsx';

const APPROVAL_STATUS: Record<string, string> = {
  pending: 'ждет решения',
  approved: 'подтверждено',
  consumed: 'подтверждено и выполнено',
  rework: 'на доработку',
  rejected: 'отклонено',
  stale: 'сгорело',
};

const QUESTION_STATUS: Record<string, string> = { open: 'ждет ответа', answered: 'отвечен', expired: 'закрыт без ответа' };

function stamp(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

function Pre({ text, className }: { text: string; className?: string }) {
  return <pre className={cx('max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-100', className)}>{text}</pre>;
}

/** Дифф правки файла: номера строк в старом и новом файле, удаленные красным, добавленные зеленым. */
export function DiffView({ patch }: { patch: PatchHunkDto[] }) {
  return (
    <div className="max-h-[32rem] overflow-auto rounded-lg border border-slate-200 font-mono text-xs dark:border-slate-700">
      {patch.map((h, i) => (
        <div key={i} className="min-w-fit">
          <div className="sticky left-0 bg-slate-100 px-2 py-0.5 text-slate-500 dark:bg-slate-800">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {numberedLines(h).map((l, j) => (
            <div
              key={j}
              className={cx(
                'grid grid-cols-[3rem_3rem_1rem_minmax(0,1fr)]',
                l.kind === '-' && 'bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-200',
                l.kind === '+' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200',
              )}
            >
              <span className="select-none pr-2 text-right text-slate-400">{l.old ?? ''}</span>
              <span className="select-none pr-2 text-right text-slate-400">{l.new ?? ''}</span>
              <span className="select-none text-slate-400">{l.kind === ' ' ? '' : l.kind}</span>
              <span className="whitespace-pre pr-3">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Вызов инструмента агентом: дифф правки, команда с выводом, найденные файлы или вход и ответ как есть. */
function ToolCall({ call }: { call: ToolCallDto }) {
  const { tool, input, result } = call;
  const file = result?.filePath ?? str(input.file_path) ?? str(input.notebook_path);
  const command = str(input.command);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {result?.patch ? <FileDiff className="size-4 text-slate-500" aria-hidden /> : command ? <SquareTerminal className="size-4 text-slate-500" aria-hidden /> : <FolderSearch className="size-4 text-slate-500" aria-hidden />}
        <span className="font-medium">{tool}</span>
        {file && <span className="font-mono text-xs text-slate-600 wrap-anywhere dark:text-slate-300">{file}</span>}
        {result?.change && <Chip tone={result.change === 'create' ? 'green' : 'blue'}>{result.change === 'create' ? 'новый файл' : 'файл изменен'}</Chip>}
        {result?.isError && <Chip tone="red">ошибка</Chip>}
        {result?.interrupted && <Chip tone="amber">прервано</Chip>}
      </div>
      {command && (
        <Section title={str(input.description) ?? 'Команда'}>
          <Pre text={command} />
        </Section>
      )}
      {result?.patch && result.patch.length > 0 && (
        <Section title="Изменения">
          <DiffView patch={result.patch} />
        </Section>
      )}
      {result?.files && (
        <Section title={`Найдено файлов: ${result.files.length}`}>
          <Pre text={result.files.join('\n') || 'ничего не найдено'} />
        </Section>
      )}
      {result && (result.stdout !== undefined || result.stderr !== undefined) ? (
        <>
          {result.stdout ? (
            <Section title="Вывод">
              <Pre text={result.stdout} />
            </Section>
          ) : null}
          {result.stderr ? (
            <Section title="Ошибки">
              <Pre text={result.stderr} className="text-red-800 dark:text-red-200" />
            </Section>
          ) : null}
          {!result.stdout && !result.stderr && <p className="text-sm text-slate-500">Команда ничего не вывела</p>}
        </>
      ) : (
        result?.text &&
        !result.patch && (
          <Section title={result.isError ? 'Ошибка' : 'Ответ инструмента'}>
            <Pre text={result.text} className={result.isError ? 'text-red-800 dark:text-red-200' : undefined} />
          </Section>
        )
      )}
      {!command && !result?.patch && (
        <Section title="Что агент передал">
          <Pre text={JSON.stringify(input, null, 2)} />
        </Section>
      )}
      {!result && <p className="text-sm text-slate-500">Ответа инструмента в журнале нет: запуск агента мог прерваться</p>}
      {result?.clipped && <p className="text-xs text-slate-500">Показано не все: длинный текст обрезан</p>}
    </div>
  );
}

/** Что было на подтверждении и чем оно закончилось. */
function Approval({ runId, approval }: { runId: string; approval: Extract<EventDetailsDto, { kind: 'approval' }>['approval'] }) {
  const { preview } = approval;
  const fileUrl = useArtifactUrls(runId, preview.texts?.some((t) => t.format === 'jira') ?? false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Hand className="size-4 text-amber-600" aria-hidden />
        <span className="font-medium">{preview.title}</span>
        <Chip tone={approval.status === 'rejected' || approval.status === 'stale' ? 'slate' : approval.status === 'pending' ? 'amber' : approval.status === 'rework' ? 'amber' : 'green'}>
          {APPROVAL_STATUS[approval.status] ?? approval.status}
        </Chip>
      </div>
      <p className="text-xs text-slate-500">
        Запрошено {stamp(approval.createdAt)}
        {approval.decidedAt && `, решение ${stamp(approval.decidedAt)}`}
      </p>
      {preview.summary && <Markdown text={preview.summary} className="text-sm text-slate-800 dark:text-slate-100" />}
      {approval.comment && (
        <Section title="Ваше замечание">
          <p className="text-sm wrap-anywhere">{approval.comment}</p>
        </Section>
      )}
      <Section title="Что будет сделано">
        {preview.actions.length ? (
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {preview.actions.map((a) => (
              <li key={a} className="wrap-anywhere">
                {a}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-slate-500">Действий нет</p>
        )}
      </Section>
      {preview.warnings?.length ? (
        <Section title="Обратите внимание">
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-900 dark:text-amber-200">
            {preview.warnings.map((w) => (
              <li key={w} className="wrap-anywhere">
                {w}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {(preview.texts ?? []).map((t) => (
        <Section key={t.id} title={t.label}>
          <div className="mb-1">{t.publish ? <Chip tone="blue">будет опубликовано</Chip> : <Chip>на утверждение</Chip>}</div>
          <PreviewTextBody text={t.text} format={t.format} fileUrl={fileUrl} boxClassName="max-h-96" />
        </Section>
      ))}
      {(preview.notes ?? []).map((n) => (
        <Section key={n.id} title={n.label}>
          <div className="mb-1">
            <Chip>справка</Chip>
          </div>
          <Pre text={n.text} />
        </Section>
      ))}
      {preview.lint?.length ? (
        <Section title="Замечания линтера">
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {preview.lint.map((i, n) => (
              <li key={n} className={cx(i.severity === 'block' && 'text-red-700 dark:text-red-300')}>
                {i.message}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Question({ question }: { question: Extract<EventDetailsDto, { kind: 'question' }>['question'] }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <MessageCircleQuestion className="size-4 text-amber-600" aria-hidden />
        <span className="font-medium">Вопрос агента</span>
        <Chip tone={question.status === 'answered' ? 'green' : question.status === 'open' ? 'amber' : 'slate'}>{QUESTION_STATUS[question.status] ?? question.status}</Chip>
      </div>
      <p className="whitespace-pre-wrap text-sm wrap-anywhere">{question.question}</p>
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {question.options.map((o) => (
            <Chip key={o}>{o}</Chip>
          ))}
        </div>
      )}
      {question.answer && (
        <Section title={`Ваш ответ, ${stamp(question.answeredAt)}`}>
          <p className="whitespace-pre-wrap text-sm wrap-anywhere">{question.answer}</p>
        </Section>
      )}
    </div>
  );
}

/**
 * Подробности события ленты: у вызова агента - дифф правки, команда с выводом или вход и ответ инструмента, у
 * подтверждения - все, что было на нем показано, и ваше решение, у вопроса - варианты и ответ, у остальных - данные
 * события. Все это хранится с прогоном, поэтому открывается в любой момент, в том числе после перезапуска.
 */
export function EventDetails({ runId, event }: { runId: string; event: EventDto }) {
  const enabled = hasDetails(event);
  const q = useQuery({ queryKey: ['event', runId, event.id], queryFn: () => api.eventDetails(runId, event.id), enabled });
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-baseline gap-2 text-xs text-slate-500">
          <span className="tabular-nums">{stamp(event.ts)}</span>
          {event.stepId && <span className="font-mono">{event.stepId}</span>}
          <span className="font-mono">{event.type}</span>
        </div>
        {/* Ошибку шага пишет агент в markdown: жирный, списки и код в ней видны как есть. Остальные тексты - обычные. */}
        {event.type === 'step.status' && (event.data as { status?: unknown } | null)?.status === 'failed' ? (
          <Markdown text={event.message ?? ''} className="mt-1 text-sm text-slate-800 dark:text-slate-100" />
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-sm wrap-anywhere text-slate-800 dark:text-slate-100">{event.message}</p>
        )}
      </div>
      {!enabled ? (
        <p className="text-sm text-slate-500">Подробностей нет: все, что есть у события, в тексте выше</p>
      ) : q.isPending ? (
        <Loading text="Открываю подробности" />
      ) : q.isError ? (
        <ErrorBox error={q.error} title="Не удалось открыть подробности" />
      ) : q.data.kind === 'tool' ? (
        <ToolCall call={q.data.call} />
      ) : q.data.kind === 'approval' ? (
        <Approval runId={runId} approval={q.data.approval} />
      ) : q.data.kind === 'question' ? (
        <Question question={q.data.question} />
      ) : q.data.kind === 'data' ? (
        <Section title="Данные события">
          <Pre text={JSON.stringify(q.data.data, null, 2)} />
        </Section>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-slate-500">
          <CircleAlert className="size-4" aria-hidden />
          {q.data.reason}
        </p>
      )}
    </div>
  );
}
