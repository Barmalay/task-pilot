import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus } from './engine/events.ts';
import type { CacheDto } from '@task-pilot/api-types';
import type { Store } from './store/db.ts';

/**
 * Папки кэша в профиле QA-браузера: кэш страниц, скриптов, шейдеров и воркеров. Cookies, хранилища сайтов и прочее,
 * на чем держатся входы на стенды и в Kibana, в список не входят и не удаляются.
 */
export const QA_CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
];

/** Сумма размеров файлов в папке со всеми вложенными; нет папки - 0. */
export function dirBytes(path: string): number {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      total += statSync(join(e.parentPath, e.name)).size;
    } catch {
      // Файл исчез, пока шел подсчет.
    }
  }
  return total;
}

/** Размер для ленты: меньше мегабайта - в КБ, дальше в МБ. */
const size = (bytes: number) => (bytes < 1024 ** 2 ? `${Math.ceil(bytes / 1024)} КБ` : `${(bytes / 1024 ** 2).toFixed(1)} МБ`);

/** Зависимости кэша: база прогонов, лента, служебная папка, профиль QA-браузера и что сейчас работает. */
export interface CacheDeps {
  store: Store;
  bus: EventBus;
  dataDir: string;
  qaProfileDir: string;
  /** Выполняется ли прогон: его файлы трогать нельзя. */
  isActive: (runId: string) => boolean;
  /** Открыт ли QA-браузер: из-под работающего Chrome кэш не удаляется. */
  qaRunning: () => Promise<boolean>;
}

/**
 * Кэш Task Pilot на диске: служебные файлы прогонов и журналы их агентов в .data и кэш страниц QA-браузера. Очистка
 * прогона удаляет только его файлы: прогон, его время, сбои и лента остаются в базе, пропадают подробности вызовов
 * агента в ленте и логи сборок. Поэтому чистятся только завершенные прогоны, которые сейчас не выполняются.
 */
export class CacheService {
  private readonly d: CacheDeps;

  constructor(deps: CacheDeps) {
    this.d = deps;
  }

  private dirsOf(runId: string): string[] {
    return [join(this.d.dataDir, 'runs', runId), ...this.d.store.agentSessionIds(runId).map((id) => join(this.d.dataDir, 'agent', id))];
  }

  private clearable(runId: string): boolean {
    return this.d.store.getRun(runId)?.status === 'completed' && !this.d.isActive(runId);
  }

  /** Сколько места занимают файлы каждого прогона и кэш QA-браузера, что из этого можно очистить. */
  async status(): Promise<CacheDto> {
    const runs = this.d.store.listRuns(10_000).map((r) => ({ runId: r.id, bytes: this.dirsOf(r.id).reduce((sum, dir) => sum + dirBytes(dir), 0), clearable: this.clearable(r.id) }));
    const qaBytes = QA_CACHE_DIRS.reduce((sum, dir) => sum + dirBytes(join(this.d.qaProfileDir, dir)), 0);
    return {
      runs: runs.filter((r) => r.bytes > 0),
      runsBytes: runs.reduce((sum, r) => sum + r.bytes, 0),
      clearableBytes: runs.filter((r) => r.clearable).reduce((sum, r) => sum + r.bytes, 0),
      qa: { bytes: qaBytes, running: await this.d.qaRunning() },
    };
  }

  /** Удаляет файлы завершенного прогона и возвращает, сколько места освободилось. */
  clearRun(runId: string): number {
    const run = this.d.store.getRun(runId);
    if (!run) throw new Error('Прогон не найден');
    if (!this.clearable(runId)) throw new Error(`Прогон ${run.issueKey} не завершен или выполняется: его файлы еще нужны шагам`);
    const freed = this.remove(runId);
    this.d.bus.emitEvent({ type: 'cache.cleared', message: `Очищен кэш прогона ${run.issueKey}: ${size(freed)}`, data: { runId, bytes: freed } });
    return freed;
  }

  /** Удаляет файлы всех завершенных прогонов, которые сейчас не выполняются. */
  clearCompleted(): { runs: number; bytes: number } {
    let runs = 0;
    let bytes = 0;
    for (const r of this.d.store.listRuns(10_000)) {
      if (!this.clearable(r.id)) continue;
      const freed = this.remove(r.id);
      if (freed > 0) runs++;
      bytes += freed;
    }
    this.d.bus.emitEvent({ type: 'cache.cleared', message: `Очищен кэш завершенных прогонов: ${runs}, ${size(bytes)}`, data: { runs, bytes } });
    return { runs, bytes };
  }

  /** Удаляет кэш страниц QA-браузера; пока браузер открыт, отказывает: удалять кэш из-под работающего Chrome нельзя. */
  async clearQa(): Promise<number> {
    if (await this.d.qaRunning()) throw new Error('QA-браузер открыт: закройте его окно, потом очистите кэш');
    let bytes = 0;
    for (const dir of QA_CACHE_DIRS) {
      const path = join(this.d.qaProfileDir, dir);
      bytes += dirBytes(path);
      rmSync(path, { recursive: true, force: true });
    }
    this.d.bus.emitEvent({ type: 'cache.cleared', message: `Очищен кэш QA-браузера: ${size(bytes)}`, data: { qa: true, bytes } });
    return bytes;
  }

  private remove(runId: string): number {
    let bytes = 0;
    for (const dir of this.dirsOf(runId)) {
      bytes += dirBytes(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    return bytes;
  }
}
