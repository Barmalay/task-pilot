import type { BambooPort, BuildResult, DeployResult, DeployVersion, GitPort, LogSource, PodImage, StandLogsPort, StandProfile } from '@task-pilot/step-kit';
import { imageTag } from '@task-pilot/step-kit';

/** План сборки и деплой-проект учебного репозитория в подменном Bamboo. */
export const DEMO_PLAN = 'DEMO-CALC';
export const DEMO_PROJECT = 1;

/**
 * Как подменный Bamboo демо называет образы сборок и релизы: схема builds контура demo учебной команды, по ней шаг
 * "Сборка ветки" узнает тег образа, а проверка выкатки ищет под с ним.
 */
export const DEMO_BUILDS = { branchTag: '1.0.{build}-{branch}', masterTag: '1.0.{build}-master', masterRelease: '^release-\\d+$' };

/** Источник логов демо-стендов: подменная Kibana. */
export const DEMO_LOGS: Record<string, LogSource> = { 'demo-logs': { kind: 'kibana', url: 'https://kibana.demo.invalid', index: 'demo-*', imageField: 'container.image.name.keyword' } };

/** Учебные стенды демо-режима в контуре demo. */
export const DEMO_STANDS: (StandProfile & { bambooEnvId: number })[] = [1, 2].map((n) => ({
  id: `demo-${n}`,
  title: `demo-${n}`,
  contour: 'demo',
  url: `https://demo-${n}.demo.invalid`,
  realm: 'demo',
  health: '/health',
  namespace: `demo-${n}`,
  bambooEnv: `Demo-Stand-${n}`,
  bambooEnvId: 100 + n,
  logs: 'demo-logs',
  deployable: true,
  notes: ['Учебный стенд демо-режима: деплой идет в подменный Bamboo'],
}));

interface Build extends BuildResult {
  at: number;
}

interface Deploy {
  id: number;
  envId: number;
  version: DeployVersion;
  at: number;
  done: boolean;
}

/**
 * Подменные Bamboo и Kibana демо-режима. Ветка плана появляется, когда ветка есть в локальном remote,
 * сборка его вершины идет buildMs, деплой - deployMs, после чего у окружения новый релиз, а в namespace
 * стенда новый под с образом этой сборки. Состояние считается по времени при каждом запросе.
 */
