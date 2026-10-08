import { describe, expect, it } from 'vitest';
import type { BambooPort, EnvironmentStatus, Ports, ProbeResult, StandLogsPort, StandProfile } from '@task-pilot/step-kit';
import type { Profiles } from '../src/config.ts';
import { standsOf } from '../src/stands.ts';
import { PROFILES } from './helpers.ts';

const stand = (id: string, envId: number, over: Partial<StandProfile> = {}): StandProfile => ({
  id,
  title: id,
  contour: 'cloud',
  url: `https://${id}.example.org`,
  realm: 'sso-test-realm',
  health: '/auth/realms/{realm}/.well-known/openid-configuration',
  namespace: `ns-${id}`,
  bambooEnv: `Env-${id}`,
  bambooEnvId: envId,
  logs: 'kibana',
  deployable: true,
  notes: [],
  ...over,
});

const env = (envId: number, name: string, over: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({
  envId,
  envName: `Env-${envId}`,
  version: { id: envId * 10, name },
  state: 'SUCCESS',
  lifeCycle: 'FINISHED',
  resultId: 1,
  startedAt: '2026-09-23T08:00:00.000Z',
  finishedAt: '2026-09-23T08:03:00.000Z',
  ...over,
});

const REPO = { ...PROFILES.repos[1]!, id: 'gate', bamboo: { plan: 'BUILDS-P', deploymentProject: 7 } };

function profiles(stands: StandProfile[], connected = true): Profiles {
  return { ...PROFILES, repos: [REPO], stands, contours: PROFILES.contours.map((c) => (c.id === 'cloud' ? { ...c, connected } : c)) };
}

function ports(opts: { envs?: EnvironmentStatus[] | Error; down?: string[]; answer?: (url: string) => ProbeResult }) {
  const calls: string[] = [];
  const bamboo = {
    async environments(project: number) {
      calls.push(`environments ${project}`);
      if (opts.envs instanceof Error) throw opts.envs;
      return opts.envs ?? [];
    },
  } as unknown as BambooPort;
  const logs: StandLogsPort = {
    async pods(app, namespaces) {
      calls.push(`pods ${app} ${namespaces.join(',')}`);
      return { 'ns-testing-1': [{ pod: 'kc-1', tag: '1.0.3-246', firstSeen: '2026-09-22T12:00:00Z', lastSeen: '2026-09-23T08:00:00Z' }] };
    },
    async probe(url) {
      calls.push(`probe ${url}`);
      if (opts.answer) return opts.answer(url);
      return { status: opts.down?.some((d) => url.includes(d)) ? 0 : 200, environment: null };
    },
  };
  return { ports: { bamboo: () => bamboo, logs: () => logs } as unknown as Ports, calls };
}

describe('what runs on the stands', () => {
  it('joins the last deployment in Bamboo, the newest pod in the logs and the answer of every stand', async () => {
    const stands = [stand('stable', 1), stand('testing-1', 2), stand('prod-like', 3, { bambooEnv: 'Production-Cloud' })];
    const p = ports({ envs: [env(1, 'feature-TEAM-2827-over-2700-1'), env(2, 'feature-TEAM-2799-3'), env(3, 'release-273')], down: ['stable'] });
    const list = await standsOf(REPO, profiles(stands), p.ports);
    expect(list.map((s) => [s.id, s.release?.name, s.branch, s.task, s.image?.tag ?? null, s.up])).toEqual([
      ['stable', 'feature-TEAM-2827-over-2700-1', 'feature-TEAM-2827-over-2700', 'TEAM-2827', null, false],
      ['testing-1', 'feature-TEAM-2799-3', 'feature-TEAM-2799', 'TEAM-2799', '1.0.3-246', true],
      ['prod-like', 'release-273', 'master', null, null, true],
    ]);
    expect(list[1]!.taskUrl).toBe('https://jira.example.org/browse/TEAM-2799');
    expect(list[2]!.blocked).toContain('похож на прод');
    expect(p.calls.filter((c) => !c.startsWith('probe'))).toEqual(['environments 7', 'pods gate ns-stable,ns-testing-1,ns-prod-like']);
  });

  it('shows what the logs know when Bamboo fails and says what failed', async () => {
    const p = ports({ envs: new Error('Bamboo GET /deploy/dashboard/7: 503') });
    const [s] = await standsOf(REPO, profiles([stand('testing-1', 2)]), p.ports);
    expect(s).toMatchObject({ release: null, image: { tag: '1.0.3-246' }, errors: ['Bamboo: Bamboo GET /deploy/dashboard/7: 503'] });
  });

  it('does not ask Bamboo for a contour that is not connected', async () => {
    const p = ports({});
    const [s] = await standsOf(REPO, profiles([stand('testing-1', 2)], false), p.ports);
    expect(s!.errors).toEqual(['контур cloud не подключен']);
    expect(p.calls.some((c) => c.startsWith('environments'))).toBe(false);
  });

  it('counts a stand with service addresses as up only when the service of that stand answers itself', async () => {
    const own = stand('testing-a-0', 1, { url: undefined, realm: undefined, serviceUrl: 'https://{service}-team-a-0.example.org', namespace: 'testing-a-0' });
    const empty = stand('testing-b-1', 2, { url: undefined, realm: undefined, serviceUrl: 'https://{service}-team-b-1.example.org', namespace: 'testing-b-1' });
    // Адрес сервиса на стенде, где его нет, отвечает со Stable.
    const answer = (url: string): ProbeResult => ({ status: 200, environment: url.includes('team-a-0') ? 'testing-a-0' : 'stable' });
    const p = ports({ envs: [env(1, 'release-1'), env(2, 'release-2')], answer });
    const list = await standsOf({ ...REPO, health: '/health/readiness' }, profiles([own, empty]), p.ports);
    expect(list.map((s) => [s.id, s.up])).toEqual([
      ['testing-a-0', true],
      ['testing-b-1', false],
    ]);
    expect(p.calls.filter((c) => c.startsWith('probe'))).toEqual(['probe https://gate-team-a-0.example.org/health/readiness', 'probe https://gate-team-b-1.example.org/health/readiness']);
  });

  it('shows a stand of several deployment projects by the environment of the repository and hides stands without one', async () => {
    const shared = stand('stable', 0, { bambooEnvId: undefined, bambooEnvIds: { 'gate': 5, other: 6 } });
    const foreign = stand('media-0', 0, { bambooEnvId: undefined, bambooEnvIds: { other: 7 } });
    const p = ports({ envs: [env(5, 'feature-TEAM-2700-9'), env(6, 'release-1'), env(7, 'release-2')] });
    const list = await standsOf(REPO, profiles([shared, foreign]), p.ports);
    expect(list.map((s) => [s.id, s.release?.name, s.task])).toEqual([['stable', 'feature-TEAM-2700-9', 'TEAM-2700']]);
    expect(list[0]!.blocked).toBeNull();
  });
});
