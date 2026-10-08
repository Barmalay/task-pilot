import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Сколько копий базы хранится: при копии раз в сутки - последняя неделя. */
export const BACKUP_KEEP = 7;
/** Как часто делается копия базы. */
export const BACKUP_EVERY_MS = 24 * 60 * 60_000;
/** Как часто сервер проверяет, не пора ли сделать копию. */
const CHECK_EVERY_MS = 60 * 60_000;

const NAME = /^task-pilot-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.db$/;
const TMP = /^task-pilot-.+\.db\.tmp$/;

/** Копия базы в папке резервных копий. */
export interface Backup {
  file: string;
  at: Date;
  size: number;
}

/** База, которая умеет записать свою согласованную копию в файл. */
export interface BackupSource {
  backupTo(file: string): void;
}

/** Имя копии по времени UTC: порядок имен совпадает с порядком времени. */
export function backupName(at: Date): string {
  return `task-pilot-${at.toISOString().slice(0, 19).replaceAll(':', '-')}.db`;
}

/** Копии базы в папке, новые первыми; нет папки - нет и копий. Посторонние и недописанные файлы не считаются. */
export function listBackups(dir: string): Backup[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const m = NAME.exec(name);
      if (!m) return [];
      const file = join(dir, name);
      return [{ file, at: new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`), size: statSync(file).size }];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Делает копию базы, если копий нет или последней не меньше BACKUP_EVERY_MS, и удаляет копии сверх BACKUP_KEEP.
 * Копия пишется во временный файл и потом переименовывается: оборванная на середине копия в список не попадает,
 * а ее временный файл удаляется сразу при сбое или, если процесс прервали, перед следующей копией.
 * Возвращает новую копию; null - копия пока не нужна.
 */
export function backupIfDue(db: BackupSource, dir: string, now = new Date()): Backup | null {
  const last = listBackups(dir)[0];
  if (last && now.getTime() - last.at.getTime() < BACKUP_EVERY_MS) return null;
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (TMP.test(name)) rmSync(join(dir, name), { force: true });
  const file = join(dir, backupName(now));
  const tmp = `${file}.tmp`;
  try {
    db.backupTo(tmp);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  for (const old of listBackups(dir).slice(BACKUP_KEEP)) rmSync(old.file, { force: true });
  return { file, at: now, size: statSync(file).size };
}

/**
 * Копии базы по расписанию: проверка сразу при запуске и дальше раз в час, копия не чаще раза в BACKUP_EVERY_MS.
 * Сбой копии сервер не останавливает, он уходит в onError. Возвращает остановку расписания.
 */
export function scheduleBackups(d: { db: BackupSource; dir: string; onError: (e: unknown) => void }): () => void {
  const tick = () => {
    try {
      backupIfDue(d.db, d.dir);
    } catch (e) {
      d.onError(e);
    }
  };
  tick();
  const timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
