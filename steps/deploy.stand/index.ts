import { existsSync } from 'node:fs';
import type { BambooPort, Build, Contour, DeployedBuild, DeployVersion, EnvironmentStatus, PodImage, ProbeResult, Release, RolloutProbe, StandProfile, StepContext, StepModule } from '../../packages/step-kit/src/index.ts';
import { deployBlockReason, releaseInfo, serviceAnswers, serviceCheckUrl, standEnvId, standHealthUrl, StepWaiting, timed } from '../../packages/step-kit/src/index.ts';
import { customizeOnly } from '../_shared/ansible.ts';
import { minutes, WAIT_MS } from '../_shared/wait.ts';

/**
 * Откуда деплой возьмет конфиг k8s-ansible. Скрипт деплоя сам ищет в k8s-ansible ветку с именем ветки
 * релиза и берет ее, а без такой ветки берет master; ветку с другим именем задает только Customize Deploy. В контуре,
 * чей деплой ветку задачи сам не берет (`deploy.ansibleBranch: customize` профиля контура), любая ветка задачи идет
 * через Customize Deploy.
 */
interface ConfigSource {
  /** Ветка k8s-ansible конфига; null - заранее не узнать: у репозитория нет deployRepo. */
  branch: string | null;
  /** Ветку задает владелец в Customize Deploy: скрипт деплоя сам ее не найдет. */
  manual: boolean;
  /** Почему именно эта ветка: показывается на подтверждении. */
  reason: string;
}

interface Inspection {
  stand: StandProfile;
  /** id контура: по нему наблюдатель спрашивает Bamboo, пока шаг ждет деплоя. */
  contour: string;
  /** Окружение стенда в проекте деплоя репозитория. */
  envId: number;
  bamboo: BambooPort;
  project: number;
  build: Build;
  /** Релиз этой сборки, если он уже есть. */
  version: DeployVersion | null;
  versionName: string;
  /** Последний деплой на окружение стенда. */
  current: EnvironmentStatus | undefined;
  /** Откуда деплой возьмет конфиг k8s-ansible. */
  config: ConfigSource;
  /** Имя контейнера приложения в k8s: по нему ищутся поды в Kibana. */
  app: string;
}

const BUSY = new Set(['QUEUED', 'PENDING', 'IN_PROGRESS']);

/** Строки лога деплоя, похожие на ошибку. Сбои отправки уведомлений в Grafana и Slack - шум, на этапе 0 они есть почти в каждом деплое. */
function errorLines(log: string[]): string[] {
  return log.filter((l) => /FAILED!|fatal:|ERROR|Exception/i.test(l) && !/Could not submit message to (Grafana|Slack)/i.test(l)).slice(-8);
}

/**
 * Ветка k8s-ansible, из которой шел деплой, по его логу; null - в логе этого не видно. Один скрипт деплоя
 * пишет ее строкой "Деплой выполняется из ветки k8s-ansible: <ветка>", другой клонирует k8s-ansible и после
 * хода клона (строки git вроде "Updating files") печатает текущую ветку, как git branch: "* <ветка>", а потом
 * начинается вывод ansible. Отсоединенный HEAD веткой не считается.
 */
