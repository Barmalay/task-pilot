import type { Issue, IssueChanged, JiraConfig, Ports, WaitEvent } from '@task-pilot/step-kit';
import { boardStatuses, commentsToAnswer, issueChanges, normalizeName, pendingDeploys, serviceAnswers } from '@task-pilot/step-kit';
import type { Profiles } from './config.ts';
import type { Engine } from './engine/engine.ts';
import type { EventBus } from './engine/events.ts';
import type { Waiting } from './engine/status.ts';
import type { Redactor } from './lib/redact.ts';
import type { RunRow, Store } from './store/db.ts';

/** Сколько дней после последнего обновления прогон еще наблюдается. */
const WATCH_DAYS = 14;

/** Ожидания, которые проверяются на быстром интервале: сборка, деплой и выкатка идут минуты, а не дни. */
const FAST = new Set<WaitEvent['kind']>(['plan-branch', 'build', 'deploy', 'rollout', 'linked']);
/** Состояния сборки и деплоя, после которых ждать нечего: шаг сам разберет, чем они кончились. */
const BUILD_OVER = new Set(['Finished', 'NotBuilt']);
const DEPLOY_OVER = new Set(['FINISHED', 'NOT_BUILT']);
/** Запас на расхождение часов с Bamboo, когда ищется деплой, начатый владельцем после начала ожидания. */
const CLOCK_SKEW_MS = 60_000;

/**
 * Задача закончена, и следить за ней больше незачем: дошла до вехи merged доски или дальше, или она в одном из статусов
 * окончания доски (finished, например Closed).
 */
export function finished(status: string, jira: Pick<JiraConfig, 'path' | 'after' | 'milestones' | 'finished'>): boolean {
  const order = boardStatuses(jira).map(normalizeName);
  const target = jira.milestones.merged;
  const merged = target ? order.indexOf(normalizeName(target)) : -1;
  const at = order.indexOf(normalizeName(status));
  return (merged >= 0 && at >= merged) || jira.finished.some((s) => normalizeName(s) === normalizeName(status));
}

type Checks = { [K in WaitEvent['kind']]: (run: RunRow, event: Extract<WaitEvent, { kind: K }>, waiting: Waiting) => Promise<boolean> };

export interface WatcherDeps {
  store: Store;
  engine: Engine;
  bus: EventBus;
  /** Порты, которые спрашивает наблюдатель: PR, сборки и деплои, логи стендов, git и Jira. */
  ports: Pick<Ports, 'jira' | 'scm' | 'bamboo' | 'logs' | 'git'>;
  /** Контуры, стенды и репозитории профилей: события ожидания называют их по id. */
  profiles: Pick<Profiles, 'contours' | 'stands' | 'repos'>;
  /** Профиль доски с логином активного аккаунта Jira: свои комментарии изменением задачи не считаются. */
  jira: () => JiraConfig;
  redact: Redactor;
}

/**
 * Наблюдатель Task Pilot: проверяет то, чего ждут прогоны, без опроса внутри шагов. Шаг, который ждет события
 * (`StepWaiting`), оставляет в контексте запись `waiting`; наблюдатель спрашивает порт этого события, готово ли оно
 * (реестр проверок по виду события), и, когда готово, продолжает прогон, а после срока роняет шаг с ошибкой, которую
 * шаг бросил бы сам. Ожидания смотрятся у всех ждущих прогонов, сборка, деплой, выкатка и связанные прогоны - на
 * быстром интервале, PR, ручной деплой, ветка и изменения задачи - на обычном. Смерженный или отклоненный PR продолжает
 * прогон, новые замечания без ответа дают событие pr.review, и движок запускает шаг, у которого на него триггер. У
 * последнего прогона каждой незавершенной задачи сверяется задача в Jira со снимком прогона и статусом, который поставили его шаги: изменения
 * ложатся в контекст (`issueChanged`) и в ленту, а переходы самого прогона изменениями не считаются. Находки идут
 * событиями pr.merged, pr.review и issue.changed, по ним вкладка присылает уведомления. Выполняющиеся прогоны
 * наблюдатель не трогает.
 */
export class Watcher {
  private readonly d: WatcherDeps;
  private readonly intervalMs: number;
  private readonly fastMs: number;
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private busy = false;
  /** Когда были проверки обычного интервала: изменения задач и медленные ожидания. */
  private slowAt = 0;

  /** intervalMs - обычный интервал, fastMs - быстрый для сборок и деплоев; тикает наблюдатель по меньшему из них. */
  constructor(d: WatcherDeps, intervalMs: number, fastMs = intervalMs) {
    this.d = d;
    this.intervalMs = intervalMs;
    this.fastMs = fastMs;
  }

