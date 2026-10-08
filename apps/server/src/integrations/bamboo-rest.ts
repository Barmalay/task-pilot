import type { BambooPort, BuildResult, Contour, DeployResult, DeployVersion, EnvironmentStatus, StandProfile } from '@task-pilot/step-kit';
import { deployBlockReason, standEnvIds } from '@task-pilot/step-kit';

/** Настройки порта Bamboo одного контура. */
export interface BambooRestOptions {
  /** Адрес Bamboo, например https://bamboo.cloud.example.com. */
  url: string;
  token: string;
  /** Окружения, куда деплой разрешен: окружения стендов контура с deployable. */
  allowedEnvIds: number[];
  /** Окружения, куда деплой запрещен всегда, даже если они попали в разрешенные (прод). */
  forbiddenEnvIds: number[];
  fetch?: typeof fetch;
}

interface RawBuild {
  buildResultKey?: string;
  buildNumber?: number;
  buildState?: string;
  lifeCycleState?: string;
  vcsRevisionKey?: string;
}

interface RawVersion {
  id?: number;
  name?: string;
  planBranchName?: string;
  items?: { planResultKey?: { key?: string } }[];
}

interface RawDeployResult {
  id?: number;
  deploymentVersion?: { id?: number; name?: string } | null;
  deploymentVersionName?: string;
  deploymentState?: string;
  lifeCycleState?: string;
  startedDate?: number;
  finishedDate?: number;
  environmentId?: number;
  logEntries?: { logEntry?: { unstyledLog?: string; log?: string }[] };
}

const iso = (ms: number | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
const lines = (entries: { unstyledLog?: string; log?: string }[] | undefined) => (entries ?? []).map((e) => e.unstyledLog ?? e.log ?? '');

function toVersion(v: RawVersion): DeployVersion {
  return { id: Number(v.id), name: String(v.name ?? ''), buildKey: v.items?.[0]?.planResultKey?.key ?? null, branch: v.planBranchName ?? null };
}

function toResult(r: RawDeployResult, envId: number | null): DeployResult {
  const log = r.logEntries ? lines(r.logEntries.logEntry) : undefined;
  return {
    id: Number(r.id),
    envId: r.environmentId ?? envId,
    versionId: r.deploymentVersion?.id ?? null,
    versionName: r.deploymentVersion?.name ?? r.deploymentVersionName ?? null,
    state: String(r.deploymentState ?? 'UNKNOWN'),
    lifeCycle: String(r.lifeCycleState ?? 'UNKNOWN'),
    startedAt: iso(r.startedDate),
    finishedAt: iso(r.finishedDate),
    ...(log ? { log } : {}),
  };
}

/**
 * Порт Bamboo поверх REST с токеном MCP-сервера контура. MCP-сервер не умеет создавать релиз, поэтому
 * весь порт держится на REST, проверенном на этапе 0. Деплой на окружение вне разрешенных стендов
 * или из запрещенных контуром порт отклоняет до запроса: токен технически разрешает деплой и на прод.
 */
export function createBambooRest(o: BambooRestOptions): BambooPort {
  const base = `${o.url.replace(/\/$/, '')}/rest/api/latest`;
  const doFetch = o.fetch ?? fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const r = await doFetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json', 'x-atlassian-token': 'no-check' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (!r.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Не JSON: остается начало текста ответа.
      }
      throw new Error(`Bamboo ${method} ${path.split('?')[0]}: ${r.status} ${message}`.trim());
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    url: o.url.replace(/\/$/, ''),

    async planBranch(plan, branch) {
      // Bamboo называет ветку плана именем ветки git, где слеши заменены дефисами.
      const shortName = branch.replace(/\//g, '-');
      const r = await call<{ branches?: { branch?: { key?: string; shortName?: string }[] } }>('GET', `/plan/${plan}/branch?max-result=1000`);
      const found = (r.branches?.branch ?? []).find((b) => b.shortName === shortName);
      return found?.key ? { key: found.key, name: String(found.shortName) } : null;
    },

    async builds(planKey, limit) {
      const r = await call<{ results?: { result?: RawBuild[] } }>('GET', `/result/${planKey}?max-result=${limit}&expand=results.result.vcsRevisions&includeAllStates=true`);
      return (r.results?.result ?? []).map(
        (b): BuildResult => ({
          key: String(b.buildResultKey),
          number: Number(b.buildNumber),
          state: String(b.buildState ?? 'Unknown'),
          lifeCycle: String(b.lifeCycleState ?? 'Unknown'),
          revision: b.vcsRevisionKey ?? null,
          url: `${o.url.replace(/\/$/, '')}/browse/${b.buildResultKey}`,
        }),
      );
    },

    async buildLog(buildKey, maxLines) {
      const r = await call<{ stages?: { stage?: { results?: { result?: { buildResultKey?: string; buildState?: string }[] } }[] } }>(
        'GET',
        `/result/${buildKey}?expand=stages.stage.results.result`,
      );
      const jobs = (r.stages?.stage ?? []).flatMap((s) => s.results?.result ?? []);
      const failed = jobs.filter((j) => j.buildState === 'Failed');
      const out: string[] = [];
      for (const job of failed.length ? failed : jobs) {
        if (!job.buildResultKey) continue;
        // max-results отдает последние строки лога: там и есть причина падения.
        const log = await call<{ logEntries?: { logEntry?: { unstyledLog?: string; log?: string }[] } }>('GET', `/result/${job.buildResultKey}?expand=logEntries&max-results=${maxLines}`);
        out.push(`--- ${job.buildResultKey}`, ...lines(log.logEntries?.logEntry));
      }
      return out;
    },

    async versions(project, limit) {
      const r = await call<{ versions?: RawVersion[] }>('GET', `/deploy/project/${project}/versions?max-result=${limit}`);
      return (r.versions ?? []).map(toVersion);
    },

    async nextVersionName(project, buildKey) {
      const r = await call<{ nextVersionName?: string }>('GET', `/deploy/projectVersioning/${project}/nextVersion?resultKey=${encodeURIComponent(buildKey)}`);
      if (!r.nextVersionName) throw new Error(`Bamboo не предложил имя релиза для сборки ${buildKey}`);
      return r.nextVersionName;
    },

    async createVersion(project, buildKey, name) {
      return toVersion(await call<RawVersion>('POST', `/deploy/project/${project}/version`, { planResultKey: buildKey, name }));
    },

    async environments(project) {
      const r = await call<{ environmentStatuses?: { environment?: { id?: number; name?: string }; deploymentResult?: RawDeployResult | null }[] }[]>(
        'GET',
        `/deploy/dashboard/${project}`,
      );
      return (r[0]?.environmentStatuses ?? []).map((e): EnvironmentStatus => {
        const d = e.deploymentResult;
        return {
          envId: Number(e.environment?.id),
          envName: String(e.environment?.name ?? ''),
          version: d?.deploymentVersion?.id ? { id: d.deploymentVersion.id, name: String(d.deploymentVersion.name ?? d.deploymentVersionName ?? '') } : null,
          state: d?.deploymentState ?? null,
          lifeCycle: d?.lifeCycleState ?? null,
          resultId: d?.id ?? null,
          startedAt: iso(d?.startedDate),
          finishedAt: iso(d?.finishedDate),
        };
      });
    },

    async environmentResults(envId, limit) {
      const r = await call<{ results?: RawDeployResult[] }>('GET', `/deploy/environment/${envId}/results?max-result=${limit}`);
      return (r.results ?? []).map((x) => toResult(x, envId));
    },

    async deploy(envId, versionId) {
      if (o.forbiddenEnvIds.includes(envId)) throw new Error(`Деплой на окружение ${envId} запрещен в контуре`);
      if (!o.allowedEnvIds.includes(envId)) throw new Error(`Окружения ${envId} нет среди стендов, куда разрешен деплой`);
      const r = await call<{ deploymentResultId?: number }>('POST', `/queue/deployment?environmentId=${envId}&versionId=${versionId}`);
      if (!r.deploymentResultId) throw new Error('Bamboo не вернул номер деплоя');
      return { resultId: r.deploymentResultId };
    },

    async deployResult(resultId, withLog) {
      return toResult(await call<RawDeployResult>('GET', `/deploy/result/${resultId}${withLog ? '?includeLogs=true&max-result=3000' : ''}`), null);
    },
  };
}