export function demoCi(origin: string, git: GitPort, timing = { buildMs: 8000, deployMs: 8000 }): { bamboo: BambooPort; logs: StandLogsPort } {
  const branches = new Map<string, string>([[DEMO_PLAN, 'master']]);
  const builds = new Map<string, Build[]>();
  const versions: DeployVersion[] = [{ id: 1, name: 'release-10', buildKey: `${DEMO_PLAN}-10`, branch: 'master' }];
  const current = new Map<number, { version: DeployVersion; resultId: number; at: number }>(DEMO_STANDS.map((s) => [s.bambooEnvId, { version: versions[0]!, resultId: 0, at: Date.now() - 86_400_000 }]));
  const images = new Map<string, PodImage>(DEMO_STANDS.map((s) => [s.namespace, { pod: `app-${s.namespace}-old`, tag: '1.0.10-master', firstSeen: new Date(Date.now() - 86_400_000).toISOString(), lastSeen: new Date().toISOString() }]));
  const deploys: Deploy[] = [];
  let nextBranch = 11;
  const iso = (ms: number) => new Date(ms).toISOString();

  /** Доводит деплои, чье время вышло: новый релиз окружения и новый под в namespace. */
  function settle(): void {
    for (const d of deploys) {
      if (d.done || Date.now() - d.at < timing.deployMs) continue;
      d.done = true;
      current.set(d.envId, { version: d.version, resultId: d.id, at: d.at + timing.deployMs });
      const stand = DEMO_STANDS.find((s) => s.bambooEnvId === d.envId);
      const tag = d.version.buildKey && imageTag(DEMO_PLAN, d.version.buildKey, DEMO_BUILDS);
      if (stand && tag) images.set(stand.namespace, { pod: `app-${stand.namespace}-${d.id}`, tag, firstSeen: iso(d.at + timing.deployMs / 2), lastSeen: iso(Date.now()) });
    }
  }

  function buildState(b: Build): Build {
    const age = Date.now() - b.at;
    if (age < 1000) return { ...b, lifeCycle: 'Queued' };
    if (age < timing.buildMs) return { ...b, lifeCycle: 'InProgress' };
    return { ...b, state: 'Successful', lifeCycle: 'Finished' };
  }

  function result(d: Deploy): DeployResult {
    settle();
    return {
      id: d.id,
      envId: d.envId,
      versionId: d.version.id,
      versionName: d.version.name,
      state: d.done ? 'SUCCESS' : 'UNKNOWN',
      lifeCycle: d.done ? 'FINISHED' : 'IN_PROGRESS',
      startedAt: iso(d.at),
      finishedAt: d.done ? iso(d.at + timing.deployMs) : null,
    };
  }

  const bamboo: BambooPort = {
    url: 'https://bamboo.demo.invalid',
    async planBranch(_plan, branch) {
      if ((await git.tryRun(origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0) return null;
      const name = branch.replace(/\//g, '-');
      let key = [...branches].find(([, b]) => b === branch)?.[0];
      if (!key) branches.set((key = `${DEMO_PLAN}${nextBranch++}`), branch);
      return { key, name };
    },
    async builds(planKey, limit) {
      const branch = branches.get(planKey);
      if (!branch) return [];
      const head = (await git.tryRun(origin, ['rev-parse', `refs/heads/${branch}`])).stdout.trim();
      const list = builds.get(planKey) ?? [];
      // Bamboo замечает новый коммит ветки и собирает его: здесь это происходит при первом же запросе.
      if (head && !list.some((b) => b.revision === head)) {
        const number = (list[0]?.number ?? 0) + 1;
        list.unshift({ key: `${planKey}-${number}`, number, state: 'Unknown', lifeCycle: 'Queued', revision: head, url: `https://bamboo.demo.invalid/browse/${planKey}-${number}`, at: Date.now() });
        builds.set(planKey, list);
      }
      return list.slice(0, limit).map((b) => {
        const { at: _at, ...rest } = buildState(b);
        return rest;
      });
    },
    async buildLog(buildKey) {
      return [`--- ${buildKey}`, '[INFO] Tests run: 4, Failures: 0, Errors: 0', '[INFO] BUILD SUCCESS'];
    },
    async versions(_project, limit) {
      return [...versions].reverse().slice(0, limit);
    },
    async nextVersionName(_project, buildKey) {
      const branchKey = buildKey.replace(/-\d+$/, '');
      const number = buildKey.slice(branchKey.length + 1);
      const branch = branches.get(branchKey) ?? 'master';
      return branch === 'master' ? `release-${number}` : `${branch.replace(/\//g, '-')}-${number}`;
    },
    async createVersion(_project, buildKey, name) {
      if (versions.some((v) => v.name === name)) throw new Error(`Bamboo POST /deploy/project/${DEMO_PROJECT}/version: 400 Version with this name already exists`);
      const version: DeployVersion = { id: versions.length + 1, name, buildKey, branch: (branches.get(buildKey.replace(/-\d+$/, '')) ?? 'master').replace(/\//g, '-') };
      versions.push(version);
      return version;
    },
    async environments() {
      settle();
      return DEMO_STANDS.map((s) => {
        const pending = deploys.find((d) => d.envId === s.bambooEnvId && !d.done);
        const now = current.get(s.bambooEnvId)!;
        return pending
          ? { envId: s.bambooEnvId, envName: s.bambooEnv, version: { id: pending.version.id, name: pending.version.name }, state: 'UNKNOWN', lifeCycle: 'IN_PROGRESS', resultId: pending.id, startedAt: iso(pending.at), finishedAt: null }
          : { envId: s.bambooEnvId, envName: s.bambooEnv, version: { id: now.version.id, name: now.version.name }, state: 'SUCCESS', lifeCycle: 'FINISHED', resultId: now.resultId, startedAt: iso(now.at), finishedAt: iso(now.at) };
      });
    },
    async environmentResults(envId, limit) {
      return deploys
        .filter((d) => d.envId === envId)
        .reverse()
        .slice(0, limit)
        .map(result);
    },
    async deploy(envId, versionId) {
      if (!DEMO_STANDS.some((s) => s.bambooEnvId === envId)) throw new Error(`Окружения ${envId} нет среди стендов, куда разрешен деплой`);
      const version = versions.find((v) => v.id === versionId);
      if (!version) throw new Error(`Релиза ${versionId} нет`);
      const d: Deploy = { id: 1000 + deploys.length, envId, version, at: Date.now(), done: false };
      deploys.push(d);
      return { resultId: d.id };
    },
    async deployResult(resultId, withLog) {
      const d = deploys.find((x) => x.id === resultId);
      if (!d) throw new Error(`Деплоя ${resultId} нет`);
      const r = result(d);
      return withLog ? { ...r, log: [`Деплой ${d.version.name}`, 'Деплой выполняется из ветки k8s-ansible: master'] } : r;
    },
  };

  const logs: StandLogsPort = {
    async pods(_app, namespaces) {
      settle();
      return Object.fromEntries(namespaces.flatMap((ns) => (images.has(ns) ? [[ns, [{ ...images.get(ns)!, lastSeen: iso(Date.now()) }]]] : [])));
    },
    async probe() {
      return { status: 200, environment: null };
    },
  };

  return { bamboo, logs };
}