export function ansibleBranchOf(log: string[]): string | null {
  for (const line of log) {
    const m = /Деплой выполняется из ветки k8s-ansible:\s*(\S+)/.exec(line);
    if (m) return m[1]!;
  }
  const clone = log.findIndex((l) => l.includes("Cloning into 'k8s-ansible'"));
  if (clone < 0) return null;
  for (const line of log.slice(clone + 1)) {
    const text = line.trim();
    if (/^(PLAY|TASK) \[/.test(text)) break;
    const m = /^\*\s+([^\s(]\S*)$/.exec(text);
    if (m) return m[1]!;
  }
  return null;
}

function environmentUrl(p: Inspection): string {
  return `${p.bamboo.url}/deploy/viewEnvironment.action?id=${p.envId}`;
}

/** Где владелец запускает Customize Deploy: страница формы из профиля контура, иначе окружение стенда. */
function customizeUrl(c: StepContext, p: Inspection, version: DeployVersion): string {
  const form = c.contour?.deploy?.customizeUrl;
  return form ? form.replaceAll('{envId}', String(p.envId)).replaceAll('{versionId}', String(version.id)) : environmentUrl(p);
}

/** Что сделать владельцу в Customize Deploy: где открыть форму и что в ней выбрать. */
function customizeText(c: StepContext, p: Inspection, version: DeployVersion): string {
  return c.contour?.deploy?.customizeUrl
    ? `откройте ${customizeUrl(c, p, version)}, выберите окружение ${p.stand.bambooEnv}, релиз ${version.name} и ветку k8s-ansible ${p.config.branch} и нажмите Deploy`
    : `откройте ${environmentUrl(p)}, выберите релиз ${version.name} и ветку ${p.config.branch} и нажмите Deploy`;
}

function resultUrl(p: Inspection, id: number): string {
  return `${p.bamboo.url}/deploy/viewDeploymentResult.action?deploymentResultId=${id}`;
}

/**
 * Стенд, на который можно деплоить сборку этого репозитория, с окружением стенда в его проекте деплоя, или ошибка с
 * причиной. Запрет проверяется по окружению именно этого репозитория: у сервисов со своими проектами
 * деплоя окружения свои.
 */
function standOf(c: StepContext): { stand: StandProfile; contour: Contour; envId: number } {
  const stand = c.stand;
  if (!stand) throw new Error('Выберите стенд в шапке прогона');
  const blocked = deployBlockReason(stand, c.contour, c.repo.id);
  if (blocked) throw new Error(blocked);
  if (stand.contour !== c.repo.contour || !c.contour) throw new Error(`Стенд ${stand.title} из контура ${stand.contour}, а репозиторий ${c.repo.title} - из контура ${c.repo.contour}`);
  const envId = standEnvId(stand, c.repo.id);
  if (envId === null) throw new Error(`У стенда ${stand.title} нет окружения в проекте деплоя ${c.repo.id}`);
  return { stand, contour: c.contour, envId };
}

/** Первая строка вывода git: причина сбоя для ленты. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? '';
}

async function resolveConfig(c: StepContext, build: Build): Promise<ConfigSource> {
  const own = c.get<string>('ansibleBranch') ?? null;
  const customize = customizeOnly(c.contour);
  const byForm = `деплой контура ${c.contour?.title ?? ''} берет ветку k8s-ansible задачи только из Customize Deploy`;
  if (own && customize) return { branch: own, manual: true, reason: byForm };
  if (own && own !== build.branch) return { branch: own, manual: true, reason: `ветка ${own} названа не как ветка релиза ${build.branch}, скрипт деплоя сам ее не найдет` };
  if (own) return { branch: own, manual: false, reason: 'скрипт деплоя найдет ее по имени ветки релиза' };
  const deploy = c.deployRepo;
  if (!deploy) return { branch: null, manual: false, reason: '' };
  if (build.branch === c.repo.baseBranch) return { branch: deploy.baseBranch, manual: false, reason: `релиз из ${build.branch}` };
  if (!existsSync(deploy.path)) {
    c.log(`Папки репозитория деплоя ${deploy.path} нет: из какой ветки k8s-ansible пойдет конфиг, заранее не узнать`);
    return { branch: null, manual: false, reason: '' };
  }
  const r = await c.ports.git.tryRun(deploy.path, ['ls-remote', '--heads', deploy.remote, `refs/heads/${build.branch}`]);
  if (r.code !== 0) {
    c.log(`Не удалось узнать, есть ли ветка ${build.branch} в k8s-ansible: ${firstLine(r.stderr) || `код ${r.code}`}`);
    return { branch: null, manual: false, reason: '' };
  }
  if (!r.stdout.trim()) return { branch: deploy.baseBranch, manual: false, reason: `ветки ${build.branch} в k8s-ansible нет` };
  return customize ? { branch: build.branch, manual: true, reason: byForm } : { branch: build.branch, manual: false, reason: 'скрипт деплоя найдет ее по имени ветки релиза' };
}

/** Откуда деплой возьмет конфиг; done, preview и run одного выполнения видят один ответ. */
async function configOf(c: StepContext, build: Build): Promise<ConfigSource> {
  const cached = c.scratch.get('config') as ConfigSource | undefined;
  if (cached) return cached;
  const config = await resolveConfig(c, build);
  c.scratch.set('config', config);
  return config;
}

async function inspect(c: StepContext): Promise<Inspection> {
  const { stand, contour, envId } = standOf(c);
  const project = c.repo.bamboo?.deploymentProject;
  if (!project) throw new Error(`В профиле репозитория ${c.repo.id} нет bamboo.deploymentProject`);
  const build = c.get<Build>('build');
  if (!build || build.key === 'dry-run') throw new Error('Нет сборки ветки: сначала нужен шаг "Сборка ветки"');
  const bamboo = c.ports.bamboo(contour);
  const [versions, envs] = await Promise.all([bamboo.versions(project, 100), bamboo.environments(project)]);
  const version = versions.find((v) => v.buildKey === build.key) ?? null;
  return {
    stand,
    contour: contour.id,
    envId,
    bamboo,
    project,
    build,
    version,
    versionName: version?.name ?? (await bamboo.nextVersionName(project, build.key)),
    current: envs.find((e) => e.envId === envId),
    config: await configOf(c, build),
    app: c.repo.id,
  };
}

/** Самый новый под приложения в namespace стенда по логам. */
async function newestPod(c: StepContext, p: Inspection): Promise<PodImage | undefined> {
  const pods = await c.ports.logs(p.stand.logs).pods(p.app, [p.stand.namespace], 30);
  return pods[p.stand.namespace]?.[0];
}

/** Релиз сборки: созданный заранее, созданный сейчас или созданный кем-то, пока шаг ждал подтверждения. */
async function releaseOf(c: StepContext, p: Inspection): Promise<DeployVersion> {
  if (p.version) return p.version;
  try {
    const created = await p.bamboo.createVersion(p.project, p.build.key, p.versionName);
    c.log(`Создан релиз ${created.name} из сборки ${p.build.key}`);
    return created;
  } catch (e) {
    const existing = (await p.bamboo.versions(p.project, 100)).find((v) => v.buildKey === p.build.key);
    if (existing) return existing;
    throw e;
  }
}

const releaseOut = (v: DeployVersion): Release => ({ id: v.id, name: v.name });

/**
 * Деплой релиза, который владелец запускает в Bamboo сам через Customize Deploy: нашелся деплой этого релиза,
 * начатый после since, - шаг идет за ним, иначе ждет, пока владелец нажмет Deploy.
 */
async function manualDeploy(c: StepContext, p: Inspection, version: DeployVersion, since: string): Promise<Record<string, unknown>> {
  const found = (await p.bamboo.environmentResults(p.envId, 5)).find(
    // Минута запаса на расхождение часов с Bamboo.
    (r) => r.versionId === version.id && r.startedAt !== null && Date.parse(r.startedAt) >= Date.parse(since) - 60_000,
  );
  if (found) return follow(c, p, version, found.id, new Date().toISOString());
  throw new StepWaiting(
    `Жду Customize Deploy ${version.name} на ${p.stand.title} с веткой k8s-ansible ${p.config.branch}: ${customizeUrl(c, p, version)}`,
    {
      kind: 'manual-deploy',
      contour: p.contour,
      envId: p.envId,
      versionId: version.id,
      ...timed(since, WAIT_MS.manualDeploy, `За ${minutes(WAIT_MS.manualDeploy)} минут деплой ${version.name} на ${p.stand.title} так и не запустили`),
    },
    { release: releaseOut(version) },
  );
}

/**
 * Деплой resultId: успешный - дальше проверка конфига и выкатки, неуспешный - ошибка с похожими на ошибку строками
 * его лога, еще идет - шаг ждет его окончания.
 */
async function follow(c: StepContext, p: Inspection, version: DeployVersion, resultId: number, since: string): Promise<Record<string, unknown>> {
  const r = await p.bamboo.deployResult(resultId, false);
  c.log(`Bamboo: деплой ${r.versionName ?? resultId}: ${r.lifeCycle}`);
  if (r.lifeCycle !== 'FINISHED' && r.lifeCycle !== 'NOT_BUILT') {
    throw new StepWaiting(
      `Жду деплой ${version.name} на ${p.stand.title}: ${r.lifeCycle}, ${resultUrl(p, resultId)}`,
      {
        kind: 'deploy',
        contour: p.contour,
        resultId,
        ...timed(since, WAIT_MS.deploy, `Деплой на ${p.stand.title} не закончился за ${minutes(WAIT_MS.deploy)} минут: ${resultUrl(p, resultId)}`),
      },
      { release: releaseOut(version) },
    );
  }
  if (r.state !== 'SUCCESS') {
    const lines = errorLines((await p.bamboo.deployResult(resultId, true)).log ?? []);
    throw new Error(`Деплой на ${p.stand.title} завершился с ${r.state}: ${resultUrl(p, resultId)}${lines.length ? `\n${lines.join('\n')}` : ''}`);
  }
  await checkConfig(c, p, resultId);
  return verify(c, p, version, resultId, new Date().toISOString());
}

/**
 * Сверяет ветку k8s-ansible деплоя с той, что была на подтверждении: иначе конфиг на стенде не тот,
 * который владелец одобрил. Для Customize Deploy это обычно значит, что в форме не выбрали ветку.
 */
async function checkConfig(c: StepContext, p: Inspection, resultId: number): Promise<void> {
  const used = ansibleBranchOf((await p.bamboo.deployResult(resultId, true)).log ?? []);
  const expected = p.config.branch;
  if (used === null) {
    c.log('В логе деплоя нет строки о ветке k8s-ansible: из какой ветки шел конфиг, проверить нечем');
  } else if (expected === null || used === expected) {
    c.log(`Конфиг деплоя из ветки k8s-ansible ${used}`);
  } else if (p.config.manual) {
    throw new Error(`Деплой на ${p.stand.title} прошел с конфигом из ветки k8s-ansible ${used}, а нужна ${expected}: повторите Customize Deploy с веткой ${expected}. ${resultUrl(p, resultId)}`);
  } else {
    throw new Error(`Деплой на ${p.stand.title} прошел с конфигом из ветки k8s-ansible ${used}, а на подтверждении была ${expected}: проверьте ветки k8s-ansible и повторите шаг. ${resultUrl(p, resultId)}`);
  }
}

/**
 * Адрес проверки ответа после выкатки: сам сервис на стенде, если у стенда есть адреса сервисов (тогда сверяется и
 * заголовок среды контура), иначе путь проверки самого стенда (health); null - проверять нечего.
 */
function checkOf(c: StepContext, stand: StandProfile): RolloutProbe | null {
  const service = serviceCheckUrl(stand, c.repo);
  if (service) return { url: service, service: true };
  const health = standHealthUrl(stand);
  return health ? { url: health, service: false } : null;
}

/** Чем кончилась проверка сервиса: не ответил, ответил другой стенд или вернул не тот статус. */
function probeText(stand: StandProfile, r: ProbeResult): string {
  if (r.status === 0) return 'не ответил';
  if (r.environment && r.environment !== stand.namespace) return `ответил со стенда ${r.environment}: сервиса на ${stand.title} нет`;
  return `вернул ${r.status}${r.environment ? '' : ' без заголовка среды'}`;
}

/** Хвост строки проверки выкатки на подтверждении: какой адрес спросят после деплоя. */
function checkText(check: RolloutProbe | null, stand: StandProfile): string {
  if (!check) return '';
  return check.service ? ` и ответ сервиса ${check.url} из окружения ${stand.namespace}` : ` и ответ ${check.url}`;
}

/**
 * Проверяет выкатку: в namespace стенда под с образом сборки, и отвечает сам сервис стенда или стенд. Выкатилось -
 * выходы шага, еще нет - шаг ждет выкатки; срок ожидания считается от since, окончания деплоя.
 */
async function verify(c: StepContext, p: Inspection, version: DeployVersion, resultId: number, since: string): Promise<Record<string, unknown>> {
  const check = checkOf(c, p.stand);
  const rollout = (why: string, error: string) =>
    new StepWaiting(
      `Жду выкатку на ${p.stand.title}: ${why}`,
      { kind: 'rollout', standId: p.stand.id, repoId: c.repo.id, app: p.app, tag: p.build.tag, probe: check, resultId, ...timed(since, WAIT_MS.rollout, error) },
      { release: releaseOut(version) },
    );
  let pod: PodImage | undefined;
  if (p.build.tag) {
    pod = await newestPod(c, p);
    if (pod?.tag !== p.build.tag) {
      throw rollout(
        `в ${p.stand.namespace} еще нет пода с образом ${p.build.tag}`,
        `Деплой прошел, но за ${minutes(WAIT_MS.rollout)} минут в ${p.stand.namespace} не появился под с образом ${p.build.tag}: самый новый под ${pod ? `${pod.pod} с ${pod.tag}` : 'не найден'}`,
      );
    }
    c.log(`Выкатка подтверждена по логам: под ${pod.pod} с образом ${pod.tag} в ${p.stand.namespace}`);
  } else {
    c.log(`Тег образа сборки ${p.build.key} неизвестен: образ в namespace не сверяется`);
  }
  if (check) {
    const r = await c.ports.logs(p.stand.logs).probe(check.url, c.contour?.serviceHeader);
    const answered = check.service ? serviceAnswers(p.stand, c.repo, r) : r.status === 200;
    if (!answered) {
      throw check.service
        ? rollout(`сервис ${c.repo.id} еще не отвечает сам`, `Сервис ${c.repo.id} на стенде ${p.stand.title} не отвечает сам: ${check.url} ${probeText(p.stand, r)}`)
        : rollout('стенд еще не отвечает', `Стенд ${p.stand.title} не отвечает: ${check.url} вернул ${r.status || 'ошибку соединения'}`);
    }
    c.log(check.service ? `Сервис ${c.repo.id} отвечает на стенде ${p.stand.namespace}: ${check.url}` : `Стенд отвечает: ${check.url}`);
  }
  return {
    release: releaseOut(version),
    deployedBuild: { stand: p.stand.id, build: p.build.key, tag: p.build.tag, resultId, pod: pod?.pod ?? null } satisfies DeployedBuild,
  };
}

/**
 * Деплой сборки ветки на стенд из шапки прогона. На подтверждении видно, какой релиз из какой сборки
 * встанет на стенд и что на нем сейчас; подтверждение привязано и к текущему деплою стенда, поэтому
 * чужой деплой, случившийся после клика, его сжигает. Конфиг k8s-ansible скрипт деплоя берет сам из ветки
 * с именем ветки релиза, а без нее из master; подтверждение показывает, какая ветка пойдет, и после деплоя
 * она сверяется со строкой лога. Ветку k8s-ansible с другим именем задает Customize Deploy: Deploy в форме
 * жмет владелец, шаг сам находит этот деплой. Прод и стенды вне профилей отсекают deployBlockReason и сам
 * порт Bamboo.
 */
const step: StepModule = {
  async done(c) {
    if (!c.stand) return null;
    const p = await inspect(c);
    if (!p.version || p.current?.version?.id !== p.version.id || p.current.state !== 'SUCCESS' || p.current.lifeCycle !== 'FINISHED') return null;
    const pod = p.build.tag ? await newestPod(c, p) : undefined;
    // Bamboo считает релиз выкаченным, но под с другим образом значит, что стенд с тех пор поменялся.
    if (p.build.tag && pod?.tag !== p.build.tag) return null;
    // Релиз мог встать с конфигом из другой ветки k8s-ansible, чем нужна сейчас, например до того, как у задачи
    // появилась своя ветка: такой деплой не засчитывается.
    if (p.config.branch && p.current.resultId) {
      const used = ansibleBranchOf((await p.bamboo.deployResult(p.current.resultId, true)).log ?? []);
      if (used !== null && used !== p.config.branch) return null;
    }
    return {
      note: `На ${p.stand.title} уже выкачен ${p.version.name}`,
      outputs: {
        release: { id: p.version.id, name: p.version.name },
        deployedBuild: { stand: p.stand.id, build: p.build.key, tag: p.build.tag, resultId: p.current.resultId ?? 0, pod: pod?.pod ?? null } satisfies DeployedBuild,
      },
    };
  },

  async preview(c) {
    const p = await inspect(c);
    if (p.current && p.current.lifeCycle && BUSY.has(p.current.lifeCycle)) {
      throw new Error(`На ${p.stand.title} сейчас идет деплой ${p.current.version?.name ?? ''}: дождитесь его окончания и повторите шаг`);
    }
    const now = p.current?.version?.name ?? null;
    const replacing = now ? `заменить ${now} на ${p.versionName}` : `выкатить ${p.versionName}`;
    const config = p.config.branch ? `, конфиг из ветки k8s-ansible ${p.config.branch}: ${p.config.reason}` : '';
    const actions = [
      p.version ? `Релиз ${p.versionName} из сборки ${p.build.key} уже есть` : `Создать релиз ${p.versionName} из сборки ${p.build.key}`,
      p.config.manual
        ? `Customize Deploy на ${p.stand.title} (${p.stand.bambooEnv}) с веткой k8s-ansible ${p.config.branch}: ${replacing}; кнопку Deploy в Bamboo нажимаете вы, потому что ${p.config.reason}`
        : `Деплой на ${p.stand.title} (${p.stand.bambooEnv}): ${replacing}${config}`,
      `Проверить выкатку: ${p.build.tag ? `под с образом ${p.build.tag} в ${p.stand.namespace} по логам` : 'стенд отвечает'}${checkText(checkOf(c, p.stand), p.stand)}`,
    ];
    const warnings: string[] = [];
    const other = now ? releaseInfo(now, c.contour?.builds) : null;
    if (other?.task && other.task !== c.run.issueKey) warnings.push(`На ${p.stand.title} сейчас ${now} задачи ${other.task}: деплой его заменит`);
    if (p.current?.state && p.current.state !== 'SUCCESS') warnings.push(`Последний деплой на ${p.stand.title} закончился с ${p.current.state}`);
    warnings.push(...p.stand.notes.map((n) => `Стенд ${p.stand.title}: ${n}`));
    return {
      title: `Деплой на ${p.stand.title}`,
      summary: `Релиз ${p.versionName} из сборки ${p.build.key} ветки ${p.build.branch}`,
      actions,
      warnings,
      payload: {
        stand: p.stand.id,
        envId: p.envId,
        build: p.build.key,
        version: p.versionName,
        versionId: p.version?.id ?? null,
        // Чужой деплой на стенд после подтверждения меняет этот номер и сжигает подтверждение.
        replacing: p.current?.resultId ?? null,
        // Появилась или пропала ветка k8s-ansible после подтверждения - конфиг будет другим, подтверждение сгорает.
        config: { branch: p.config.branch, manual: p.config.manual },
      },
    };
  },

  async simulate(c) {
    const build = c.get<Build>('build');
    return {
      release: { id: 0, name: 'пробный прогон' },
      deployedBuild: { stand: c.stand?.id ?? '', build: build?.key ?? 'dry-run', tag: build?.tag ?? null, resultId: 0, pod: null } satisfies DeployedBuild,
    };
  },

  async run(c) {
    const p = await inspect(c);
    const version = await releaseOf(c, p);
    const now = new Date().toISOString();
    if (p.config.manual) {
      c.log(`С веткой k8s-ansible ${p.config.branch} деплой идет через Customize Deploy: ${customizeText(c, p, version)}. Шаг сам найдет этот деплой`);
      return manualDeploy(c, p, version, now);
    }
    const { resultId } = await p.bamboo.deploy(p.envId, version.id);
    c.log(`Деплой ${version.name} на ${p.stand.title} поставлен в очередь: ${resultUrl(p, resultId)}`);
    return follow(c, p, version, resultId, now);
  },

  // Подтвержденный деплой уже идет: шаг продолжает с того, чего ждал, со сроком от прежнего начала ожидания.
  async resume(c, event) {
    const p = await inspect(c);
    if (!p.version) throw new Error(`Релиза сборки ${p.build.key} больше нет в Bamboo: повторите шаг`);
    if (event.kind === 'manual-deploy') return manualDeploy(c, p, p.version, event.since);
    if (event.kind === 'deploy') return follow(c, p, p.version, event.resultId, event.since);
    if (event.kind === 'rollout') return verify(c, p, p.version, event.resultId, event.since);
    throw new Error(`Деплой не ждет событий ${event.kind}`);
  },
};

export default step;
