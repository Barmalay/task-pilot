import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  contourSchema,
  formatZodError,
  isJavaBuild,
  jiraConfigSchema,
  lintProfileSchema,
  logSourcesSchema,
  monitorProfileSchema,
  personalProfileSchema,
  repoProfileSchema,
  standProfileSchema,
  teamManifestSchema,
  type Contour,
  type JiraConfig,
  type LintProfile,
  type LogSource,
  type MonitorProfile,
  type PersonalProfile,
  type RepoProfile,
  type StandProfile,
  type StepTeam,
  type TeamManifest,
  type TextStyle,
} from '@task-pilot/step-kit';
import { NO_STYLE } from '@task-pilot/step-kit';

/** Корень проекта task-pilot. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Учебная команда в репозитории Task Pilot: пакет для демо, смоука, эталонов и тестов. */
export const DEMO_TEAM = join(ROOT, 'examples', 'demo');

/** Раскрывает ~ в начале пути. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** Путь для людей: внутри корня Task Pilot - от корня, в домашней папке - через ~. */
export function shortPath(path: string, root: string = ROOT): string {
  const rel = relative(root, path);
  if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) return rel;
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
}

/** Запуск stdio MCP-сервера так, как он описан в ~/.claude.json. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Все профили: репозитории, стенды, контуры, доска Jira и линтер текстов. */
export interface Profiles {
  repos: RepoProfile[];
  stands: StandProfile[];
  contours: Contour[];
  jira: JiraConfig;
  lint: LintProfile;
  /** Источники логов стендов по id. */
  logs: Record<string, LogSource>;
  /** Панель мониторинга прода: источник логов и сервисы; null - monitor.yaml нет ни в одном слое. */
  monitor: MonitorProfile | null;
}

/** Пакет команды после загрузки: папка, team.yaml и слой компании. */
export interface TeamConfig {
  id: string;
  title: string;
  /** Папка пакета: team.yaml, profiles, dashboards и plugin. */
  dir: string;
  /** Слой компании из team.yaml: папка company/<id> репозитория Task Pilot; null - слоя компании у команды нет. */
  company: { id: string; dir: string } | null;
  manifest: TeamManifest;
}

/** Слой профилей: папка и подпись для ошибок. Слои идут снизу вверх: компания, затем команда. */
export interface ProfileLayer {
  label: string;
  dir: string;
}

/** Конфигурация сервера. */
export interface AppConfig {
  root: string;
  stepsDir: string;
  pipelinesDir: string;
  /** Пакет команды: профили, дашборды и плагин агентов команды. */
  team: TeamConfig;
  /** Слои профилей по порядку: слой компании, если он есть, и профили команды. */
  layers: ProfileLayer[];
  /** Дашборды панели мониторинга пакета команды: dashboards/<id>/dashboard.yaml. */
  dashboardsDir: string;
  /** Профили фич входа пакета команды: features/<id>.yaml. */
  featuresDir: string;
  /** Профиль пути одной попытки входа пакета команды: attempt.yaml. */
  attemptFile: string;
  dataDir: string;
  /** Резервные копии базы, раз в сутки, последние семь; null - копии не делаются (демо). */
  backupsDir: string | null;
  host: string;
  port: number;
  profiles: Profiles;
  /** MCP-серверы из ~/.claude.json: доступ к интеграциям "как обычно". */
  mcpServers: Record<string, McpServerConfig>;
  /** Значения токенов из ~/.claude.json: маскируются во всех логах и событиях. Токены с экрана "Интеграции" добавляются при запуске. */
  secrets: string[];
  /** Файл личных настроек: логин Jira, JDK, пути репозиториев на этой машине, пакет команды. */
  personalFile: string;
  /** Личные настройки так, как они применены: у чужого пакета (учебной команды) без путей и репозитория по умолчанию. */
  personal: PersonalProfile;
  /** Личный стиль публикуемых текстов из личных настроек. */
  style: TextStyle;
  /** CLI Claude для агентных шагов. */
  claudeCli: string;
  /**
   * Папка аккаунтов Claude со входом через браузер (экран "Интеграции"): у каждого своя папка CLAUDE_CONFIG_DIR.
   * Она вне .data: скиллы агент читает по пути внутри папки аккаунта, а .data агенту читать нельзя.
   */
  claudeAccountsDir: string;
  /** Сколько ask_owner ждет ответа владельца. */
  askTimeoutMs: number;
  /** Как часто наблюдатель проверяет PR, задачи Jira и медленные ожидания прогонов (ручной деплой, ветку). */
  watchMs: number;
  /** Как часто наблюдатель проверяет сборки, деплои, выкатку и связанные прогоны, которых ждут шаги. */
  watchFastMs: number;
  /**
   * Плагин Claude Code со скиллами агентов, по умолчанию папка plugin пакета команды: агенты получают его флагом
   * --plugin-dir, шаги берут скиллы из его папки skills, разбор прогона правит их там же.
   */
  pluginDir: string;
}

