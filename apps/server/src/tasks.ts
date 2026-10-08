import {
  boardStatuses,
  acceptanceCriteriaOf,
  ISSUE_KEY,
  normalizeName,
  pickRepo,
  TASK_INPUTS,
  type Issue,
  type JiraConfig,
  type Ports,
  type RepoChoice,
  type Transition,
  whyNoRepo,
} from '@task-pilot/step-kit';
import type { Profiles } from './config.ts';
import { EngineError, type Engine } from './engine/engine.ts';
import type { EventBus } from './engine/events.ts';
import type { TransitionDto } from '@task-pilot/api-types';
import type { Redactor } from './lib/redact.ts';
import type { Store } from './store/db.ts';

/** Префикс ключей прогонов мастера "Новый шаг": задачи Jira у них нет. */
export const PILOT_PREFIX = 'PILOT-';

/** Какие задачи показывать на экране "Задачи". */
export type TasksScope = { kind: 'mine' } | { kind: 'sprint'; sprintId: number; mine: boolean; hideDone: boolean };

/** JQL для экрана задач: без спринта - фильтр из профиля, со спринтом - задачи спринта. */
export function buildTasksJql(scope: TasksScope, myIssuesJql: string): string {
  if (scope.kind === 'mine') return myIssuesJql;
  if (!Number.isInteger(scope.sprintId) || scope.sprintId <= 0) throw new EngineError('Некорректный спринт');
  const parts = [`sprint = ${scope.sprintId}`];
  if (scope.mine) parts.push('assignee = currentUser()');
  if (scope.hideDone) parts.push('statusCategory != Done');
  return `${parts.join(' AND ')} ORDER BY updated DESC`;
}

/** Ключ задачи в верхнем регистре; некорректный ключ отклоняется. */
export function issueKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) throw new EngineError(`Некорректный ключ задачи: ${raw}`);
  return key;
}

/**
 * Статус, в который ведет переход. REST Jira сообщает его сам. Если переход пришел из mcp-atlassian без
 * статуса, статус берется из пути доски в профиле доски (jira.yaml) по id перехода, а для переходов вне пути - из
 * названия, когда оно совпадает с одним из статусов доски (Closed, Monitoring). Иначе null: такую задачу
 * этим переходом на доске не перетащить.
 */
export function transitionTarget(t: Transition, jira: JiraConfig): string | null {
  if (t.to) return t.to;
  const onPath = jira.path.find((p) => p.id === t.id);
  if (onPath) return onPath.to;
  return [...boardStatuses(jira), ...jira.offPath].find((s) => normalizeName(s) === normalizeName(t.name)) ?? null;
}

/** Зависимости сервиса задач. */
export interface TaskServiceDeps {
  engine: Engine;
  store: Store;
  bus: EventBus;
  ports: Ports;
  profiles: Profiles;
  redact: Redactor;
}

/**
 * Открытие задачи: загружает ее из Jira, подбирает репозиторий по меткам и компонентам и заводит
 * прогон, ничего не запуская. Данные задачи (описание, AC, метки, компоненты, спринт) ложатся в
 * контекст прогона и доступны шагам.
 */
export class TaskService {
  private readonly d: TaskServiceDeps;

  constructor(deps: TaskServiceDeps) {
    this.d = deps;
  }

  /** Открывает задачу: последний прогон, если он есть и reuse включен, иначе новый. */
  async open(
    rawKey: string,
    options: { reuse: boolean; presetId?: string; repoId?: string; standId?: string | null; dryRun?: boolean },
  ): Promise<{ id: string; created: boolean }> {
    const key = issueKey(rawKey);
    if (options.reuse) {
      const latest = this.d.store.latestRunsByIssue([key]).get(key);
      if (latest) {
        // Каталог мог измениться с открытия прогона: пока в нем ничего не выполнено, шаги подстраиваются.
        this.d.engine.syncSteps(latest.id);
        return { id: latest.id, created: false };
      }
    }
    const issue = await this.d.ports.jira.getIssue(key);
    const choice = options.repoId ? null : pickRepo(issue, this.d.profiles.repos, this.d.profiles.contours);
    const run = this.d.engine.createRun({
      issueKey: key,
      presetId: options.presetId,
      repoId: options.repoId ?? choice?.repoId,
      standId: options.standId,
      dryRun: options.dryRun,
    });
    // Задача репозиторий не подсказала: стоит репозиторий по умолчанию, и запуск ждет, пока владелец выберет свой.
    const unsure: RepoChoice | null =
      !options.repoId && !choice ? { repoId: run.repoId, reason: `не определен по задаче: ${whyNoRepo(issue, this.d.profiles.repos)}`, candidates: [], unsure: true } : null;
    this.save(run.id, issue, choice ?? unsure);
    return { id: run.id, created: true };
  }

