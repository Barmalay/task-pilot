import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CacheService, dirBytes, QA_CACHE_DIRS } from '../src/cache.ts';
import { EventBus } from '../src/engine/events.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { Store } from '../src/store/db.ts';

/** Файл заданного размера; папки создаются. */
function file(path: string, bytes: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

/**
 * База с прогонами и служебная папка с их файлами: у каждого прогона папка runs/<id> и журнал сессии агента
 * agent/<id>. Прогоны из active выполняются, QA-браузер открыт, пока qa.running.
 */
function setup() {
  const store = new Store(':memory:');
  const bus = new EventBus(store, createRedactor([]));
  const dataDir = mkdtempSync(join(tmpdir(), 'task-pilot-cache-'));
  const qaProfileDir = join(dataDir, 'qa-chrome');
  const active = new Set<string>();
  const qa = { running: false };
  const cache = new CacheService({ store, bus, dataDir, qaProfileDir, isActive: (id) => active.has(id), qaRunning: async () => qa.running });
  /** Прогон со статусом status: файл прогона runBytes и журнал агента agentBytes. */
  const run = (issueKey: string, status: 'completed' | 'failed' | 'running', runBytes: number, agentBytes: number) => {
    const r = store.createRun({ issueKey, repoId: 'gate', standId: null, presetId: 'code-pr', dryRun: false }, [{ stepId: 'code.implement', selected: true }]);
    store.updateRun(r.id, { status });
    const s = store.createAgentSession({ sessionId: `s-${issueKey}`, runId: r.id, stepId: 'code.implement', label: 'код', model: null });
    if (runBytes) file(join(dataDir, 'runs', r.id, 'verify-build-1.log'), runBytes);
    if (agentBytes) file(join(dataDir, 'agent', s.id, 'stream.jsonl'), agentBytes);
    return { id: r.id, runDir: join(dataDir, 'runs', r.id), agentDir: join(dataDir, 'agent', s.id) };
  };
  const cleared = () => store.db.prepare("SELECT message FROM events WHERE type = 'cache.cleared'").all().map((r) => r.message);
  return { store, dataDir, qaProfileDir, active, qa, cache, run, cleared };
}

describe('size of a folder', () => {
  it('sums the files of all nested folders and is zero for a missing folder', () => {
    const t = setup();
    file(join(t.dataDir, 'x', 'a.txt'), 100);
    file(join(t.dataDir, 'x', 'deep', 'er', 'b.txt'), 50);
    expect(dirBytes(join(t.dataDir, 'x'))).toBe(150);
    expect(dirBytes(join(t.dataDir, 'nothing-here'))).toBe(0);
  });
});

describe('cache of runs', () => {
  it('shows the files of every run with their size and lets clear only completed runs that are not executing', async () => {
    const t = setup();
    const done = t.run('TEAM-1', 'completed', 1000, 2000);
    const failed = t.run('TEAM-2', 'failed', 300, 0);
    const rerun = t.run('TEAM-3', 'completed', 10, 20);
    t.active.add(rerun.id);
    t.run('TEAM-4', 'completed', 0, 0);
    const s = await t.cache.status();
    expect(s.runs).toEqual(
      expect.arrayContaining([
        { runId: done.id, bytes: 3000, clearable: true },
        { runId: failed.id, bytes: 300, clearable: false },
        { runId: rerun.id, bytes: 30, clearable: false },
      ]),
    );
    expect(s.runs).toHaveLength(3);
    expect(s).toMatchObject({ runsBytes: 3330, clearableBytes: 3000, qa: { bytes: 0, running: false } });
  });

  it('clears the files and agent journals of a completed run and keeps the run with its feed in the database', async () => {
    const t = setup();
    const done = t.run('TEAM-1', 'completed', 1000, 2000);
    const other = t.run('TEAM-2', 'completed', 5, 5);
    expect(t.cache.clearRun(done.id)).toBe(3000);
    expect(existsSync(done.runDir)).toBe(false);
    expect(existsSync(done.agentDir)).toBe(false);
    expect(existsSync(other.runDir)).toBe(true);
    expect(t.store.getRun(done.id)).toMatchObject({ status: 'completed' });
    expect(t.store.agentSessionIds(done.id)).toHaveLength(1);
    expect(t.cleared()).toEqual(['Очищен кэш прогона TEAM-1: 3 КБ']);
    expect((await t.cache.status()).runs.map((r) => r.runId)).toEqual([other.id]);
  });

  it('refuses to clear a run that is not completed or is executing and leaves its files', () => {
    const t = setup();
    const failed = t.run('TEAM-2', 'failed', 300, 0);
    const rerun = t.run('TEAM-3', 'completed', 10, 20);
    t.active.add(rerun.id);
    expect(() => t.cache.clearRun(failed.id)).toThrow('Прогон TEAM-2 не завершен или выполняется: его файлы еще нужны шагам');
    expect(() => t.cache.clearRun(rerun.id)).toThrow('Прогон TEAM-3 не завершен или выполняется');
    expect(() => t.cache.clearRun('no-such-run')).toThrow('Прогон не найден');
    expect(existsSync(failed.runDir)).toBe(true);
    expect(existsSync(rerun.agentDir)).toBe(true);
    expect(t.cleared()).toEqual([]);
  });

  it('clears all completed runs at once and counts only the runs that had files', async () => {
    const t = setup();
    const a = t.run('TEAM-1', 'completed', 1000, 2000);
    const b = t.run('TEAM-2', 'completed', 0, 500);
    t.run('TEAM-3', 'completed', 0, 0);
    const failed = t.run('TEAM-4', 'failed', 300, 0);
    expect(t.cache.clearCompleted()).toEqual({ runs: 2, bytes: 3500 });
    expect(existsSync(a.runDir) || existsSync(b.agentDir)).toBe(false);
    expect(existsSync(failed.runDir)).toBe(true);
    expect(await t.cache.status()).toMatchObject({ runsBytes: 300, clearableBytes: 0 });
    expect(t.cleared()).toEqual(['Очищен кэш завершенных прогонов: 2, 4 КБ']);
  });
});

describe('cache of the QA browser', () => {
  it('removes only the cache folders of the profile and keeps cookies and site storage with the logins', async () => {
    const t = setup();
    file(join(t.qaProfileDir, 'Default', 'Cache', 'Cache_Data', 'f_000001'), 4000);
    file(join(t.qaProfileDir, 'Default', 'Code Cache', 'js', 'index'), 1000);
    file(join(t.qaProfileDir, 'GrShaderCache', 'data_0'), 24);
    file(join(t.qaProfileDir, 'Default', 'Cookies'), 700);
    file(join(t.qaProfileDir, 'Default', 'Local Storage', 'leveldb', '000003.log'), 300);
    expect((await t.cache.status()).qa).toEqual({ bytes: 5024, running: false });
    expect(await t.cache.clearQa()).toBe(5024);
    for (const dir of QA_CACHE_DIRS) expect(existsSync(join(t.qaProfileDir, dir))).toBe(false);
    expect(existsSync(join(t.qaProfileDir, 'Default', 'Cookies'))).toBe(true);
    expect(existsSync(join(t.qaProfileDir, 'Default', 'Local Storage', 'leveldb', '000003.log'))).toBe(true);
    expect((await t.cache.status()).qa.bytes).toBe(0);
    expect(t.cleared()).toEqual(['Очищен кэш QA-браузера: 5 КБ']);
  });

  it('refuses to clear the cache while the QA browser is open', async () => {
    const t = setup();
    file(join(t.qaProfileDir, 'Default', 'Cache', 'Cache_Data', 'f_000001'), 4000);
    t.qa.running = true;
    expect((await t.cache.status()).qa).toEqual({ bytes: 4000, running: true });
    await expect(t.cache.clearQa()).rejects.toThrow('QA-браузер открыт: закройте его окно, потом очистите кэш');
    expect(existsSync(join(t.qaProfileDir, 'Default', 'Cache', 'Cache_Data', 'f_000001'))).toBe(true);
  });
});
