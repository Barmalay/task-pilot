import type { QueryKey } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FolderOpen, GripVertical, LoaderCircle, UserRound, UserRoundX } from 'lucide-react';
import { useState } from 'react';
import type { TaskDto, TasksDto, TransitionDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { boardColumns, dropTargets } from '../board.ts';
import { roughly } from '../progress.ts';
import { RUN_LOOK } from '../status.tsx';
import { Button, Chip, cx, ErrorBox, Tip } from '../ui.tsx';
import { IssueMeta } from './IssueMeta.tsx';

/** Переходы задачи кэшируются ненадолго: статус задачи могли сменить в самой Jira. */
const transitionsQuery = (key: string) => ({ queryKey: ['transitions', key], queryFn: () => api.transitions(key), staleTime: 30_000 });

/** Исполнитель задачи; своя задача выделена. */
function Assignee({ assignee, me }: { assignee: TaskDto['assignee']; me: string | null }) {
  if (!assignee) {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-xs text-slate-400">
        <UserRoundX className="size-3.5 shrink-0" aria-hidden />
        не назначена
      </p>
    );
  }
  const mine = assignee.name === me;
  return (
    <Tip text={`Исполнитель: ${assignee.displayName ? `${assignee.displayName} (${assignee.name})` : assignee.name}`} className="mt-1.5 max-w-full">
      <p className={cx('flex min-w-0 items-center gap-1 text-xs', mine ? 'font-medium text-blue-700 dark:text-blue-400' : 'text-slate-600 dark:text-slate-300')}>
        <UserRound className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{assignee.displayName ?? assignee.name}</span>
        {mine && <span className="shrink-0">(вы)</span>}
      </p>
    </Tip>
  );
}

