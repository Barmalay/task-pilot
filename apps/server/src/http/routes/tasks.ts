import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { boardStatuses, type RunStatus } from '@task-pilot/step-kit';
import type { SprintDto, StandDto, TasksDto, TransitionDto } from '@task-pilot/api-types';
import { EngineError } from '../../engine/engine.ts';
import { standsOf } from '../../stands.ts';
import type { RunRow } from '../../store/db.ts';
import { buildTasksJql, type TasksScope } from '../../tasks.ts';
import type { ServerDeps } from '../support.ts';

const openBody = z.strictObject({ presetId: z.string().optional(), dryRun: z.boolean().optional() });
const tasksQuery = z.object({
  scope: z.enum(['mine', 'sprint']).default('mine'),
  sprint: z.coerce.number().int().positive().optional(),
  mine: z.enum(['0', '1']).default('1'),
  hideDone: z.enum(['0', '1']).default('1'),
});
const transitionBody = z.strictObject({ transitionId: z.string().min(1).max(20) });
const standsQuery = z.object({ repo: z.string().optional() });

/** Прогон запускали, и он еще не выполнен: у такого прогона на карточке задачи видно, сколько сделано. */
const STARTED = new Set<RunStatus>(['running', 'waiting_owner', 'waiting', 'paused', 'failed']);

/** Задачи и доска: список задач с их прогонами, спринты, стенды, открытие задачи и переходы по доске. */
export function tasksRoutes(app: FastifyInstance, d: ServerDeps): void {
  app.get('/api/tasks', async (req): Promise<TasksDto> => {
    const q = tasksQuery.parse(req.query);
    const scope: TasksScope =
      q.scope === 'sprint' && q.sprint ? { kind: 'sprint', sprintId: q.sprint, mine: q.mine === '1', hideDone: q.hideDone === '1' } : { kind: 'mine' };
    const tasks = await d.ports.jira.search(buildTasksJql(scope, d.profiles.jira.myIssuesJql), 100);
    const runs = d.store.latestRunsByIssue(tasks.map((t) => t.key));
    // Сколько сделано - у прогонов, которые запускали и которые еще не выполнены: на карточке это полоса с процентом.
    const progress = (run: RunRow | undefined) => {
      if (!run || !STARTED.has(run.status)) return null;
      const f = d.forecast.of(run.id);
      return f ? { percent: f.percent, remainingMs: f.remainingMs } : null;
    };
    return {
      statuses: [...boardStatuses(d.profiles.jira), ...d.profiles.jira.offPath],
      tasks: tasks.map((t) => ({ ...t, runId: runs.get(t.key)?.id ?? null, runStatus: runs.get(t.key)?.status ?? null, progress: progress(runs.get(t.key)) })),
    };
  });

  // Что сейчас на стендах контура репозитория; без repo - репозиторий по умолчанию.
  app.get('/api/stands', async (req): Promise<StandDto[]> => {
    const { repo: repoId } = standsQuery.parse(req.query);
    const repo = repoId ? d.profiles.repos.find((r) => r.id === repoId) : (d.profiles.repos.find((r) => r.default) ?? d.profiles.repos[0]);
    if (!repo) throw new EngineError(`Нет профиля репозитория ${repoId}`, 404);
    return d.redact.deep(await standsOf(repo, d.profiles, d.ports));
  });

  app.get('/api/sprints', async (): Promise<SprintDto[]> => {
    const board = d.profiles.jira.board;
    if (!board) return [];
    const [active, future] = await Promise.all([d.ports.jira.sprints(board.id, 'active'), d.ports.jira.sprints(board.id, 'future')]);
    return [...active, ...future];
  });

  app.post<{ Params: { key: string } }>('/api/tasks/:key/open', async (req) => {
    const body = openBody.parse(req.body ?? {});
    return d.tasks.open(req.params.key, { reuse: true, ...body });
  });

  app.get<{ Params: { key: string } }>('/api/tasks/:key/transitions', async (req): Promise<TransitionDto[]> => d.tasks.transitions(req.params.key));

  app.post<{ Params: { key: string } }>('/api/tasks/:key/transition', async (req) => {
    const { transitionId } = transitionBody.parse(req.body ?? {});
    return d.tasks.transition(req.params.key, transitionId);
  });
}
