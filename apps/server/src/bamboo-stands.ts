import { standsFromBamboo, type BambooEnvRef, type BambooPort, type Contour, type StandProfile } from '@task-pilot/step-kit';
import type { Profiles } from './config.ts';
import type { EventBus } from './engine/events.ts';

/** Как часто стенды перечитываются из Bamboo. */
const REFRESH_MS = 60 * 60_000;

/** Снимок стендов контура из Bamboo: что прочитано и когда. */
interface Snapshot {
  stands: StandProfile[];
  fetchedAt: string;
}

/** Где хранятся снимки: настройки приложения в базе. */
export interface StandsStore {
  setting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

const key = (contourId: string) => `stands:${contourId}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Стенды контуров с правилом stands в профиле: окружения проектов деплоя и их id читаются из Bamboo, последний снимок
 * хранится в базе, поэтому стенды есть и тогда, когда при запуске Bamboo не отвечает. Стенды из профилей стендов слоев
 * остаются как есть и при совпадении id важнее. Список стендов меняется на месте в общем объекте профилей: движок,
 * API и порт Bamboo сразу видят новый.
 */
export class BambooStands {
  private readonly d: { profiles: Profiles; store: StandsStore; bus: EventBus; bamboo: (contour: Contour) => BambooPort; now: () => Date };
  private readonly fileStands: StandProfile[];
  private readonly snapshots = new Map<string, Snapshot>();
  /** Последняя ошибка чтения по контуру: одна и та же ошибка пишется в ленту один раз. */
  private readonly errors = new Map<string, string>();

  constructor(deps: { profiles: Profiles; store: StandsStore; bus: EventBus; bamboo: (contour: Contour) => BambooPort; now?: () => Date }) {
    this.d = { ...deps, now: deps.now ?? (() => new Date()) };
    this.fileStands = [...deps.profiles.stands];
  }

  /** Контуры с правилом и репозиториями, у которых есть проект деплоя в Bamboo. */
  private sources(): { contour: Contour; repos: { id: string; project: number }[] }[] {
    return this.d.profiles.contours.flatMap((contour) => {
      if (!contour.stands || !contour.connected) return [];
      const repos = this.d.profiles.repos.flatMap((r) => (r.contour === contour.id && r.bamboo ? [{ id: r.id, project: r.bamboo.deploymentProject }] : []));
      return repos.length ? [{ contour, repos }] : [];
    });
  }

  /** Стенды из снимков в базе: при запуске, до первого чтения Bamboo. */
  loadSnapshots(): void {
    for (const { contour } of this.sources()) {
      const raw = this.d.store.setting(key(contour.id));
      if (!raw) continue;
      try {
        this.snapshots.set(contour.id, JSON.parse(raw) as Snapshot);
      } catch (e) {
        console.error(`Снимок стендов ${contour.title} в базе не читается`, e);
      }
    }
    this.apply();
  }

  /** Перечитывает стенды из Bamboo. Сбой или пустой ответ оставляют прежний снимок и пишут событие в общую ленту. */
  async refresh(): Promise<void> {
    for (const { contour, repos } of this.sources()) {
      const previous = this.snapshots.get(contour.id);
      try {
        const port = this.d.bamboo(contour);
        const envs: Record<string, BambooEnvRef[]> = {};
        for (const r of repos) envs[r.id] = (await port.environments(r.project)).map((e) => ({ envId: e.envId, envName: e.envName }));
        const stands = standsFromBamboo(contour, envs);
        if (!stands.length) throw new Error(`ни одно окружение проектов деплоя не подошло под правило ${contour.stands?.include}`);
        this.errors.delete(contour.id);
        const snapshot: Snapshot = { stands, fetchedAt: this.d.now().toISOString() };
        this.d.store.setSetting(key(contour.id), JSON.stringify(snapshot));
        this.snapshots.set(contour.id, snapshot);
        if (JSON.stringify(previous?.stands) === JSON.stringify(stands)) continue;
        this.apply();
        const was = new Set((previous?.stands ?? []).map((s) => s.id));
        const now = new Set(stands.map((s) => s.id));
        const added = stands.filter((s) => !was.has(s.id)).map((s) => s.id);
        const removed = [...was].filter((id) => !now.has(id));
        const diff = previous ? `, новых ${added.length}, убрано ${removed.length}` : '';
        this.d.bus.emitEvent({ type: 'stands.updated', message: `Стенды ${contour.title} из Bamboo: ${stands.length}${diff}`, data: { contour: contour.id, count: stands.length, added, removed } });
      } catch (e) {
        const text = message(e);
        if (this.errors.get(contour.id) === text) continue;
        this.errors.set(contour.id, text);
        console.error(`Стенды ${contour.title} не прочитаны из Bamboo`, e);
        const kept = previous ? `остались снятые ${previous.fetchedAt}` : 'снятых стендов нет';
        this.d.bus.emitEvent({ type: 'stands.failed', message: `Стенды ${contour.title} не прочитаны из Bamboo: ${text}; ${kept}`, data: { contour: contour.id } });
      }
    }
  }

  /** Чтение стендов сразу и дальше раз в час; возвращает остановку. */
  start(): () => void {
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), REFRESH_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  private apply(): void {
    const own = new Set(this.fileStands.map((s) => s.id));
    const derived = [...this.snapshots.values()].flatMap((s) => s.stands).filter((s) => !own.has(s.id));
    this.d.profiles.stands = [...this.fileStands, ...derived];
  }
}
