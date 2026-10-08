import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TaskDto } from '@task-pilot/api-types';
import { api, type TasksFilter } from '../api.ts';
import { matchesRun, RUN_FILTERS, type RunFilter } from '../board.ts';
import { TaskBoard } from '../components/TaskBoard.tsx';
import { go } from '../router.ts';
import { Button, Card, Chip, cx, ErrorBox, Loading, PageHeader, Tip } from '../ui.tsx';

const FILTER_KEY = 'task-pilot.tasks-filter';
const RUN_FILTER_KEY = 'task-pilot.tasks-run';

function loadRunFilter(): RunFilter {
  try {
    const saved = localStorage.getItem(RUN_FILTER_KEY);
    return RUN_FILTERS.find((f) => f.id === saved)?.id ?? 'all';
  } catch {
    return 'all';
  }
}

function loadFilter(): TasksFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as TasksFilter | null;
    if (saved?.scope === 'sprint' && Number.isInteger(saved.sprint)) return saved;
  } catch {
    // Хранилище недоступно или повреждено: берем фильтр по умолчанию.
  }
  return { scope: 'mine' };
}

function saveFilter(f: TasksFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    // Не критично: фильтр просто не запомнится.
  }
}

/** Экран задач: мои незакрытые или задачи спринта, по статусам доски, с фильтром по меткам и компонентам. */
export function TasksPage() {
  const [filter, setFilter] = useState<TasksFilter>(loadFilter);
  const [runFilter, setRunFilter] = useState<RunFilter>(loadRunFilter);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => saveFilter(filter), [filter]);
  useEffect(() => {
    try {
      localStorage.setItem(RUN_FILTER_KEY, runFilter);
    } catch {
      // Не критично: фильтр просто не запомнится.
    }
  }, [runFilter]);

  const sprints = useQuery({ queryKey: ['sprints'], queryFn: api.sprints, staleTime: 5 * 60_000 });
  const tasksKey = ['tasks', filter];
  const tasks = useQuery({ queryKey: tasksKey, queryFn: () => api.tasks(filter) });
  // Кто "вы": владелец активного доступа к Jira, пока он неизвестен - логин, на который шаги назначают задачи.
  const account = useQuery({ queryKey: ['account'], queryFn: api.account, staleTime: 5 * 60_000 });
  const me = account.data ? (account.data.jira.active.check?.login ?? account.data.jira.me) : null;
  const open = useMutation({ mutationFn: (issueKey: string) => api.openTask(issueKey), onSuccess: (r) => go(`/runs/${r.id}`) });

  const togglePick = (value: string, kind: 'label' | 'component') => {
    const id = `${kind === 'component' ? 'c' : 'l'}:${value}`;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const matches = (t: TaskDto) => [...picked].every((p) => (p.startsWith('c:') ? t.components.includes(p.slice(2)) : t.labels.includes(p.slice(2))));

  const data = tasks.data;
  // Счетчики фильтра по прогону считаются по задачам, которые прошли фильтр по меткам и компонентам.
  const byLabels = data?.tasks.filter(matches) ?? [];
  const visible = byLabels.filter((t) => matchesRun(runFilter, t.runStatus));
  const sprintValue = filter.scope === 'sprint' ? String(filter.sprint) : 'mine';

  return (
    <section>
      <PageHeader
        className="mb-4"
        title="Задачи"
        help="Задачи из Jira по статусам доски: ваши незакрытые или задачи спринта. Откройте задачу, чтобы выбрать шаги цикла: открытие ничего не запускает. Карточку можно перетащить в другую колонку, как в Jira. Задачу, которой нет на доске, открывает поле с ключом в шапке, клавиша / ставит туда курсор"
      />

      <Card className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 text-sm">
        <Tip text="Какие задачи показывать: все мои незакрытые или задачи спринта доски">
          <label className="flex items-center gap-2">
            <span className="text-slate-500">Спринт:</span>
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              value={sprintValue}
              onChange={(e) => {
                const v = e.target.value;
                setFilter(v === 'mine' ? { scope: 'mine' } : { scope: 'sprint', sprint: Number(v), mine: filter.scope === 'sprint' ? filter.mine : true, hideDone: filter.scope === 'sprint' ? filter.hideDone : true });
              }}
            >
              <option value="mine">Все мои незакрытые</option>
              {sprints.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.state === 'active' ? ' (активный)' : ''}
                </option>
              ))}
            </select>
          </label>
        </Tip>
        {filter.scope === 'sprint' && (
          <>
            <Tip text="Показать только задачи спринта, назначенные на вас">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-blue-600" checked={filter.mine} onChange={(e) => setFilter({ ...filter, mine: e.target.checked })} />
                Только мои
              </label>
            </Tip>
            <Tip text="Не показывать задачи в завершенных статусах">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-blue-600" checked={filter.hideDone} onChange={(e) => setFilter({ ...filter, hideDone: e.target.checked })} />
                Скрыть закрытые
              </label>
            </Tip>
          </>
        )}
        <div className="flex items-center gap-2" role="group" aria-label="Фильтр по прогону">
          <span className="text-slate-500">Прогон:</span>
          <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
            {RUN_FILTERS.map((f) => {
              const count = f.id === 'all' ? byLabels.length : byLabels.filter((t) => matchesRun(f.id, t.runStatus)).length;
              return (
                <Tip key={f.id} text={f.hint}>
                  <button
                    type="button"
                    aria-pressed={runFilter === f.id}
                    onClick={() => setRunFilter(f.id)}
                    className={cx(
                      'rounded-md px-2.5 py-1 text-xs font-medium tabular-nums transition-colors',
                      runFilter === f.id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                    )}
                  >
                    {f.label}
                    {data && f.id !== 'all' ? ` ${count}` : ''}
                  </button>
                </Tip>
              );
            })}
          </div>
        </div>
        {picked.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-500">Фильтр:</span>
            {[...picked].map((p) => (
              <Chip key={p} tone={p.startsWith('c:') ? 'blue' : 'slate'}>
                {p.slice(2)}
              </Chip>
            ))}
            <Button variant="ghost" size="sm" icon={X} onClick={() => setPicked(new Set())} title="Убрать фильтр по меткам и компонентам">
              Сбросить
            </Button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {data && <span className="text-xs text-slate-500">Задач: {visible.length}{visible.length !== data.tasks.length ? ` из ${data.tasks.length}` : ''}</span>}
          <Button variant="ghost" icon={RefreshCw} spin={tasks.isFetching} onClick={() => void tasks.refetch()} title="Перечитать задачи из Jira">
            Обновить
          </Button>
        </div>
      </Card>

      {open.error && (
        <div className="mb-4">
          <ErrorBox error={open.error} title="Не удалось открыть задачу" />
        </div>
      )}
      {tasks.isLoading && <Loading text="Загружаю задачи из Jira. Первый запрос поднимает MCP-сервер и может занять до полуминуты" />}
      {tasks.error && <ErrorBox error={tasks.error} title="Не удалось загрузить задачи" />}
      {data && !visible.length && <Card className="p-6 text-sm text-slate-500">Задач под фильтр нет</Card>}
      {data && visible.length > 0 && (
        <TaskBoard
          tasks={visible}
          order={data.statuses}
          queryKey={tasksKey}
          me={me}
          picked={picked}
          onPick={togglePick}
          opening={open.isPending}
          onOpen={(t) => (t.runId ? go(`/runs/${t.runId}`) : open.mutate(t.key))}
        />
      )}
    </section>
  );
}