/** Папка скиллов плагина агентов. */
export function pluginSkills(pluginDir: string): string {
  return join(pluginDir, 'skills');
}

/**
 * Правила текстов команды для агентов: rules.md пакета, нет файла - пусто. Читаются при каждом шаге, поэтому правка
 * действует без перезапуска.
 */
export function teamRules(teamDir: string): string {
  const file = join(teamDir, 'rules.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Пакет команды для шагов: скиллы теста на стенде и вики из team.yaml - папки в плагине агентов. */
export function stepTeamOf(config: Pick<AppConfig, 'team' | 'pluginDir'>): StepTeam {
  const skills = pluginSkills(config.pluginDir);
  const m = config.team.manifest;
  return {
    id: config.team.id,
    title: config.team.title,
    qaSkill: m.qa ? join(skills, m.qa.skill) : null,
    wikiSkill: m.wiki ? join(skills, m.wiki.skill) : null,
    wikiSpace: m.wiki?.space ?? null,
  };
}

function readYaml(file: string): unknown {
  return parse(readFileSync(file, 'utf8'));
}

function loadDir<T>(layer: ProfileLayer, sub: string, schema: z.ZodType<T>, what: string): T[] {
  const dir = join(layer.dir, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const r = schema.safeParse(readYaml(join(dir, f)));
      if (!r.success) throw new Error(`${what} ${layer.label}/${sub}/${f}: ${formatZodError(r.error)}`);
      return r.data;
    });
}

/** Стенды: файл описывает один стенд или список стендов контура. */
function loadStands(layer: ProfileLayer): StandProfile[] {
  const dir = join(layer.dir, 'stands');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .flatMap((f) => {
      const raw = readYaml(join(dir, f));
      const list: unknown[] = Array.isArray(raw) ? raw : [raw];
      return list.map((item, i) => {
        const r = standProfileSchema.safeParse(item);
        if (!r.success) throw new Error(`Профиль стенда ${layer.label}/stands/${f}${Array.isArray(raw) ? ` (${i + 1}-й в списке)` : ''}: ${formatZodError(r.error)}`);
        return r.data;
      });
    });
}

/** Файл слоя, если он есть: разобранный YAML (пустой файл - пустой объект) и подпись. */
function layerFile(layer: ProfileLayer, name: string): { label: string; value: unknown } | null {
  const file = join(layer.dir, name);
  return existsSync(file) ? { label: `${layer.label}/${name}`, value: readYaml(file) ?? {} } : null;
}

/** Одинаковые id в списке профилей слоев - ошибка: профиль одного слоя не подменяет молча профиль другого. */
function unique<T extends { id: string }>(items: T[], what: string): T[] {
  const seen = new Set<string>();
  for (const x of items) {
    if (seen.has(x.id)) throw new Error(`${what} ${x.id} описан дважды`);
    seen.add(x.id);
  }
  return items;
}

/** Порядок профилей слоев - по id, как у файлов одной папки: список репозиториев и контуров не зависит от того, в каком слое профиль. */
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Слияние объектов слоев по ключам верхнего уровня: ключ верхнего слоя (команды) заменяет ключ нижнего (компании). */
function mergeKeys(parts: { label: string; value: unknown }[], what: string): Record<string, unknown> | null {
  if (!parts.length) return null;
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    if (!p.value || typeof p.value !== 'object' || Array.isArray(p.value)) throw new Error(`${what} ${p.label}: ждется объект`);
    Object.assign(out, p.value);
  }
  return out;
}

/** Личные настройки по умолчанию: файла нет, все берется из профилей слоев. */
export const NO_PERSONAL: PersonalProfile = { repos: {}, lintNames: [] };

/** Читает личные настройки (~/.task-pilot/profile.yaml); нет файла - настроек нет. */
export function loadPersonal(file: string): PersonalProfile {
  if (!existsSync(file)) return NO_PERSONAL;
  const r = personalProfileSchema.safeParse(readYaml(file) ?? {});
  if (!r.success) throw new Error(`Личные настройки ${file}: ${formatZodError(r.error)}`);
  return r.data;
}

/**
 * Пакет команды по пути из TASK_PILOT_TEAM или личных настроек: его team.yaml и слой компании, который он называет.
 * Без пакета Task Pilot не работает: профилей репозиториев и доски нет нигде, кроме него.
 */
