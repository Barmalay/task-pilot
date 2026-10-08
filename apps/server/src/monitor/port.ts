import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  attemptProfileSchema,
  dashboardSchema,
  featureProfileSchema,
  formatZodError,
  unknownServices,
  type AttemptProfile,
  type Dashboard,
  type DashboardError,
  type FeatureProfile,
  type LogResult,
  type MonitorLogsPort,
  type MonitorPort,
  type MonitorProfile,
  type MonitorStats,
} from '@task-pilot/step-kit';

const FILE = 'dashboard.yaml';

/** Нагрузка, когда логов прода нет: ни одного запроса. */
const IDLE: MonitorStats = { windowMs: 5 * 60_000, calls: 0, searches: 0, cached: 0, errors: 0, avgTookMs: null, lastError: null };

/** Настройки порта панели мониторинга. */
export interface MonitorPortOptions {
  /** Профиль панели; null - monitor.yaml нет ни в пакете команды, ни в слое компании. */
  profile: MonitorProfile | null;
  /** Папка дашбордов пакета команды: dashboards/<id>/dashboard.yaml. */
  dir: string;
  /** Папка профилей фич пакета команды: features/<id>.yaml; без нее фич нет. */
  features?: string;
  /** Профиль пути одной попытки: attempt.yaml пакета команды; без файла путь строится по полям сервисов. */
  attempt?: string;
  /** Логи прода; null с причиной - источник не настроен. */
  logs: MonitorLogsPort | { unavailable: string };
}

