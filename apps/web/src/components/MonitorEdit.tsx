import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, History, MessageSquare, RotateCcw, Send, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { MonitorEditsDto } from '@task-pilot/api-types';
import { api, type EditPreviewDto } from '../api.ts';
import { diffStat, diffView, lineDiff } from '../diff.ts';
import { Button, Chip, cx, Drawer, ErrorBox, Tip } from '../ui.tsx';

/** Правка мониторинга одной цели: панель с чатом, черновик агента, превью на экране и версии. */
export interface MonitorEdit {
  target: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  data: MonitorEditsDto | undefined;
  /** Превью черновика на экране; null - экран показывает сохраненный файл. */
  preview: EditPreviewDto | null;
  showPreview: () => void;
  hidePreview: () => void;
  apply: () => void;
  applying: boolean;
  error: unknown;
}

/**
 * Правка цели мониторинга (dashboard:<id>, feature:<id>, attempt) по запросу: состояние панели, опрос черновика, пока
 * агент работает, превью на экране с параметрами экрана (период дашборда, окно фичи) и применение.
 */
export function useMonitorEdit(target: string, previewQuery: { period?: string; from?: string; to?: string } = {}): MonitorEdit {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const q = useQuery({
    queryKey: ['monitor', 'edits', target],
    queryFn: () => api.monitorEdits(target),
    refetchInterval: (query) => (query.state.data?.edit?.status === 'working' ? 2000 : false),
  });
  const edit = q.data?.edit;
  const ready = edit?.status === 'ready';
  const preview = useQuery({
    queryKey: ['monitor', 'edit-preview', edit?.id, edit?.updatedAt, previewQuery.period, previewQuery.from, previewQuery.to],
    queryFn: () => api.monitorEditPreview(edit!.id, previewQuery),
    enabled: previewOn && ready,
  });
  const apply = useMutation({
    mutationFn: () => api.monitorEditApply(edit!.id),
    onSuccess: (d) => {
      qc.setQueryData(['monitor', 'edits', target], d);
      setPreviewOn(false);
      // Сохраненный файл перечитывают и экраны мониторинга: дашборд, фича, обзор.
      void qc.invalidateQueries({ queryKey: ['monitor'] });
    },
  });
  return {
    target,
    open,
    setOpen,
    data: q.data,
    preview: previewOn && ready ? (preview.data ?? null) : null,
    showPreview: () => {
      setPreviewOn(true);
      setOpen(false);
    },
    hidePreview: () => setPreviewOn(false),
    apply: () => apply.mutate(),
    applying: apply.isPending,
    error: apply.error ?? preview.error ?? q.error,
  };
}