export function loadTeam(root: string, path: string | undefined): TeamConfig {
  if (!path) {
    throw new Error(`Не задан пакет команды: укажите team в личных настройках ~/.task-pilot/profile.yaml или переменную TASK_PILOT_TEAM (пример пакета - ${shortPath(join(root, 'examples', 'demo'), root)})`);
  }
  const dir = resolve(expandHome(path));
  const file = join(dir, 'team.yaml');
  if (!existsSync(file)) throw new Error(`Пакет команды ${shortPath(dir, root)}: нет team.yaml`);
  const r = teamManifestSchema.safeParse(readYaml(file) ?? {});
  if (!r.success) throw new Error(`Пакет команды ${shortPath(file, root)}: ${formatZodError(r.error)}`);
  const m = r.data;
  const company = m.company ? { id: m.company, dir: join(root, 'company', m.company) } : null;
  if (company && !existsSync(company.dir)) throw new Error(`Пакет команды ${m.id}: слоя компании ${company.id} нет, ждется папка ${shortPath(company.dir, root)}`);
  return { id: m.id, title: m.title, dir, company, manifest: m };
}

/** Слои профилей пакета команды: слой компании, если он есть, и папка profiles пакета. */
export function teamLayers(team: TeamConfig, root: string = ROOT): ProfileLayer[] {
  return [
    ...(team.company ? [{ label: shortPath(team.company.dir, root), dir: team.company.dir }] : []),
    { label: shortPath(join(team.dir, 'profiles'), root), dir: join(team.dir, 'profiles') },
  ];
}

/**
 * Накладывает личные настройки на профили слоев: логин Jira, JDK для сборок Java без своего, пути репозиториев
 * на этой машине, репозиторий по умолчанию и дополнительные имена для линтера.
 */
export function applyPersonal(profiles: Profiles, personal: PersonalProfile): Profiles {
  for (const id of Object.keys(personal.repos)) {
    if (!profiles.repos.some((r) => r.id === id)) throw new Error(`Личные настройки: неизвестный репозиторий ${id}`);
  }
  if (personal.defaultRepo && !profiles.repos.some((r) => r.id === personal.defaultRepo)) {
    throw new Error(`Личные настройки: неизвестный репозиторий по умолчанию ${personal.defaultRepo}`);
  }
  const javaHome = personal.javaHome && expandHome(personal.javaHome);
  const repos = profiles.repos.map((r): RepoProfile => {
    const own = personal.repos[r.id];
    return {
      ...r,
      path: own?.path ? expandHome(own.path) : r.path,
      worktreesDir: own?.worktreesDir ? expandHome(own.worktreesDir) : r.worktreesDir,
      default: personal.defaultRepo ? r.id === personal.defaultRepo : r.default,
      build: r.build && { ...r.build, javaHome: r.build.javaHome ?? (isJavaBuild(r.build.command) ? javaHome : undefined) },
    };
  });
  return {
    ...profiles,
    repos,
    jira: personal.me ? { ...profiles.jira, me: personal.me } : profiles.jira,
    lint: { ...profiles.lint, names: [...new Set([...profiles.lint.names, ...personal.lintNames])] },
  };
}

/**
 * Загружает и сверяет профили слоев (папка или список папок снизу вверх) и накладывает на них личные настройки.
 * Строка - один слой, так профили читают тесты и проверки одной папки.
 */
export function loadProfiles(layers: string | ProfileLayer[], personal: PersonalProfile = NO_PERSONAL): Profiles {
  return applyPersonal(loadLayers(typeof layers === 'string' ? [{ label: shortPath(layers), dir: layers }] : layers), personal);
}

/**
 * Профили слоев без личных настроек. Контуры, репозитории, стенды и источники логов слоев складываются, одинаковый id
 * в двух слоях - ошибка; в jira.yaml и monitor.yaml ключи верхнего слоя заменяют ключи нижнего, списки lint.yaml
 * объединяются. Ссылки между профилями сверяются после слияния: репозиторий команды может ссылаться на контур и
 * репозиторий деплоя компании.
 */