/** Дашборд из текста YAML: ошибки разбора, схемы и сервисов профиля по порядку. */
export function checkDashboard(source: string, profile: MonitorProfile | null): { dashboard: Dashboard | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (e) {
    return { dashboard: null, errors: [`YAML не разбирается: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = dashboardSchema.safeParse(raw);
  if (!parsed.success) return { dashboard: null, errors: [formatZodError(parsed.error)] };
  const unknown = unknownServices(parsed.data, profile?.services ?? []);
  if (unknown.length) return { dashboard: null, errors: [`нет сервисов ${unknown.join(', ')} в monitor.yaml`] };
  return { dashboard: parsed.data, errors: [] };
}

/** Дашборд из файла: проверен схемой и сервисами профиля, id совпадает с папкой. */
export function readDashboard(file: string, folder: string, profile: MonitorProfile | null): Dashboard {
  const { dashboard, errors } = checkDashboard(readFileSync(file, 'utf8'), profile);
  if (!dashboard) throw new Error(errors.join('; '));
  if (dashboard.id !== folder) throw new Error(`id ${dashboard.id} не совпадает с папкой ${folder}`);
  return dashboard;
}

/** Профиль фичи из текста YAML: ошибки разбора, схемы и сервиса профиля по порядку. */
export function checkFeature(source: string, profile: MonitorProfile | null): { feature: FeatureProfile | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (e) {
    return { feature: null, errors: [`YAML не разбирается: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = featureProfileSchema.safeParse(raw);
  if (!parsed.success) return { feature: null, errors: [formatZodError(parsed.error)] };
  if (!(profile?.services ?? []).some((s) => s.id === parsed.data.service)) return { feature: null, errors: [`нет сервиса ${parsed.data.service} в monitor.yaml`] };
  return { feature: parsed.data, errors: [] };
}

/** Профиль пути из текста YAML: ошибки разбора, схемы и сервисов пути по порядку. */
export function checkAttempt(source: string, profile: MonitorProfile | null): { attempt: AttemptProfile | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (e) {
    return { attempt: null, errors: [`YAML не разбирается: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = attemptProfileSchema.safeParse(raw);
  if (!parsed.success) return { attempt: null, errors: [formatZodError(parsed.error)] };
  const known = new Set((profile?.services ?? []).map((s) => s.id));
  const unknown = parsed.data.services.map((s) => s.service).filter((s) => !known.has(s));
  if (unknown.length) return { attempt: null, errors: [`нет сервисов ${unknown.join(', ')} в monitor.yaml`] };
  return { attempt: parsed.data, errors: [] };
}

/** Файлы папки с подписью по именам и времени изменения: по подписи видно, что набор или файлы поменялись. */
function listed<T extends { name: string }>(entries: T[], mtime: (e: T) => number): { list: T[]; signature: string } {
  const list = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return { list, signature: list.map((e) => `${e.name}:${mtime(e)}`).join('|') };
}

/**
 * Порт панели мониторинга. Дашборды и профили фич читаются из файлов и перечитываются, как только меняется набор
 * файлов или их время изменения, поэтому правка YAML руками видна без перезапуска. Запросы к логам уходят в
 * переданный источник.
 */
export function createMonitorPort(o: MonitorPortOptions): MonitorPort {
  let signature = '';
  let loaded: { dashboards: Dashboard[]; errors: DashboardError[] } = { dashboards: [], errors: [] };
  let featureSignature = '';
  let attemptSignature = '';
  let attemptLoaded: { profile: AttemptProfile | null; error: string | null } = { profile: null, error: null };
  let featuresLoaded: { features: FeatureProfile[]; errors: DashboardError[] } = { features: [], errors: [] };
  const logs = 'run' in o.logs ? o.logs : null;
  const unavailable = 'unavailable' in o.logs ? o.logs.unavailable : null;

  const files = (): { folder: string; file: string; mtime: number }[] => {
    if (!existsSync(o.dir)) return [];
    return readdirSync(o.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => ({ folder: e.name, file: join(o.dir, e.name, FILE) }))
      .filter((f) => existsSync(f.file))
      .map((f) => ({ ...f, mtime: statSync(f.file).mtimeMs }))
      .sort((a, b) => a.folder.localeCompare(b.folder));
  };

  return {
    services: () => o.profile?.services ?? [],

    dashboards() {
      const list = files();
      const next = list.map((f) => `${f.folder}:${f.mtime}`).join('|');
      if (next === signature) return loaded;
      const dashboards: Dashboard[] = [];
      const errors: DashboardError[] = [];
      for (const f of list) {
        try {
          dashboards.push(readDashboard(f.file, f.folder, o.profile));
        } catch (e) {
          errors.push({ file: `dashboards/${f.folder}/${FILE}`, message: e instanceof Error ? e.message : String(e) });
        }
      }
      signature = next;
      loaded = { dashboards, errors };
      return loaded;
    },

    validate: (source) => checkDashboard(source, o.profile),

    features() {
      const dir = o.features;
      if (!dir || !existsSync(dir)) return { features: [], errors: [] };
      const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.yaml') && !e.name.startsWith('_') && !e.name.startsWith('.'));
      const { list, signature: next } = listed(entries, (e) => statSync(join(dir, e.name)).mtimeMs);
      if (next === featureSignature) return featuresLoaded;
      const features: FeatureProfile[] = [];
      const errors: DashboardError[] = [];
      for (const e of list) {
        const { feature, errors: problems } = checkFeature(readFileSync(join(dir, e.name), 'utf8'), o.profile);
        const id = e.name.replace(/\.yaml$/, '');
        if (feature && feature.id === id) features.push(feature);
        else errors.push({ file: `features/${e.name}`, message: feature ? `id ${feature.id} не совпадает с именем файла ${id}` : problems.join('; ') });
      }
      featureSignature = next;
      featuresLoaded = { features, errors };
      return featuresLoaded;
    },

    validateFeature: (source) => checkFeature(source, o.profile),

    validateAttempt: (source) => checkAttempt(source, o.profile),

    async saveAttempt(source) {
      const { attempt, errors } = checkAttempt(source, o.profile);
      if (!attempt) throw new Error(`Профиль пути не прошел проверку: ${errors.join('; ')}`);
      if (!o.attempt) throw new Error('Файл профиля пути пакета команды не задан');
      writeFileSync(o.attempt, source.endsWith('\n') ? source : `${source}\n`);
      return { attempt, file: o.attempt };
    },

    readSource(target) {
      const file = target.kind === 'dashboard' ? join(o.dir, target.id, FILE) : target.kind === 'feature' ? (o.features ? join(o.features, `${target.id}.yaml`) : null) : (o.attempt ?? null);
      return file && existsSync(file) ? readFileSync(file, 'utf8') : null;
    },

    attempt() {
      const file = o.attempt;
      if (!file || !existsSync(file)) return { profile: null, error: null };
      const next = String(statSync(file).mtimeMs);
      if (next === attemptSignature) return attemptLoaded;
      const { attempt, errors } = checkAttempt(readFileSync(file, 'utf8'), o.profile);
      attemptSignature = next;
      attemptLoaded = { profile: attempt, error: attempt ? null : `attempt.yaml: ${errors.join('; ')}` };
      return attemptLoaded;
    },

    async saveFeature(source) {
      const { feature, errors } = checkFeature(source, o.profile);
      if (!feature) throw new Error(`Профиль фичи не прошел проверку: ${errors.join('; ')}`);
      if (!o.features) throw new Error('Папка профилей фич пакета команды не задана');
      mkdirSync(o.features, { recursive: true });
      const file = join(o.features, `${feature.id}.yaml`);
      writeFileSync(file, source.endsWith('\n') ? source : `${source}\n`);
      return { feature, file };
    },

    async save(source) {
      const { dashboard, errors } = checkDashboard(source, o.profile);
      if (!dashboard) throw new Error(`Дашборд не прошел проверку: ${errors.join('; ')}`);
      const folder = join(o.dir, dashboard.id);
      mkdirSync(folder, { recursive: true });
      const file = join(folder, FILE);
      // Файл пишется как его написали, с комментариями: его потом правят руками.
      writeFileSync(file, source.endsWith('\n') ? source : `${source}\n`);
      return { dashboard, file };
    },

    async run(requests): Promise<LogResult[]> {
      if (logs) return logs.run(requests);
      return requests.map(() => ({ kind: 'error', message: unavailable ?? 'Логи прода не настроены' }));
    },

    stats: () => (logs ? logs.stats() : { ...IDLE, lastError: unavailable }),
  };
}
