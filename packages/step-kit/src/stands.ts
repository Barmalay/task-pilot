import type { Contour, RepoProfile, StandProfile } from './profiles.ts';
import type { ProbeResult } from './types.ts';

/** Слово prod в имени окружения - прод всегда, какие бы еще имена прода контур ни назвал в prodLike. */
const PROD = /prod/i;

/** Похоже ли имя окружения или namespace на прод: слово prod или имена прода контура. */
export function prodLike(contour: Pick<Contour, 'prodLike'> | undefined, name: string): boolean {
  return PROD.test(name) || (!!contour?.prodLike && new RegExp(contour.prodLike, 'i').test(name));
}

/** Подходит ли имя окружения под стенд контура по умолчанию (defaultStand); без правила - нет. */
export function defaultStandLike(contour: Pick<Contour, 'defaultStand'> | undefined, name: string): boolean {
  return !!contour?.defaultStand && new RegExp(contour.defaultStand, 'i').test(name);
}

/** Окружение проекта деплоя в Bamboo: его id и имя. */
export interface BambooEnvRef {
  envId: number;
  envName: string;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Стенды контура по правилу его профиля и окружениям проектов деплоя его репозиториев (envs по id репозитория): стенд -
 * окружение, чье имя подходит под правило, и у каждого репозитория на нем свое окружение. Похожее на прод или
 * запрещенное в контуре окружение стендом не становится, даже если подходит под правило. Первыми идут стенды по умолчанию
 * (defaultStand контура), дальше по имени. Без правила стендов нет.
 */
export function standsFromBamboo(contour: Contour, envs: Record<string, BambooEnvRef[]>): StandProfile[] {
  const rule = contour.stands;
  if (!rule) return [];
  const include = new RegExp(rule.include);
  const found = new Map<string, Record<string, number>>();
  for (const [repoId, list] of Object.entries(envs)) {
    for (const e of list) {
      if (!include.test(e.envName) || prodLike(contour, e.envName) || contour.forbiddenBambooEnvIds.includes(e.envId)) continue;
      found.set(e.envName, { ...found.get(e.envName), [repoId]: e.envId });
    }
  }
  const ids = new Set<string>();
  const host = (namespace: string) => (rule.host ? namespace.replace(new RegExp(rule.host.from), rule.host.to) : namespace);
  return [...found.keys()]
    .sort((a, b) => Number(!defaultStandLike(contour, a)) - Number(!defaultStandLike(contour, b)) || byName(a, b))
    .map((name): StandProfile => {
      const id = `${rule.idPrefix}${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`;
      if (ids.has(id)) throw new Error(`Окружения Bamboo контура ${contour.id} дают один и тот же id стенда ${id}`);
      ids.add(id);
      const namespace = name.toLowerCase();
      const serviceUrl = rule.serviceUrl?.replaceAll('{host}', host(namespace));
      return { id, title: name, contour: contour.id, ...(serviceUrl ? { serviceUrl } : {}), namespace, bambooEnv: name, bambooEnvIds: found.get(name)!, logs: rule.logs, deployable: true, notes: rule.notes[name] ?? [] };
    });
}

/** Все окружения стенда в Bamboo: одно на контур или по одному на репозиторий. */
export function standEnvIds(stand: StandProfile): number[] {
  if (stand.bambooEnvIds) return Object.values(stand.bambooEnvIds);
  return stand.bambooEnvId === undefined ? [] : [stand.bambooEnvId];
}

/** Окружение стенда в проекте деплоя репозитория; null - этот репозиторий на стенд не деплоится. */
export function standEnvId(stand: StandProfile, repoId: string): number | null {
  if (stand.bambooEnvIds) return stand.bambooEnvIds[repoId] ?? null;
  return stand.bambooEnvId ?? null;
}

/**
 * Причина, по которой на стенд нельзя деплоить, или null. С repoId проверяется окружение стенда в проекте деплоя
 * этого репозитория, без него - все окружения стенда. Защита многослойная: флаг профиля, похожесть на прод по имени
 * и запрет окружения в контуре.
 */
export function deployBlockReason(stand: StandProfile, contour: Contour | undefined, repoId?: string): string | null {
  if (!stand.deployable) return `Стенд ${stand.title} выключен для деплоя в профиле`;
  if (prodLike(contour, stand.namespace) || prodLike(contour, stand.bambooEnv)) return `Стенд ${stand.title} похож на прод, деплой запрещен`;
  if (!contour) return `Для стенда ${stand.title} не найден контур ${stand.contour}`;
  const own = repoId === undefined ? null : standEnvId(stand, repoId);
  if (repoId !== undefined && own === null) return `У стенда ${stand.title} нет окружения в проекте деплоя ${repoId}`;
  const forbidden = (own === null ? standEnvIds(stand) : [own]).find((id) => contour.forbiddenBambooEnvIds.includes(id));
  if (forbidden !== undefined) return `Окружение ${stand.bambooEnv} (${forbidden}) запрещено для деплоя в контуре ${contour.id}`;
  return null;
}

/**
 * Тег образа, собранного Bamboo, по схеме контура (builds): ключ сборки ветки - это ключ плана, номер ветки плана и
 * номер сборки, ключ сборки самого плана - ключ плана и номер сборки. По схеме 1.0.{build}-{branch} и 1.0.{build}-master
 * для плана BUILDS-P сборка BUILDS-P246-4 дает 1.0.4-246, а сборка BUILDS-P-273 - 1.0.273-master. null - ключ сборки
 * не от этого плана или у контура нет схемы.
 */
export function imageTag(plan: string, buildKey: string, builds: Contour['builds']): string | null {
  if (!builds) return null;
  const m = /^(.+)-(\d+)$/.exec(buildKey);
  if (!m) return null;
  const [, owner = '', build = ''] = m;
  if (owner === plan) return builds.masterTag.replaceAll('{build}', build);
  const branch = owner.startsWith(plan) ? owner.slice(plan.length) : '';
  return /^\d+$/.test(branch) ? builds.branchTag.replaceAll('{build}', build).replaceAll('{branch}', branch) : null;
}

/** Что известно о релизе по его имени: ветка плана и задача. */
export interface ReleaseInfo {
  /** Ветка плана, например feature-TEAM-2799 или master. */
  branch: string;
  /** Задача из имени релиза, например TEAM-2799; null у релизов master. */
  task: string | null;
}

/**
 * Разбирает имя релиза Bamboo: релиз основной ветки по masterRelease контура (например release-273) - master,
 * feature-TEAM-2799-4 - четвертый релиз ветки feature-TEAM-2799 задачи TEAM-2799. У релиза ветки последний номер
 * отбрасывается.
 */
export function releaseInfo(name: string, builds?: Contour['builds']): ReleaseInfo {
  if (builds?.masterRelease && new RegExp(builds.masterRelease).test(name)) return { branch: 'master', task: null };
  const branch = name.replace(/-\d+$/, '');
  return { branch, task: /[A-Z][A-Z0-9_]+-\d+/.exec(branch)?.[0] ?? null };
}

/** Адрес проверки сервиса репозитория на стенде: адрес сервиса плюс путь здоровья; null - адреса сервисов у стенда нет. */
export function serviceCheckUrl(stand: StandProfile, repo: Pick<RepoProfile, 'id' | 'health'>): string | null {
  return stand.serviceUrl ? `${stand.serviceUrl.replaceAll('{service}', repo.id).replace(/\/+$/, '')}${repo.health ?? '/'}` : null;
}

/**
 * Отвечает ли по адресу проверки сам сервис этого стенда: среда из заголовка serviceHeader контура - namespace стенда, а
 * у сервиса с путем здоровья еще и статус 200. Адрес сервиса на тестовом стенде, где его нет, отвечает с соседнего.
 */
export function serviceAnswers(stand: StandProfile, repo: Pick<RepoProfile, 'health'>, r: ProbeResult): boolean {
  return r.environment === stand.namespace && (repo.health ? r.status === 200 : r.status > 0);
}

/**
 * Адрес проверки живости стенда: url стенда и путь health, где {realm} - realm стенда (у стендов Keycloak это его
 * well-known). Отвечает 200, когда стенд поднялся; null - у стенда нет url или пути проверки.
 */
export function standHealthUrl(stand: StandProfile): string | null {
  return stand.url && stand.health ? `${stand.url.replace(/\/$/, '')}${stand.health.replaceAll('{realm}', stand.realm ?? '')}` : null;
}