function loadLayers(layers: ProfileLayer[]): Profiles {
  const where = layers.map((l) => l.label).join(', ');
  const contours = unique(
    layers.flatMap((l) => loadDir(l, 'contours', contourSchema, 'Профиль контура')),
    'Контур',
  ).sort(byId);
  const repos = unique(
    layers.flatMap((l) => loadDir(l, 'repos', repoProfileSchema, 'Профиль репозитория')),
    'Репозиторий',
  )
    .sort(byId)
    .map((r) => ({
      ...r,
      path: expandHome(r.path),
      worktreesDir: expandHome(r.worktreesDir),
      build: r.build && { ...r.build, javaHome: r.build.javaHome && expandHome(r.build.javaHome) },
    }));
  const stands = unique(layers.flatMap(loadStands), 'Стенд');

  const jiraRaw = mergeKeys(layers.flatMap((l) => layerFile(l, 'jira.yaml') ?? []), 'Профиль доски');
  if (!jiraRaw) throw new Error(`Нет профиля доски jira.yaml ни в одном слое: ${where}`);
  const jira = jiraConfigSchema.safeParse(jiraRaw);
  if (!jira.success) throw new Error(`Профиль доски (jira.yaml: ${where}): ${formatZodError(jira.error)}`);

  const lint: LintProfile = { names: [], allowEmails: [] };
  for (const f of layers.flatMap((l) => layerFile(l, 'lint.yaml') ?? [])) {
    const r = lintProfileSchema.safeParse(f.value);
    if (!r.success) throw new Error(`${f.label}: ${formatZodError(r.error)}`);
    lint.names = [...new Set([...lint.names, ...r.data.names])];
    lint.allowEmails = [...new Set([...lint.allowEmails, ...r.data.allowEmails])];
  }

  const logs: Record<string, LogSource> = {};
  for (const f of layers.flatMap((l) => layerFile(l, 'logs.yaml') ?? [])) {
    const r = logSourcesSchema.safeParse(f.value);
    if (!r.success) throw new Error(`${f.label}: ${formatZodError(r.error)}`);
    for (const [id, source] of Object.entries(r.data)) {
      if (logs[id]) throw new Error(`Источник логов ${id} описан дважды`);
      logs[id] = source;
    }
  }

  const monitorRaw = mergeKeys(layers.flatMap((l) => layerFile(l, 'monitor.yaml') ?? []), 'Панель мониторинга');
  const monitor = monitorRaw ? monitorProfileSchema.safeParse(monitorRaw) : null;
  if (monitor && !monitor.success) throw new Error(`Панель мониторинга (monitor.yaml: ${where}): ${formatZodError(monitor.error)}`);

  for (const s of stands) if (!logs[s.logs]) throw new Error(`Профиль стенда ${s.id}: неизвестный источник логов ${s.logs}, его нет в logs.yaml слоев`);
  // Ответ сервиса по адресу на стенде засчитывается, только когда заголовок среды совпал с namespace стенда.
  const header = (id: string) => contours.find((c) => c.id === id)?.serviceHeader;
  for (const c of contours) {
    if (c.stands?.serviceUrl && !c.serviceHeader) throw new Error(`Профиль контура ${c.id}: у адреса сервисов на стендах нужен serviceHeader - заголовок со средой сервиса`);
  }
  for (const s of stands) {
    if (s.serviceUrl && !header(s.contour)) throw new Error(`Профиль стенда ${s.id}: у адреса сервисов нужен serviceHeader контура ${s.contour} - заголовок со средой сервиса`);
  }
  for (const c of contours) {
    if (c.stands && !logs[c.stands.logs]) throw new Error(`Профиль контура ${c.id}: неизвестный источник логов стендов ${c.stands.logs}, его нет в logs.yaml слоев`);
  }
  for (const r of repos) {
    const kk = r.qa?.keycloak;
    if (kk && !stands.some((s) => s.id === kk.stand && s.url && s.realm)) {
      throw new Error(`Профиль репозитория ${r.id}: стенд Keycloak ${kk.stand} для теста не найден среди профилей стендов или у него нет адреса и realm`);
    }
  }
  const known = new Set(contours.map((c) => c.id));
  for (const r of repos) if (!known.has(r.contour)) throw new Error(`Профиль репозитория ${r.id}: неизвестный контур ${r.contour}`);
  for (const s of stands) if (!known.has(s.contour)) throw new Error(`Профиль стенда ${s.id}: неизвестный контур ${s.contour}`);
  for (const s of stands) {
    for (const repoId of Object.keys(s.bambooEnvIds ?? {})) {
      const repo = repos.find((r) => r.id === repoId);
      if (!repo) throw new Error(`Профиль стенда ${s.id}: неизвестный репозиторий ${repoId} в bambooEnvIds`);
      if (repo.contour !== s.contour) throw new Error(`Профиль стенда ${s.id}: репозиторий ${repoId} из контура ${repo.contour}, а стенд - из ${s.contour}`);
    }
  }
  for (const r of repos) {
    if (!r.deployRepo) continue;
    const deploy = repos.find((d) => d.id === r.deployRepo);
    if (!deploy) throw new Error(`Профиль репозитория ${r.id}: неизвестный репозиторий деплоя ${r.deployRepo}`);
    if (deploy.contour !== r.contour) throw new Error(`Профиль репозитория ${r.id}: репозиторий деплоя ${deploy.id} из контура ${deploy.contour}, а не ${r.contour}`);
  }
  if (!repos.length) throw new Error(`Нет ни одного профиля репозитория: ${where}`);
  const defaults = repos.filter((r) => r.default).map((r) => r.id);
  if (defaults.length > 1) throw new Error(`Репозиторий по умолчанию должен быть один, сейчас: ${defaults.join(', ')}`);
  return { repos, stands, contours, jira: jira.data, lint, logs, monitor: monitor?.data ?? null };
}