  /**
   * Мастер "Новый шаг": отдельный прогон с ключом PILOT-<n> и пресетом new-step, описание шага ложится в контекст,
   * и прогон сразу запускается. Задачи Jira у такого прогона нет: шаг пишет файлы самого Task Pilot.
   */
  draftStep(description: string): { id: string } {
    const text = description.trim();
    if (!text) throw new EngineError('Опишите шаг: что он делает и когда');
    const n = Math.max(0, ...this.d.store.issueKeys(PILOT_PREFIX).map((k) => Number(k.slice(PILOT_PREFIX.length)) || 0)) + 1;
    const run = this.d.engine.createRun({ issueKey: `${PILOT_PREFIX}${n}`, presetId: 'new-step', standId: null });
    this.d.store.setContext(run.id, 'stepRequest', { description: this.d.redact.text(text) }, null);
    void this.d.engine.start(run.id);
    return { id: run.id };
  }

  /** Переходы, доступные задаче сейчас, с целевыми статусами: куда карточку можно перетащить на доске. */
  async transitions(rawKey: string): Promise<TransitionDto[]> {
    const key = issueKey(rawKey);
    return (await this.d.ports.jira.getTransitions(key)).map((t) => ({ id: t.id, name: t.name, to: transitionTarget(t, this.d.profiles.jira) }));
  }

  /**
   * Переводит задачу переходом, который владелец выбрал, перетащив карточку на доске. Переход сверяется
   * с доступными сейчас: пока карточку тянули, задачу могли перевести в другой статус.
   */
  async transition(rawKey: string, transitionId: string): Promise<{ to: string | null }> {
    const key = issueKey(rawKey);
    const t = (await this.d.ports.jira.getTransitions(key)).find((x) => x.id === transitionId);
    if (!t) throw new EngineError(`Переход ${transitionId} задаче ${key} сейчас недоступен: обновите доску`, 409);
    await this.d.ports.jira.transition(key, t.id);
    return { to: transitionTarget(t, this.d.profiles.jira) };
  }

  /** Перечитывает задачу из Jira в контекст прогона. */
  async refresh(runId: string): Promise<void> {
    const run = this.d.store.getRun(runId);
    if (!run) throw new EngineError('Прогон не найден', 404);
    this.save(runId, await this.d.ports.jira.getIssue(run.issueKey), undefined);
  }

  private save(runId: string, issue: Issue, choice: RepoChoice | null | undefined): void {
    const ac = acceptanceCriteriaOf(issue);
    // Ключи открытия задачи - те же, что пресет по умолчанию считает входами прогона: список не разойдется с проверкой порядка.
    const inputs: Record<(typeof TASK_INPUTS)[number], unknown> = { issue, ac };
    for (const key of TASK_INPUTS) this.d.store.setContext(runId, key, this.d.redact.deep(inputs[key]), null);
    // Снимок задачи теперь свежий: найденные наблюдателем изменения и статус, который ставили шаги, к нему уже не относятся.
    this.d.store.deleteContext(runId, 'issueChanged');
    this.d.store.deleteContext(runId, 'status');
    if (issue.updated) this.d.store.setContext(runId, 'issueSeen', issue.updated, null);
    if (choice !== undefined) this.d.store.setContext(runId, 'repoChoice', choice, null);
    const acText = ac === null ? 'критерии приемки не найдены' : ac.length ? `критериев приемки: ${ac.length}` : 'метка skip_ac, критериев нет';
    this.d.bus.emitEvent({ runId, type: 'issue.loaded', message: `Задача загружена из Jira: ${issue.status}, ${acText}` });
  }
}
