import { useQuery } from '@tanstack/react-query';
import type { RunDto } from '@task-pilot/api-types';
import { api } from '../api.ts';
import { go } from '../router.ts';
import { RUN_LOOK } from '../status.tsx';
import { Tip } from '../ui.tsx';

/**
 * Переключатель прогонов задачи: номер по порядку, репозиторий, время и состояние; выбор открывает прогон. Прогоны
 * задачи в других репозиториях - связанные: тест на стенде ждет их деплоя, а к вехе мержа задача идет после мержа всех PR.
 */
export function RunSwitcher({ issueKey, current, repoTitle }: { issueKey: string; current: RunDto; repoTitle: (id: string) => string }) {
  const runs = useQuery({ queryKey: ['runs', issueKey], queryFn: () => api.runsOf(issueKey) });
  const list = runs.data ?? [];
  if (list.length < 2) return null;
  const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <Tip text="Прогоны этой задачи: у каждого свои шаги, подтверждения и лента. Прогоны в других репозиториях связаны с этим: тест на стенде ждет их деплоя, а задача идет к вехе мержа на доске после мержа всех PR. Выберите, чтобы открыть">
      <label className="flex items-center gap-2">
        <span className="text-slate-500">Прогон:</span>
        <select
          aria-label="Прогон задачи"
          className="rounded-md border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          value={current.id}
          onChange={(e) => go(`/runs/${e.target.value}`)}
        >
          {list.map((r, i) => {
            // Состояние открытого прогона берется из его живого вида: список обновляется реже.
            const status = r.id === current.id ? current.status : r.status;
            return (
              <option key={r.id} value={r.id}>
                {list.length - i} из {list.length}, {repoTitle(r.repoId)}, {when(r.createdAt)}, {RUN_LOOK[status].label}
                {r.dryRun ? ', пробный' : ''}
              </option>
            );
          })}
        </select>
      </label>
    </Tip>
  );
}
