import { Ban, Check, Hand, PenLine, ShieldAlert, SlidersHorizontal, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { settingValueText, type LintIssue, type ParamValue, type StepSetting } from '@task-pilot/step-kit';
import type { ApprovalDto } from '@task-pilot/api-types';
import { composeAnswers } from '../answers.ts';
import { SOURCE_HINT } from '../settings.ts';
import { Button, Chip, cx } from '../ui.tsx';
import { useArtifactUrls } from './JiraMarkup.tsx';
import { Markdown, PreviewTextBody } from './Markdown.tsx';
import { StepSettingsForm } from './StepSettings.tsx';

const LINT_LOOK = {
  block: { title: 'Публикация заблокирована', icon: Ban, box: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200' },
  warn: { title: 'Стоит поправить', icon: TriangleAlert, box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200' },
  fixed: { title: 'Исправлено автоматически', icon: Sparkles, box: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' },
} as const;

function LintBlock({ issues, severity }: { issues: LintIssue[]; severity: keyof typeof LINT_LOOK }) {
  const list = issues.filter((i) => i.severity === severity);
  if (!list.length) return null;
  const look = LINT_LOOK[severity];
  const Icon = look.icon;
  return (
    <div data-lint={severity} className={cx('mt-3 rounded-lg border p-3 text-sm', look.box)}>
      <div className="flex items-center gap-1.5 font-medium">
        <Icon className="size-4" aria-hidden />
        {look.title}
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {list.map((i, n) => (
          <li key={n}>
            {i.message}
            {i.sample && <span className="ml-1 font-mono text-xs opacity-80">({i.sample})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Диалог подтверждения шага: что будет сделано, тексты для публикации с замечаниями линтера,
 * подтвердить, переделать с замечанием или отклонить. Сводка агента, тексты в markdown (план, описание
 * PR, страница вики) и комментарий Jira показываются отрисованными, у текстов есть переключатель на исходник,
 * а миниатюры комментария берутся из файлов артефактов прогона. У открытых
 * вопросов шага (вопросы плана) по полю ответа: "Переделать" отдает ответы агенту списком с номерами
 * вопросов вместе с замечанием. Настройки шага (куда перевести задачу по доске) видны под планом и меняются
 * здесь же: подтверждение сгорает, и шаг сразу спрашивает его заново, уже с новыми настройками.
 */
export function GateDialog({
  runId,
  approval,
  stepTitle,
  canRework,
  running,
  busy,
  comment,
  onComment,
  answers,
  onAnswers,
  settings,
  onSettings,
  onApprove,
  onReject,
  onRework,
  onClose,
}: {
  runId: string;
  approval: ApprovalDto;
  stepTitle: string;
  canRework: boolean;
  /** Прогон выполняется: отказ сейчас потерялся бы, поэтому он недоступен до паузы. */
  running: boolean;
  busy: boolean;
  /** Замечание живет у страницы: закрытие окна по Escape или клику мимо его не стирает. */
  comment: string;
  onComment: (comment: string) => void;
  /** Ответы на открытые вопросы шага по их порядку; живут у страницы, как замечание. */
  answers: string[];
  onAnswers: (answers: string[]) => void;
  /** Настройки шага с выбранными значениями; пусто - настроек у шага нет. */
  settings: StepSetting[];
  onSettings: (patch: Record<string, ParamValue | null>) => void;
  onApprove: () => void;
  onReject: (comment: string) => void;
  onRework: (comment: string) => void;
  onClose: () => void;
}) {
  const approveRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (approval.blocked) commentRef.current?.focus();
    else approveRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Tab ходит только по элементам окна: остальная страница под подложкой недоступна.
      if (e.key === 'Tab' && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, a[href], input:not([disabled]), select:not([disabled])')];
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (!dialogRef.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, approval.blocked]);
  const { preview } = approval;
  const fileUrl = useArtifactUrls(runId, preview.texts?.some((t) => t.format === 'jira') ?? false);
  const lint = preview.lint ?? [];
  // Вопросы с ответами бывают только у шага, который умеет переделывать черновик: ответы уходят агенту через "Переделать".
  const questions = canRework ? (preview.questions ?? []) : [];
  const note = composeAnswers(answers, comment);
  const answered = answers.some((a) => a.trim());
  const [editing, setEditing] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <Hand className="size-4" aria-hidden />
          Нужно ваше подтверждение: шаг "{stepTitle}"
        </div>
        <h2 id="gate-title" className="mt-2 text-lg font-semibold">
          {preview.title}
        </h2>
        {/* Сводка - сообщение агента владельцу: читается обычным текстом, а не серой подписью. */}
        {preview.summary && <Markdown text={preview.summary} className="mt-2 text-sm text-slate-800 dark:text-slate-100" />}

        <div className="mt-4 rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-300">Что будет сделано</div>
          {preview.actions.length ? (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-800 dark:text-slate-100">
              {preview.actions.map((a) => (
                <li key={a} className="wrap-anywhere">
                  {a}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Действий нет</p>
          )}
        </div>

        {settings.length > 0 && (
          <div className="mt-3 text-sm" data-gate-settings>
            {editing ? (
              <StepSettingsForm settings={settings} status="waiting_owner" busy={busy} onCancel={() => setEditing(false)} onSave={onSettings} />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-slate-600 dark:text-slate-300">Настройки шага:</span>
                {settings.map((s) => (
                  <span key={s.key} className="text-slate-800 dark:text-slate-100">
                    {s.label.toLowerCase()} - <span className="font-medium">{settingValueText(s)}</span>
                    {s.source !== 'manifest' && <span className="text-xs text-slate-500"> ({SOURCE_HINT[s.source].toLowerCase()})</span>}
                  </span>
                ))}
                <Button variant="ghost" size="sm" icon={SlidersHorizontal} disabled={busy} onClick={() => setEditing(true)} title="Изменить настройки шага: подтверждение сгорит, и шаг спросит его заново уже с новыми">
                  Изменить
                </Button>
              </div>
            )}
          </div>
        )}

        {preview.warnings?.length ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <div className="flex items-center gap-1.5 font-medium">
              <ShieldAlert className="size-4" aria-hidden />
              Обратите внимание
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {preview.warnings.map((w) => (
                <li key={w} className="wrap-anywhere">
                  {w}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {preview.texts?.map((t) => (
          <section key={t.id} className="mt-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              {t.label}
              {t.publish ? <Chip tone="blue">будет опубликовано</Chip> : <Chip>на утверждение</Chip>}
            </div>
            <PreviewTextBody text={t.text} format={t.format} fileUrl={fileUrl} className="mt-1" boxClassName="max-h-[28rem]" />
          </section>
        ))}

        {preview.notes?.map((n) => (
          <section key={n.id} className="mt-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              {n.label}
              <Chip>справка</Chip>
            </div>
            <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap wrap-anywhere rounded-lg bg-slate-50 p-3 font-sans text-sm leading-relaxed text-slate-800 dark:bg-slate-800 dark:text-slate-100">{n.text}</pre>
          </section>
        ))}

        <LintBlock issues={lint} severity="block" />
        <LintBlock issues={lint} severity="warn" />
        <LintBlock issues={lint} severity="fixed" />

        <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">Подтверждение одноразовое: если до выполнения что-то изменится, инструмент спросит заново.</p>
        {questions.length > 0 && (
          <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/30">
            <div className="text-sm font-medium">Открытые вопросы: {questions.length}</div>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Ответьте на то, что знаете: кнопка "Переделать" отдаст ответы агенту списком с номерами вопросов вместе с замечанием ниже, пустые пропускаются
            </p>
            <ol className="mt-2 space-y-3">
              {questions.map((q, i) => (
                <li key={i}>
                  <div className="flex gap-2 text-sm">
                    <span className="font-medium tabular-nums">{i + 1}.</span>
                    <Markdown text={q} className="min-w-0 flex-1 text-slate-800 dark:text-slate-100" />
                  </div>
                  <textarea
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                    rows={2}
                    placeholder="Ответ"
                    aria-label={`Ответ на вопрос ${i + 1}`}
                    value={answers[i] ?? ''}
                    onChange={(e) => {
                      const next = questions.map((_, j) => answers[j] ?? '');
                      next[i] = e.target.value;
                      onAnswers(next);
                    }}
                  />
                </li>
              ))}
            </ol>
          </section>
        )}
        <label className="mt-4 block text-sm">
          <span className="text-slate-600 dark:text-slate-300">
            {canRework ? (questions.length ? 'Еще замечание: что переделать или почему отклоняете' : 'Замечание: что переделать или почему отклоняете') : 'Комментарий, если отклоняете'}
          </span>
          <textarea
            ref={commentRef}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            rows={3}
            value={comment}
            onChange={(e) => onComment(e.target.value)}
          />
        </label>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} title="Закрыть окно: подтверждение подождет, открыть его снова можно главной кнопкой прогона">
            Позже
          </Button>
          <Button variant="danger" icon={X} disabled={busy || running} onClick={() => onReject(comment.trim())} title={running ? 'Прогон выполняется: отклонить можно, когда он встанет на паузу' : 'Отклонить: шаг не выполнится, и прогон встанет, пока шаг не повторят или не пропустят'}>
            Отклонить
          </Button>
          {canRework && (
            <Button variant="secondary" icon={PenLine} disabled={busy || !note} onClick={() => onRework(note)} title={note ? 'Агент переделает по замечанию и спросит снова' : 'Напишите замечание: что переделать'}>
              Переделать
            </Button>
          )}
          <Button
            ref={approveRef}
            icon={Check}
            disabled={busy || approval.blocked}
            onClick={onApprove}
            title={
              approval.blocked
                ? 'Линтер нашел запрещенное содержимое: исправьте через Переделать'
                : answered
                  ? 'Выполнить шаг как показано. Ответы на вопросы агенту не уйдут: чтобы он их учел, нажмите Переделать'
                  : 'Выполнить шаг ровно так, как показано. Подтверждение одноразовое: если до выполнения что-то изменится, окно спросит снова'
            }
          >
            Подтвердить
          </Button>
        </div>
      </div>
    </div>
  );
}