function TaskCard({
  task,
  me,
  moving,
  opening,
  picked,
  onPick,
  onOpen,
  onGrab,
  onDragStart,
  onDragEnd,
}: {
  task: TaskDto;
  me: string | null;
  /** Куда задачу переводят сейчас; null - не переводят. */
  moving: string | null;
  opening: boolean;
  picked: Set<string>;
  onPick: (v: string, k: 'label' | 'component') => void;
  onOpen: () => void;
  onGrab: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <article
      data-task={task.key}
      draggable={moving === null}
      onPointerDown={onGrab}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.key);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cx(
        'rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900',
        moving === null ? 'cursor-grab active:cursor-grabbing' : 'opacity-60',
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1">
          <Tip text="Перетащите карточку в другую колонку, чтобы перевести задачу в этот статус в Jira">
            <GripVertical className="size-3.5 text-slate-300 dark:text-slate-600" aria-hidden />
          </Tip>
          <Tip text="Открыть задачу в Jira в новой вкладке">
            <a
              href={task.url}
              target="_blank"
              rel="noreferrer"
              draggable={false}
              className="inline-flex items-center gap-1 font-mono font-medium text-blue-700 hover:underline dark:text-blue-400"
            >
              {task.key}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </Tip>
        </div>
        {task.type && <span className="text-slate-500">{task.type}</span>}
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm leading-snug">{task.summary}</p>
      <Assignee assignee={task.assignee} me={me} />
      <div className="mt-2">
        <IssueMeta labels={task.labels} components={task.components} active={picked} onPick={onPick} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        {moving !== null ? (
          <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            перевожу в {moving}
          </span>
        ) : task.runStatus ? (
          <Tip text={RUN_LOOK[task.runStatus].hint}>
            <Chip tone={RUN_LOOK[task.runStatus].tone}>прогон: {RUN_LOOK[task.runStatus].label}</Chip>
          </Tip>
        ) : (
          <span className="text-xs text-slate-400">{task.updated?.slice(0, 16)}</span>
        )}
        <Button
          size="sm"
          variant={task.runId ? 'secondary' : 'primary'}
          icon={FolderOpen}
          disabled={opening}
          onClick={onOpen}
          title={task.runId ? 'Открыть прогон задачи: шаги, подтверждения и ленту' : 'Открыть задачу: загрузить из Jira описание и критерии приемки и выбрать шаги цикла. Ничего не запускается'}
        >
          Открыть
        </Button>
      </div>
      {task.progress && (
        <Tip text={`Сделано ${task.progress.percent}% по ожидаемому времени шагов, осталось примерно ${roughly(task.progress.remainingMs)}`} className="mt-2 flex w-full items-center gap-2">
          <div className="h-1.5 flex-1 rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-valuenow={task.progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Сделано в прогоне">
            <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${task.progress.percent}%` }} />
          </div>
          <span className="text-xs tabular-nums text-slate-500">{task.progress.percent}%</span>
        </Tip>
      )}
    </article>
  );
}

/**
 * Доска задач по статусам. Карточку можно перетащить в другую колонку, как в Jira: подсвечиваются статусы,
 * куда ведут доступные задаче сейчас переходы, и после броска задача переводится в Jira сразу, а карточка
 * переезжает, не дожидаясь ответа. Если перевод не удался, карточка возвращается и видна причина.
 */
export function TaskBoard({
  tasks,
  order,
  queryKey,
  me,
  picked,
  onPick,
  opening,
  onOpen,
}: {
  tasks: TaskDto[];
  /** Статусы доски по порядку. */
  order: string[];
  /** Ключ запроса списка задач: карточка переезжает в его данных сразу после броска. */
  queryKey: QueryKey;
  me: string | null;
  picked: Set<string>;
  onPick: (v: string, k: 'label' | 'component') => void;
  opening: boolean;
  onOpen: (task: TaskDto) => void;
}) {
  const qc = useQueryClient();
  const [drag, setDrag] = useState<{ key: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ key: string; to: string; options: TransitionDto[] } | null>(null);
  const transitions = useQuery({ ...transitionsQuery(drag?.key ?? ''), enabled: drag !== null });

  // Куда можно перевести задачу, которую тянут: статус и переходы в него.
  const targets = drag && transitions.data ? dropTargets(transitions.data, drag.from) : new Map<string, TransitionDto[]>();

  const move = useMutation({
    mutationFn: ({ key, transition }: { key: string; transition: TransitionDto }) => api.transition(key, transition.id),
    onMutate: async ({ key, transition }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<TasksDto>(queryKey);
      const to = transition.to;
      if (previous && to) qc.setQueryData<TasksDto>(queryKey, { ...previous, tasks: previous.tasks.map((t) => (t.key === key ? { ...t, status: to } : t)) });
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKey, ctx.previous);
    },
    onSettled: (_r, _e, { key }) => {
      void qc.invalidateQueries({ queryKey: ['transitions', key] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const drop = (status: string) => {
    const key = drag?.key;
    const options = targets.get(status);
    endDrag();
    if (!key || !options) return;
    if (options.length === 1) move.mutate({ key, transition: options[0]! });
    else setChoice({ key, to: status, options });
  };

  const columns = boardColumns(order, tasks.map((t) => t.status), [...targets.keys()]);
  const movingTo = (key: string) => (move.isPending && move.variables?.key === key ? (move.variables.transition.to ?? '') : null);
  const hint = !drag
    ? null
    : transitions.isLoading
      ? `Загружаю переходы ${drag.key}`
      : transitions.error
        ? `Не удалось загрузить переходы: ${transitions.error.message}`
        : targets.size
          ? 'Отпустите карточку в подсвеченной колонке: задача перейдет в этот статус в Jira'
          : `Задаче ${drag.key} сейчас некуда перейти`;

  return (
    <>
      {move.error && (
        <div className="mb-4">
          <ErrorBox error={move.error} title={`Не удалось перевести ${move.variables?.key ?? 'задачу'}`} />
        </div>
      )}
      <div className="flex gap-3 overflow-x-auto pb-3">
        {columns.map((status) => {
          const list = tasks.filter((t) => t.status === status);
          const allowed = targets.has(status);
          const dragging = drag !== null && status !== drag.from;
          return (
            <div
              key={status}
              data-column={status}
              onDragOver={(e) => {
                if (!allowed) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== status) setOver(status);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === status ? null : o));
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(status);
              }}
              className={cx(
                'w-72 shrink-0 rounded-xl p-1 transition',
                dragging && allowed && (over === status ? 'bg-blue-100 outline-2 outline-blue-500 dark:bg-blue-950' : 'bg-blue-50/60 outline-2 outline-dashed outline-blue-300 dark:bg-blue-950/40'),
                dragging && !allowed && 'opacity-40',
              )}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{status}</h2>
                <span className="text-xs text-slate-400">{list.length}</span>
              </div>
              <div className="space-y-2">
                {list.map((t) => (
                  <TaskCard
                    key={t.key}
                    task={t}
                    me={me}
                    moving={movingTo(t.key)}
                    opening={opening}
                    picked={picked}
                    onPick={onPick}
                    onOpen={() => onOpen(t)}
                    // Переходы грузятся уже при нажатии: пока карточку тянут, колонки успевают подсветиться.
                    onGrab={() => void qc.prefetchQuery(transitionsQuery(t.key))}
                    onDragStart={() => setDrag({ key: t.key, from: t.status })}
                    onDragEnd={endDrag}
                  />
                ))}
                {!list.length && allowed && (
                  <div className="grid h-24 place-items-center rounded-lg border-2 border-dashed border-blue-300 text-xs text-blue-600 dark:border-blue-800 dark:text-blue-400">
                    Отпустите здесь
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {hint && <p className="pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">{hint}</p>}
      {choice && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/30 p-4" role="dialog" aria-modal="true" aria-label="Выбор перехода">
          <div className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl dark:bg-slate-900">
            <p className="text-sm font-medium">
              В статус {choice.to} ведут несколько переходов. Каким перевести {choice.key}?
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {choice.options.map((t) => (
                <Button
                  key={t.id}
                  variant="secondary"
                  onClick={() => {
                    move.mutate({ key: choice.key, transition: t });
                    setChoice(null);
                  }}
                >
                  {t.name}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => setChoice(null)}>
                Отмена
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