/**
 * Порт Bamboo контура по настройкам его MCP-сервера из ~/.claude.json (BAMBOO_URL и BAMBOO_TOKEN).
 * Токен уходит только на хост Bamboo из профиля контура, а деплой разрешен только на стенды контура,
 * для которых deployBlockReason ничего не возражает.
 */
export function bambooFor(contour: Contour, servers: Record<string, { env: Record<string, string> }>, stands: StandProfile[], doFetch?: typeof fetch): BambooPort {
  const env = contour.mcp.bamboo ? servers[contour.mcp.bamboo]?.env : undefined;
  if (!env?.BAMBOO_URL || !env.BAMBOO_TOKEN) {
    throw new Error(`Для контура ${contour.title} не настроен Bamboo: нужен MCP-сервер ${contour.mcp.bamboo ?? '(не указан в профиле)'} с BAMBOO_URL и BAMBOO_TOKEN`);
  }
  if (new URL(env.BAMBOO_URL).host !== new URL(contour.bamboo).host) {
    throw new Error(`MCP-сервер ${contour.mcp.bamboo} смотрит на ${env.BAMBOO_URL}, а Bamboo контура ${contour.title} - ${contour.bamboo}: токен не отправляется`);
  }
  return createBambooRest({
    url: env.BAMBOO_URL,
    token: env.BAMBOO_TOKEN,
    allowedEnvIds: stands.filter((s) => s.contour === contour.id && deployBlockReason(s, contour) === null).flatMap(standEnvIds),
    forbiddenEnvIds: contour.forbiddenBambooEnvIds,
    ...(doFetch ? { fetch: doFetch } : {}),
  });
}