const SECRET_KEY = /TOKEN|KEY|PASSWORD|SECRET/i;

interface ClaudeJson {
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
}

/** Читает stdio MCP-серверы из ~/.claude.json и собирает значения секретов для маскирования. */
export function loadClaudeMcp(file: string): { servers: Record<string, McpServerConfig>; secrets: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const secrets: string[] = [];
  if (!existsSync(file)) return { servers, secrets };
  const json = JSON.parse(readFileSync(file, 'utf8')) as ClaudeJson;
  for (const [name, server] of Object.entries(json.mcpServers ?? {})) {
    if (!server.command) continue;
    const env = server.env ?? {};
    servers[name] = { command: server.command, args: server.args ?? [], env };
    for (const [key, value] of Object.entries(env)) {
      if (SECRET_KEY.test(key) && typeof value === 'string' && value.length >= 8) secrets.push(value);
    }
  }
  return { servers, secrets };
}

/**
 * Собирает конфигурацию из окружения, личных настроек, пакета команды, слоя компании и ~/.claude.json. Пакет команды
 * задает TASK_PILOT_TEAM или поле team личных настроек. otherTeam - пакет не тот, что в личных настройках (учебная
 * команда демо): пути репозиториев и репозиторий по умолчанию из личных настроек относятся к своему пакету и к этому
 * не применяются.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { otherTeam?: boolean } = {}): AppConfig {
  const root = env.TASK_PILOT_ROOT ?? ROOT;
  const { servers, secrets } = loadClaudeMcp(env.TASK_PILOT_CLAUDE_JSON ?? join(homedir(), '.claude.json'));
  const personalFile = expandHome(env.TASK_PILOT_PERSONAL ?? '~/.task-pilot/profile.yaml');
  const own = loadPersonal(personalFile);
  const personal: PersonalProfile = opts.otherTeam ? { ...own, repos: {}, defaultRepo: undefined } : own;
  const team = loadTeam(root, env.TASK_PILOT_TEAM ?? personal.team);
  const layers = teamLayers(team, root);
  const profiles = loadProfiles(layers, personal);
  const qaLogs = team.manifest.qa?.logs;
  if (qaLogs && !profiles.logs[qaLogs.source]) throw new Error(`Пакет команды ${team.id}: источника логов ${qaLogs.source} из qa.logs нет в logs.yaml слоев`);
  const dataDir = env.TASK_PILOT_DATA ?? join(root, '.data');
  return {
    root,
    stepsDir: join(root, 'steps'),
    pipelinesDir: join(root, 'pipelines'),
    team,
    layers,
    dashboardsDir: join(team.dir, 'dashboards'),
    featuresDir: join(team.dir, 'features'),
    attemptFile: join(team.dir, 'attempt.yaml'),
    dataDir,
    // Копии внутри служебной папки: агентам ее читать нельзя, а в копиях те же данные, что в базе.
    backupsDir: join(dataDir, 'backups'),
    host: '127.0.0.1',
    port: Number(env.TASK_PILOT_PORT ?? 5176),
    profiles,
    personalFile,
    personal,
    style: { ...NO_STYLE, ...own.style },
    mcpServers: servers,
    secrets,
    claudeCli: expandHome(env.TASK_PILOT_CLAUDE ?? '~/.local/bin/claude'),
    claudeAccountsDir: expandHome(env.TASK_PILOT_CLAUDE_ACCOUNTS ?? '~/.task-pilot/claude'),
    askTimeoutMs: Number(env.TASK_PILOT_ASK_TIMEOUT_MS ?? 55 * 60_000),
    watchMs: Number(env.TASK_PILOT_WATCH_MS ?? 5 * 60_000),
    watchFastMs: Number(env.TASK_PILOT_WATCH_FAST_MS ?? 30_000),
    pluginDir: expandHome(env.TASK_PILOT_PLUGIN ?? join(team.dir, 'plugin')),
  };
}
