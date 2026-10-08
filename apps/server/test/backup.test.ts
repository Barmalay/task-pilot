import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_EVERY_MS, BACKUP_KEEP, backupIfDue, backupName, listBackups, scheduleBackups } from '../src/backup.ts';
import { Store } from '../src/store/db.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'task-pilot-backup-'));
  dirs.push(root);
  const store = new Store(join(root, 'task-pilot.db'));
  store.createRun({ issueKey: 'TEAM-1', repoId: 'gate', standId: null, presetId: 'code-pr', dryRun: false }, [{ stepId: 'jira.start', selected: true }]);
  return { store, dir: join(root, 'backups') };
}

const at = (iso: string) => new Date(iso);

describe('database backups', () => {
  it('copy the database with its runs into a file named by the time of the copy', () => {
    const { store, dir } = setup();
    const b = backupIfDue(store, dir, at('2026-09-24T10:15:30.500Z'))!;
    expect(b.file).toBe(join(dir, 'task-pilot-2026-09-24T10-15-30.db'));
    const copy = new DatabaseSync(b.file, { readOnly: true });
    expect(copy.prepare("SELECT issue_key FROM runs WHERE issue_key = 'TEAM-1'").all()).toHaveLength(1);
    copy.close();
    store.close();
  });

  it('are made once a day: an earlier call keeps the last copy, a call a day later makes a new one', () => {
    const { store, dir } = setup();
    backupIfDue(store, dir, at('2026-09-24T10:00:00Z'));
    expect(backupIfDue(store, dir, new Date(at('2026-09-24T10:00:00Z').getTime() + BACKUP_EVERY_MS - 1000))).toBeNull();
    expect(backupIfDue(store, dir, new Date(at('2026-09-24T10:00:00Z').getTime() + BACKUP_EVERY_MS))).not.toBeNull();
    expect(listBackups(dir).map((b) => b.at.toISOString())).toEqual(['2026-09-25T10:00:00.000Z', '2026-09-24T10:00:00.000Z']);
    store.close();
  });

  it('keep only the last week of copies and leave foreign files alone', () => {
    const { store, dir } = setup();
    for (let day = 1; day <= BACKUP_KEEP + 2; day++) backupIfDue(store, dir, at(`2026-09-${String(day).padStart(2, '0')}T08:00:00Z`));
    writeFileSync(join(dir, 'notes.txt'), 'свое');
    backupIfDue(store, dir, at('2026-09-20T08:00:00Z'));
    expect(listBackups(dir).map((b) => b.at.toISOString().slice(0, 10))).toEqual(['2026-09-20', '2026-09-09', '2026-09-08', '2026-09-07', '2026-09-06', '2026-09-05', '2026-09-04']);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    store.close();
  });

  it('never count a copy that broke off in the middle', () => {
    const { store, dir } = setup();
    const broken: Store = Object.assign(Object.create(store) as Store, {
      backupTo(file: string) {
        writeFileSync(file, 'половина');
        throw new Error('нет места на диске');
      },
    });
    expect(() => backupIfDue(broken, dir, at('2026-09-24T10:00:00Z'))).toThrow('нет места на диске');
    expect(listBackups(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    // Процесс прервали посреди копии: временный файл остался и удаляется перед следующей копией.
    writeFileSync(join(dir, `${backupName(at('2026-09-24T10:01:00Z'))}.tmp`), 'половина');
    expect(backupIfDue(store, dir, at('2026-09-24T10:05:00Z'))).not.toBeNull();
    expect(readdirSync(dir)).toEqual([backupName(at('2026-09-24T10:05:00Z'))]);
    store.close();
  });

  it('start with a copy at launch and report a failed copy without stopping the server', () => {
    const { store, dir } = setup();
    const stop = scheduleBackups({ db: store, dir, onError: () => {} });
    stop();
    expect(listBackups(dir)).toHaveLength(1);
    const errors: unknown[] = [];
    const stopBroken = scheduleBackups({
      db: {
        backupTo() {
          throw new Error('база занята');
        },
      },
      dir: join(dir, 'other'),
      onError: (e) => errors.push(e),
    });
    stopBroken();
    expect(errors.map((e) => (e as Error).message)).toEqual(['база занята']);
    store.close();
  });

  it('list nothing when there is no folder yet', () => {
    expect(listBackups(join(tmpdir(), 'task-pilot-no-backups-here'))).toEqual([]);
  });
});