/** Кнопка "Изменить по запросу": открывает панель правки; точка - у цели есть незакрытая правка. */
export function EditButton({ edit }: { edit: MonitorEdit }) {
  const status = edit.data?.edit?.status;
  return (
    <span className="relative">
      <Button data-edit variant="secondary" size="sm" icon={MessageSquare} onClick={() => edit.setOpen(true)} title="Попросить агента поменять этот экран: добавить, убрать или поправить графики, таблицы и правила. Изменения видны до записи, прошлые версии возвращаются">
        Изменить по запросу
      </Button>
      {status && status !== 'applied' && status !== 'discarded' && <span className={cx('absolute -top-1 -right-1 size-2.5 rounded-full', status === 'working' ? 'animate-pulse bg-blue-500' : status === 'ready' ? 'bg-emerald-500' : 'bg-amber-500')} aria-hidden />}
    </span>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  const stat = diffStat(lines);
  return (
    <details className="rounded-lg border border-slate-200 dark:border-slate-700">
      <summary className="cursor-pointer px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300">
        Что меняется в файле: <span className="text-emerald-700 dark:text-emerald-300">+{stat.added}</span> <span className="text-red-700 dark:text-red-300">-{stat.removed}</span>
      </summary>
      <pre className="max-h-80 overflow-auto border-t border-slate-200 font-mono text-[11px] leading-5 dark:border-slate-700">
        {diffView(lines).map((l, i) =>
          l.kind === 'skip' ? (
            <div key={i} className="bg-slate-50 px-2 text-slate-400 dark:bg-slate-800">
              ... без изменений строк: {l.count}
            </div>
          ) : (
            <div
              key={i}
              className={cx(
                'px-2 whitespace-pre-wrap',
                l.kind === 'add' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
                l.kind === 'del' && 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200',
              )}
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ),
        )}
      </pre>
    </details>
  );
}

const STATUS: Record<string, { label: string; tone: 'blue' | 'green' | 'amber' | 'red' }> = {
  working: { label: 'агент готовит правку', tone: 'blue' },
  ready: { label: 'черновик готов', tone: 'green' },
  invalid: { label: 'черновик не прошел проверку', tone: 'amber' },
  failed: { label: 'агент не справился', tone: 'red' },
};

/** Панель правки: разговор с агентом, черновик с диффом, превью, применение, отказ и прошлые версии. */
export function EditDrawer({ edit, previewable = true }: { edit: MonitorEdit; previewable?: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const set = (d: MonitorEditsDto) => qc.setQueryData(['monitor', 'edits', edit.target], d);
  const send = useMutation({
    mutationFn: (message: string) => api.monitorEditRequest(edit.target, message),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['monitor', 'edits', edit.target] });
    },
  });
  const discard = useMutation({ mutationFn: (id: string) => api.monitorEditDiscard(id), onSuccess: set });
  const revert = useMutation({
    mutationFn: (id: string) => api.monitorVersionRevert(id),
    onSuccess: (d) => {
      set(d);
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['monitor'] });
    },
  });
  const d = edit.data;
  const e = d?.edit ?? null;
  const working = e?.status === 'working';
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (text.trim() && !working) send.mutate(text.trim());
  };
  return (
    <Drawer
      label="Изменить по запросу"
      onClose={() => edit.setOpen(false)}
      header={
        <div>
          <div className="font-semibold">Изменить по запросу</div>
          <div className="truncate text-xs text-slate-500" title={d?.file}>
            {d ? `${d.label}, ${d.file}` : 'загружаю'}
          </div>
        </div>
      }
    >
      <p className="text-xs text-slate-500">Агент меняет только этот файл и не видит строк логов. Изменение видно до записи, файл пишется кнопкой "Применить", прошлый текст остается версией.</p>
      {e && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Chip tone={STATUS[e.status]?.tone ?? 'slate'}>{STATUS[e.status]?.label ?? e.status}</Chip>
            {e.costUsd > 0 && <span className="text-xs text-slate-400 tabular-nums">${e.costUsd.toFixed(2)}</span>}
          </div>
          <ul className="space-y-2">
            {e.messages.map((m, i) => (
              <li key={i} className={cx('rounded-lg px-3 py-2 text-sm whitespace-pre-wrap', m.role === 'owner' ? 'ml-6 bg-blue-50 dark:bg-blue-950' : 'mr-6 bg-slate-100 dark:bg-slate-800')}>
                {m.text}
              </li>
            ))}
            {working && <li className="mr-6 animate-pulse rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-500 dark:bg-slate-800">агент читает формат и примеры и готовит черновик</li>}
          </ul>
          {e.errors.length > 0 && (
            <ul className="list-disc space-y-0.5 rounded-lg bg-amber-50 py-2 pr-2 pl-6 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {e.errors.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          {e.draft && <Diff before={e.base} after={e.draft} />}
          <div className="flex flex-wrap gap-2">
            {e.status === 'ready' && (
              <Button icon={Check} spin={edit.applying} disabled={edit.applying} onClick={edit.apply}>
                Применить
              </Button>
            )}
            {e.status === 'ready' && previewable && (
              <Button variant="secondary" icon={Eye} onClick={edit.showPreview} title="Показать экран по черновику, ничего не записывая">
                Показать на экране
              </Button>
            )}
            <Button variant="ghost" icon={X} disabled={discard.isPending} onClick={() => discard.mutate(e.id)}>
              Отказаться
            </Button>
          </div>
        </div>
      )}
      {(edit.error || send.error || discard.error) && <ErrorBox error={edit.error ?? send.error ?? discard.error} title="Не получилось" />}
      <form onSubmit={submit} className="space-y-2">
        <textarea
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) submit(ev);
          }}
          rows={3}
          placeholder={e ? 'Что поправить в черновике?' : 'Что поменять? Например: добавь график ошибок по часам, убери таблицу строк'}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          aria-label="Просьба агенту"
          disabled={working}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-400">телефоны в просьбе уходят агенту маской</span>
          <Button type="submit" icon={Send} spin={send.isPending} disabled={!text.trim() || working || send.isPending}>
            {e ? 'Дописать' : 'Отправить'}
          </Button>
        </div>
      </form>
      {d && d.versions.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <History className="size-4" aria-hidden />
            Прошлые версии
          </h3>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {d.versions.map((v) => (
              <li key={v.id} className="flex items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="text-xs tabular-nums text-slate-500">{new Date(v.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                  <div className="truncate" title={v.note ?? ''}>
                    {v.note ?? 'без описания'}
                  </div>
                </div>
                {confirm === v.id ? (
                  <span className="flex items-center gap-1">
                    <Button size="sm" spin={revert.isPending} disabled={revert.isPending} onClick={() => revert.mutate(v.id)}>
                      Вернуть
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                      Нет
                    </Button>
                  </span>
                ) : (
                  <Tip text="Вернуть этот текст файла: текущий станет версией">
                    <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setConfirm(v.id)} aria-label="Вернуть версию" />
                  </Tip>
                )}
              </li>
            ))}
          </ul>
          {revert.error && <ErrorBox error={revert.error} title="Версия не вернулась" />}
        </section>
      )}
    </Drawer>
  );
}

/** Плашка превью на экране: экран показан по черновику, его можно применить или вернуться к сохраненному. */
export function PreviewBanner({ edit }: { edit: MonitorEdit }) {
  if (!edit.preview) return null;
  return (
    <div role="status" className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-950 shadow-sm dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
      <Eye className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        Превью правки, файл не записан: <span className="font-medium">{edit.data?.edit?.summary}</span>
      </span>
      <Button size="sm" icon={Check} spin={edit.applying} disabled={edit.applying} onClick={edit.apply}>
        Применить
      </Button>
      <Button size="sm" variant="secondary" icon={MessageSquare} onClick={() => edit.setOpen(true)}>
        К разговору
      </Button>
      <Button size="sm" variant="ghost" icon={X} onClick={edit.hidePreview}>
        Скрыть превью
      </Button>
    </div>
  );
}
