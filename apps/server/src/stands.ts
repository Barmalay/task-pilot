import type { EnvironmentStatus, PodImage, Ports, RepoProfile } from '@task-pilot/step-kit';
import { deployBlockReason, releaseInfo, serviceAnswers, serviceCheckUrl, standEnvId, standHealthUrl } from '@task-pilot/step-kit';
import type { Profiles } from './config.ts';
import type { StandDto } from '@task-pilot/api-types';

/** Окно, в котором ищутся поды по логам: стенд без логов за три часа, скорее всего, стоит. */
const PODS_WINDOW_MINUTES = 180;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Что сейчас на стендах контура репозитория, у которых есть окружение в его проекте деплоя: последний деплой по
 * Bamboo, самый новый под по логам и ответ самого сервиса на стенде (по адресу сервиса с заголовком среды контура) или
 * самого стенда по его пути проверки (health). Источники опрашиваются параллельно, и сбой одного не мешает показать остальное: он попадает в
 * errors стенда.
 */
export async function standsOf(repo: RepoProfile, profiles: Profiles, ports: Ports): Promise<StandDto[]> {
  const contour = profiles.contours.find((c) => c.id === repo.contour);
  const stands = profiles.stands.filter((s) => s.contour === repo.contour && standEnvId(s, repo.id) !== null);
  const project = repo.bamboo?.deploymentProject;

  const envs = (async (): Promise<Map<number, EnvironmentStatus> | string> => {
    if (!contour?.connected) return `контур ${contour?.title ?? repo.contour} не подключен`;
    if (!project) return `в профиле ${repo.id} нет bamboo.deploymentProject`;
    try {
      return new Map((await ports.bamboo(contour).environments(project)).map((e) => [e.envId, e]));
    } catch (e) {
      return `Bamboo: ${message(e)}`;
    }
  })();

  const sources = [...new Set(stands.map((s) => s.logs))];
  const pods = Promise.all(
    sources.map(async (source): Promise<[string, Record<string, PodImage[]> | string]> => {
      try {
        const namespaces = stands.filter((s) => s.logs === source).map((s) => s.namespace);
        return [source, await ports.logs(source).pods(repo.id, namespaces, PODS_WINDOW_MINUTES)];
      } catch (e) {
        return [source, `Логи ${source}: ${message(e)}`];
      }
    }),
  ).then((list) => new Map(list));

  const probes = Promise.all(
    stands.map(async (s) => {
      const service = serviceCheckUrl(s, repo);
      const target = service ?? standHealthUrl(s);
      if (!target) return null;
      const r = await ports.logs(s.logs).probe(target, contour?.serviceHeader);
      return service ? serviceAnswers(s, repo, r) : r.status === 200;
    }),
  );

  const [envMap, podMap, up] = await Promise.all([envs, pods, probes]);
  return stands.map((s, i): StandDto => {
    const errors: string[] = [];
    const env = typeof envMap === 'string' ? (errors.push(envMap), undefined) : envMap.get(standEnvId(s, repo.id) ?? -1);
    const sourcePods = podMap.get(s.logs);
    const newest = typeof sourcePods === 'string' ? (errors.push(sourcePods), undefined) : sourcePods?.[s.namespace]?.[0];
    const info = env?.version ? releaseInfo(env.version.name, contour?.builds) : null;
    return {
      id: s.id,
      title: s.title,
      url: s.url ?? null,
      namespace: s.namespace,
      bambooEnv: s.bambooEnv,
      blocked: deployBlockReason(s, contour, repo.id),
      notes: s.notes,
      release: env?.version ? { name: env.version.name, state: env.state, lifeCycle: env.lifeCycle, startedAt: env.startedAt, finishedAt: env.finishedAt } : null,
      branch: info?.branch ?? null,
      task: info?.task ?? null,
      taskUrl: info?.task ? `${profiles.jira.baseUrl.replace(/\/$/, '')}/browse/${info.task}` : null,
      image: newest ? { tag: newest.tag, pod: newest.pod, since: newest.firstSeen } : null,
      up: up[i] ?? null,
      errors,
    };
  });
}