  start(): void {
    const tickMs = Math.min(this.fastMs, this.intervalMs);
    this.first = setTimeout(() => void this.tick(), Math.min(30_000, tickMs));
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.first.unref();
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /**
   * Одна проверка наблюдаемых прогонов на время now: быстрые ожидания - всегда, медленные и изменения задач - если с
   * прошлой такой проверки прошел обычный интервал. Повторный вызов во время проверки ничего не делает.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const slow = now.getTime() - this.slowAt >= this.intervalMs;
      if (slow) this.slowAt = now.getTime();
      const runs = this.d.store.listRuns(500);
      const watched = this.watched(now);
      // Ожидание есть у любого ждущего прогона: у задачи в нескольких репозиториях ждущий прогон бывает не самым новым, а
      // прогон, чей шаг ждет мержа, может в это же время ждать подтверждения фонового шага.
      for (const run of runs.filter(watched)) {
        const waiting = this.d.store.getContext(run.id).waiting as Waiting | undefined;
        if (waiting && (slow || FAST.has(waiting.event.kind))) await this.guard(run, () => this.checkWaiting(run, waiting, now));
      }
      if (!slow) return;
      // Изменения задачи сверяются с последним прогоном задачи: иначе одно изменение пришло бы от каждого ее прогона.
      const latest = new Map<string, RunRow>();
      for (const run of runs) if (!latest.has(run.issueKey)) latest.set(run.issueKey, run);
      for (const run of latest.values()) if (watched(run)) await this.guard(run, () => this.checkIssue(run));
    } finally {
      this.busy = false;
    }
  }

  /** Наблюдается ли прогон: обновлен за WATCH_DAYS дней, не пробный и не выполняется сейчас. */
  private watched(now: Date): (run: RunRow) => boolean {
    const since = now.getTime() - WATCH_DAYS * 86_400_000;
    // Идущая цепочка сама дойдет до ожидания, а фоновый шаг ей не мешает: мерж замечается, пока готовится вики.
    return (r) => Date.parse(r.updatedAt) >= since && !r.dryRun && !this.d.engine.isChainActive(r.id);
  }

  /** Сбой проверки одного прогона не мешает проверить остальные: он уходит в журнал сервера. */
  private async guard(run: RunRow, check: () => Promise<void>): Promise<void> {
    try {
      await check();
    } catch (e) {
      console.warn(`Наблюдатель, прогон ${run.id} (${run.issueKey}): ${this.d.redact.text(e instanceof Error ? e.message : String(e))}`);
    }
  }

  /**
   * Одно ожидание: событие случилось - прогон продолжается, срок вышел - шаг падает. Сбой проверки шаг до срока не
   * роняет: следующая проверка спросит порт снова, а после срока ошибка шага говорит и о последнем сбое.
   */
  private async checkWaiting(run: RunRow, waiting: Waiting, now: Date): Promise<void> {
    const step = this.d.store.getStep(run.id, waiting.stepId);
    // Запись без ждущего шага (его повторили, пропустили или сняли с плана) наблюдатель не продолжает.
    if (!step?.selected || step.status !== 'waiting') return;
    let ready = false;
    let failure = '';
    try {
      ready = await (this.checks[waiting.event.kind] as (run: RunRow, event: WaitEvent, waiting: Waiting) => Promise<boolean>)(run, waiting.event, waiting);
    } catch (e) {
      failure = this.d.redact.text(e instanceof Error ? e.message : String(e));
      console.warn(`Наблюдатель, прогон ${run.id} (${run.issueKey}), ожидание ${waiting.event.kind}: ${failure}`);
    }
    if (ready) {
      void this.d.engine.start(run.id).catch(() => undefined);
      return;
    }
    const deadline = 'deadline' in waiting.event ? waiting.event.deadline : undefined;
    if (deadline && now.getTime() >= Date.parse(deadline.at)) {
      this.d.engine.failWaiting(run.id, waiting.stepId, failure ? `${deadline.error}. Последняя проверка: ${failure}` : deadline.error);
    }
  }

  /** Готово ли событие: по его виду - вопрос к своему порту. */
  private readonly checks: Checks = {
    pr: (run, e, waiting) => this.prReady(run, e, waiting),
    'plan-branch': async (_run, e) => (await this.bamboo(e.contour).planBranch(e.plan, e.branch)) !== null,
    build: async (_run, e) => BUILD_OVER.has((await this.bamboo(e.contour).builds(e.planKey, 10)).find((b) => b.revision === e.revision)?.lifeCycle ?? ''),
    'manual-deploy': async (_run, e) => {
      const since = Date.parse(e.since) - CLOCK_SKEW_MS;
      const results = await this.bamboo(e.contour).environmentResults(e.envId, 5);
      return results.some((r) => r.versionId === e.versionId && r.startedAt !== null && Date.parse(r.startedAt) >= since);
    },
    deploy: async (_run, e) => DEPLOY_OVER.has((await this.bamboo(e.contour).deployResult(e.resultId, false)).lifeCycle),
    rollout: async (_run, e) => {
      const stand = this.d.profiles.stands.find((s) => s.id === e.standId);
      const repo = this.d.profiles.repos.find((r) => r.id === e.repoId);
      // Стенда или репозитория больше нет в профилях: что не так, скажет сам шаг.
      if (!stand || !repo) return true;
      const logs = this.d.ports.logs(stand.logs);
      if (e.tag && (await logs.pods(e.app, [stand.namespace], 30))[stand.namespace]?.[0]?.tag !== e.tag) return false;
      if (!e.probe) return true;
      const r = await logs.probe(e.probe.url, this.d.profiles.contours.find((c) => c.id === stand.contour)?.serviceHeader);
      return e.probe.service ? serviceAnswers(stand, repo, r) : r.status === 200;
    },
    linked: async (run, e) => pendingDeploys(this.d.engine.linkedRunsOf(run.id), e.deployStep).length === 0,
  };

  private bamboo(contourId: string) {
    const contour = this.d.profiles.contours.find((c) => c.id === contourId);
    if (!contour) throw new Error(`Контура ${contourId} нет в профилях`);
    return this.d.ports.bamboo(contour);
  }

  /**
   * PR смержен или отклонен - прогон продолжается (событие pr.merged). Появились замечания без ответа - событие
   * pr.review, по нему движок запускает шаг, у которого на него триггер; прогон ждет дальше.
   */
  private async prReady(run: RunRow, e: Extract<WaitEvent, { kind: 'pr' }>, waiting: Waiting): Promise<boolean> {
    const pr = await this.d.ports.scm.pullRequest(e.scm, e.pr);
    if (pr.state !== 'OPEN') {
      const text = pr.state === 'MERGED' ? `PR #${pr.id} смержен` : `PR #${pr.id}: ${pr.state === 'DECLINED' ? 'отклонен' : pr.state}`;
      this.d.bus.emitEvent({ runId: run.id, stepId: waiting.stepId, type: 'pr.merged', message: text, data: { pr: pr.id, state: pr.state } });
      return true;
    }
    const answer = commentsToAnswer(pr).map((c) => c.id);
    const seen = (this.d.store.getContext(run.id).prSeen as number[] | undefined) ?? [];
    const fresh = answer.filter((id) => !seen.includes(id));
    this.d.store.setContext(run.id, 'prSeen', answer, null);
    if (fresh.length) this.d.bus.emitEvent({ runId: run.id, stepId: waiting.stepId, type: 'pr.review', message: `В PR #${pr.id} замечаний без ответа: ${answer.length}`, data: { pr: pr.id, comments: fresh } });
    return false;
  }

  private async checkIssue(run: RunRow): Promise<void> {
    const ctx = this.d.store.getContext(run.id);
    const snapshot = ctx.issue as Issue | undefined;
    if (!snapshot) return;
    // Шаги, которые переводят задачу по доске, кладут новый статус в контекст: свои переходы прогона изменением не считаются.
    const known = typeof ctx.status === 'string' ? ctx.status : snapshot.status;
    if (finished(known, this.d.jira())) return;
    const fresh = await this.d.ports.jira.getIssue(run.issueKey);
    const seen = (ctx.issueSeen as string | undefined) ?? snapshot.updated;
    if (fresh.updated && fresh.updated === seen) return;
    this.d.store.setContext(run.id, 'issueSeen', fresh.updated ?? null, null);
    const changes = issueChanges({ ...snapshot, status: known }, fresh, this.d.jira());
    // Та же находка уже в прогоне: без времени обновления у задачи сравнение повторяется на каждой проверке.
    const before = (ctx.issueChanged as IssueChanged | undefined)?.changes;
    if (!changes.length || (before && JSON.stringify(before) === JSON.stringify(changes))) return;
    const changed: IssueChanged = { at: new Date().toISOString(), status: fresh.status, changes };
    this.d.store.setContext(run.id, 'issueChanged', changed, null);
    this.d.bus.emitEvent({ runId: run.id, type: 'issue.changed', message: changes.map((c) => c.text).join('; '), data: { changes } });
  }
}
