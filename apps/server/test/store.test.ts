import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('store upgrade', () => {
  it('adds the columns of later versions to a database made by the first one and keeps its runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-pilot-store-'));
    dirs.push(dir);
    const file = join(dir, 'task-pilot.db');
    // Таблицы первой версии: без черновика и замечания у шагов и без признака начатой сессии агента.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, issue_key TEXT NOT NULL, repo_id TEXT NOT NULL, stand_id TEXT, preset_id TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE run_steps (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, step_id TEXT NOT NULL, position INTEGER NOT NULL,
        selected INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, note TEXT, error TEXT, started_at TEXT, finished_at TEXT, PRIMARY KEY (run_id, step_id));
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL, label TEXT NOT NULL, model TEXT, status TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
      INSERT INTO runs VALUES ('r1', 'TEAM-1', 'demo', NULL, 'full', 0, 'idle', '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z');
      INSERT INTO run_steps (run_id, step_id, position, selected, status) VALUES ('r1', 'jira.start', 0, 1, 'succeeded');
    `);
    old.close();
    const store = new Store(file);
    const columns = (table: string) => store.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
    expect(columns('run_steps')).toEqual(expect.arrayContaining(['draft', 'feedback']));
    expect(columns('agent_sessions')).toContain('started');
    expect(store.getRun('r1')).toMatchObject({ issueKey: 'TEAM-1', status: 'idle' });
    expect(store.getSteps('r1')).toMatchObject([{ stepId: 'jira.start', status: 'succeeded', feedback: null }]);
    store.setDraft('r1', 'jira.start', { text: 'черновик' });
    expect(store.getDraft('r1', 'jira.start')).toEqual({ text: 'черновик' });
    store.close();
  });
});
