import { describe, expect, it } from 'vitest';
import type { Contour, StandProfile } from '@task-pilot/step-kit';
import { bambooFor, createBambooRest } from '../src/integrations/bamboo-rest.ts';
import { createKibanaLogs } from '../src/integrations/kibana.ts';

/** Подменный fetch: ответы по началу пути, все запросы записываются. */
function fakeFetch(routes: Record<string, unknown | ((init: RequestInit | undefined) => Response)>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([prefix]) => url.includes(prefix));
    if (!hit) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const value = hit[1];
    return typeof value === 'function' ? (value as (i: RequestInit | undefined) => Response)(init) : Response.json(value);
  }) as typeof fetch;
  return { fn, calls };
}

const OPTIONS = { url: 'https://bamboo.example.org', token: 'secret-token-value', allowedEnvIds: [30474300], forbiddenEnvIds: [24674389] };

describe('Bamboo over REST', () => {
  it('lists the builds of a plan branch with their commits and pages, including running ones', async () => {
    const f = fakeFetch({
      '/result/BUILDS-P246?': {
        results: {
          result: [
            { buildResultKey: 'BUILDS-P246-5', buildNumber: 5, buildState: 'Unknown', lifeCycleState: 'InProgress', vcsRevisionKey: 'bbb' },
            { buildResultKey: 'BUILDS-P246-4', buildNumber: 4, buildState: 'Successful', lifeCycleState: 'Finished', vcsRevisionKey: 'aaa' },
          ],
        },
      },
    });
    const bamboo = createBambooRest({ ...OPTIONS, fetch: f.fn });
    expect(await bamboo.builds('BUILDS-P246', 10)).toEqual([
      { key: 'BUILDS-P246-5', number: 5, state: 'Unknown', lifeCycle: 'InProgress', revision: 'bbb', url: 'https://bamboo.example.org/browse/BUILDS-P246-5' },
      { key: 'BUILDS-P246-4', number: 4, state: 'Successful', lifeCycle: 'Finished', revision: 'aaa', url: 'https://bamboo.example.org/browse/BUILDS-P246-4' },
    ]);
    expect(f.calls[0]!.url).toContain('includeAllStates=true');
    expect((f.calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token-value');
  });

  it('finds the plan branch of a git branch by its name with slashes turned into dashes', async () => {
    const f = fakeFetch({ '/plan/BUILDS-P/branch': { branches: { branch: [{ key: 'BUILDS-P250', shortName: 'feature-TEAM-1-x' }, { key: 'BUILDS-P246', shortName: 'feature-TEAM-2799' }] } } });
    const bamboo = createBambooRest({ ...OPTIONS, fetch: f.fn });
    expect(await bamboo.planBranch('BUILDS-P', 'feature/TEAM-2799')).toEqual({ key: 'BUILDS-P246', name: 'feature-TEAM-2799' });
    expect(await bamboo.planBranch('BUILDS-P', 'feature/TEAM-9')).toBeNull();
  });

  it('takes the end of the log of the failed jobs only', async () => {
    const f = fakeFetch({
      '/result/BUILDS-P246-4?expand=stages': { stages: { stage: [{ results: { result: [{ buildResultKey: 'BUILDS-P246-OK-4', buildState: 'Successful' }, { buildResultKey: 'BUILDS-P246-BAPP-4', buildState: 'Failed' }] } }] } },
      '/result/BUILDS-P246-BAPP-4?expand=logEntries': { logEntries: { logEntry: [{ unstyledLog: '[ERROR] Tests run: 3, Failures: 1' }] } },
    });
    const bamboo = createBambooRest({ ...OPTIONS, fetch: f.fn });
    expect(await bamboo.buildLog('BUILDS-P246-4', 200)).toEqual(['--- BUILDS-P246-BAPP-4', '[ERROR] Tests run: 3, Failures: 1']);
    expect(f.calls.map((c) => c.url).find((u) => u.includes('logEntries'))).toContain('max-results=200');
    expect(f.calls.some((c) => c.url.includes('BUILDS-P246-OK-4'))).toBe(false);
  });

  it('reads the releases and what every environment runs now', async () => {
    const f = fakeFetch({
      '/deploy/project/1/versions': { versions: [{ id: 11, name: 'feature-TEAM-2799-4', planBranchName: 'feature-TEAM-2799', items: [{ planResultKey: { key: 'BUILDS-P246-4' } }] }] },
      '/deploy/dashboard/1': [
        {
          environmentStatuses: [
            { environment: { id: 30474300, name: 'Testing-Cloud-5' }, deploymentResult: { id: 7, deploymentVersion: { id: 9, name: 'release-273' }, deploymentState: 'SUCCESS', lifeCycleState: 'FINISHED', startedDate: 0, finishedDate: 169000 } },
            { environment: { id: 5, name: 'Empty' }, deploymentResult: null },
          ],
        },
      ],
    });
    const bamboo = createBambooRest({ ...OPTIONS, fetch: f.fn });
    expect(await bamboo.versions(1, 50)).toEqual([{ id: 11, name: 'feature-TEAM-2799-4', buildKey: 'BUILDS-P246-4', branch: 'feature-TEAM-2799' }]);
    expect(await bamboo.environments(1)).toEqual([
      { envId: 30474300, envName: 'Testing-Cloud-5', version: { id: 9, name: 'release-273' }, state: 'SUCCESS', lifeCycle: 'FINISHED', resultId: 7, startedAt: '1970-01-01T00:00:00.000Z', finishedAt: '1970-01-01T00:02:49.000Z' },
      { envId: 5, envName: 'Empty', version: null, state: null, lifeCycle: null, resultId: null, startedAt: null, finishedAt: null },
    ]);
  });

  it('never deploys to a forbidden environment or one that is not a deployable stand, without calling Bamboo', async () => {
    const f = fakeFetch({ '/queue/deployment': { deploymentResultId: 42 } });
    const bamboo = createBambooRest({ ...OPTIONS, fetch: f.fn });
    await expect(bamboo.deploy(24674389, 9)).rejects.toThrow('запрещен');
    await expect(bamboo.deploy(12345, 9)).rejects.toThrow('нет среди стендов');
    expect(f.calls).toEqual([]);
    expect(await bamboo.deploy(30474300, 9)).toEqual({ resultId: 42 });
    expect(f.calls[0]!.url).toBe('https://bamboo.example.org/rest/api/latest/queue/deployment?environmentId=30474300&versionId=9');
    expect(f.calls[0]!.init?.method).toBe('POST');
  });

  it('creates a release from a build and reports a refusal with the message of Bamboo but without the token', async () => {
    const f = fakeFetch({
      '/deploy/project/1/version': (init: RequestInit | undefined) =>
        JSON.parse(String(init?.body)).name === 'taken'
          ? new Response(JSON.stringify({ message: 'Version with this name already exists' }), { status: 400 })
          : Response.json({ id: 12, name: 'feature-TEAM-2799-5', items: [{ planResultKey: { key: 'BUILDS-P246-5' } }] }),
    });
    const bamboo = createBambooRest({ ...OPTIONS, fetch: f.fn });
    expect(await bamboo.createVersion(1, 'BUILDS-P246-5', 'feature-TEAM-2799-5')).toEqual({ id: 12, name: 'feature-TEAM-2799-5', buildKey: 'BUILDS-P246-5', branch: null });
    const error = await bamboo.createVersion(1, 'BUILDS-P246-5', 'taken').catch((e: Error) => e.message);
    expect(error).toBe('Bamboo POST /deploy/project/1/version: 400 Version with this name already exists');
    expect(error).not.toContain('secret-token-value');
  });

  it('follows a deployment and returns its log on request', async () => {
    const f = fakeFetch({ '/deploy/result/42': { id: 42, deploymentVersionName: 'feature-TEAM-2799-4', deploymentState: 'SUCCESS', lifeCycleState: 'FINISHED', logEntries: { logEntry: [{ unstyledLog: 'ok' }] } } });
    const bamboo = createBambooRest({ ...OPTIONS, fetch: f.fn });
    expect(await bamboo.deployResult(42, true)).toMatchObject({ id: 42, versionName: 'feature-TEAM-2799-4', state: 'SUCCESS', lifeCycle: 'FINISHED', log: ['ok'] });
    expect(f.calls[0]!.url).toContain('includeLogs=true');
  });
});

describe('Bamboo of a contour', () => {
  const contour: Contour = { id: 'cloud', title: 'cloud', git: 'https://git.example.org', bamboo: 'https://bamboo.example.org', mcp: { bamboo: 'bamboo-cloud' }, connected: true, forbiddenBambooEnvIds: [24674389] };
  const stand = (id: string, envId: number, over: Partial<StandProfile> = {}): StandProfile => ({ id, title: id, contour: 'cloud', namespace: id, bambooEnv: `Env-${id}`, bambooEnvId: envId, logs: 'kibana', deployable: true, notes: [], ...over });
  const servers = { 'bamboo-cloud': { env: { BAMBOO_URL: 'https://bamboo.example.org', BAMBOO_TOKEN: 'secret-token-value' } } };

  it('allows deploying only to deployable stands of the contour that are not production', async () => {
    const f = fakeFetch({ '/queue/deployment': { deploymentResultId: 1 } });
    const stands = [stand('testing-5', 30474300), stand('off', 2, { deployable: false }), stand('prod-like', 3, { bambooEnv: 'Production-X' }), stand('other', 4, { contour: 'core' })];
    const bamboo = bambooFor(contour, servers, stands, f.fn);
    await expect(bamboo.deploy(30474300, 1)).resolves.toEqual({ resultId: 1 });
    for (const env of [2, 3, 4, 24674389]) await expect(bamboo.deploy(env, 1)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });

  it('allows the environments of a stand of every repository of the contour, but never a forbidden one', async () => {
    const f = fakeFetch({ '/queue/deployment': { deploymentResultId: 1 } });
    const shared = stand('stable', 0, { bambooEnvId: undefined, bambooEnvIds: { mobile: 531631205, 'api': 620726237 } });
    const bamboo = bambooFor(contour, servers, [shared], f.fn);
    await expect(bamboo.deploy(531631205, 1)).resolves.toEqual({ resultId: 1 });
    await expect(bamboo.deploy(620726237, 1)).resolves.toEqual({ resultId: 1 });
    // Стенд, у которого запрещено хоть одно окружение, целиком выпадает из разрешенных.
    const risky = stand('risky', 0, { bambooEnvId: undefined, bambooEnvIds: { mobile: 24674389, other: 5 } });
    const guarded = bambooFor(contour, servers, [risky], f.fn);
    for (const env of [24674389, 5]) await expect(guarded.deploy(env, 1)).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
  });

  it('refuses to send the token to a host other than the Bamboo of the contour', () => {
    expect(() => bambooFor(contour, { 'bamboo-cloud': { env: { BAMBOO_URL: 'https://evil.example.org', BAMBOO_TOKEN: 't' } } }, [])).toThrow('токен не отправляется');
    expect(() => bambooFor({ ...contour, mcp: {} }, servers, [])).toThrow('не настроен Bamboo');
  });
});

describe('logs of the stands in Kibana', () => {
  it('asks the console proxy for the pods of the app by namespace and reads their image tags', async () => {
    const f = fakeFetch({
      '/api/console/proxy': {
        aggregations: {
          ns: {
            buckets: [
              {
                key: 'testing-cloud-5',
                pods: {
                  buckets: [
                    { key: 'pod-new', first: { value_as_string: '2026-09-22T20:25:58Z' }, last: { value_as_string: '2026-09-22T20:28:09Z' }, img: { buckets: [{ key: 'registry.example.com/x/gate:1.0.273-master' }] } },
                    { key: 'pod-old', first: { value_as_string: '2026-09-22T19:53:03Z' }, last: { value_as_string: '2026-09-22T20:28:09Z' }, img: { buckets: [{ key: 'registry.example.com/x/gate:1.0.229-master' }] } },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const logs = createKibanaLogs({ kind: 'kibana', url: 'https://kibana.example.org', index: 'cloud-k8s-*', imageField: 'container.image.name.keyword' }, f.fn);
    expect(await logs.pods('gate', ['testing-cloud-5'], 45)).toEqual({
      'testing-cloud-5': [
        { pod: 'pod-new', tag: '1.0.273-master', firstSeen: '2026-09-22T20:25:58Z', lastSeen: '2026-09-22T20:28:09Z' },
        { pod: 'pod-old', tag: '1.0.229-master', firstSeen: '2026-09-22T19:53:03Z', lastSeen: '2026-09-22T20:28:09Z' },
      ],
    });
    const call = f.calls[0]!;
    expect(call.url).toBe('https://kibana.example.org/api/console/proxy?path=cloud-k8s-*%2F_search&method=POST');
    expect((call.init?.headers as Record<string, string>)['kbn-xsrf']).toBe('true');
    expect(JSON.parse(String(call.init?.body)).query.bool.filter[1]).toEqual({ terms: { 'kubernetes.namespace.keyword': ['testing-cloud-5'] } });
  });

  it('takes the image of a pod from the field of the source: services of core keep it in kubernetes.container.image', async () => {
    const f = fakeFetch({ '/api/console/proxy': { aggregations: { ns: { buckets: [] } } } });
    const logs = createKibanaLogs({ kind: 'kibana', url: 'https://kibana.example.org', index: 'core-k8s-*', imageField: 'kubernetes.container.image.keyword' }, f.fn);
    await logs.pods('mobile', ['stable'], 30);
    const aggs = JSON.parse(String(f.calls[0]!.init?.body)).aggs;
    expect(aggs.ns.aggs.pods.aggs.img).toEqual({ terms: { field: 'kubernetes.container.image.keyword', size: 1 } });
  });

  it('asks by the Kubernetes fields the source names, and by the filebeat ones without them', async () => {
    const f = fakeFetch({ '/api/console/proxy': { aggregations: { ns: { buckets: [] } } } });
    const own = { kind: 'kibana' as const, url: 'https://k', index: 'logs-*', imageField: 'img', containerField: 'app', namespaceField: 'ns.keyword', podField: 'pod.keyword', timeField: 'ts' };
    await createKibanaLogs(own, f.fn).pods('gate', ['stable'], 30);
    const body = JSON.parse(String(f.calls[0]!.init?.body));
    expect(body.query.bool.filter).toEqual([{ match_phrase: { app: 'gate' } }, { terms: { 'ns.keyword': ['stable'] } }, { range: { ts: { gte: 'now-30m' } } }]);
    expect(body.aggs.ns.terms.field).toBe('ns.keyword');
    expect(body.aggs.ns.aggs.pods.terms.field).toBe('pod.keyword');
    expect(body.aggs.ns.aggs.pods.aggs.first).toEqual({ min: { field: 'ts' } });
  });

  it('tells the data view of its index for links to Discover', () => {
    const source = { kind: 'kibana' as const, url: 'https://k', index: 'core-k8s-*', imageField: 'img' };
    expect(createKibanaLogs({ ...source, dataView: 'dv-1' }).dataView).toBe('dv-1');
    expect(createKibanaLogs(source).dataView).toBeUndefined();
  });

  it('gives the HTTP status and the environment header of a probe and 0 when the address does not answer', async () => {
    const ok = createKibanaLogs({ kind: 'kibana', url: 'https://k', index: 'i', imageField: 'container.image.name.keyword' }, (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    expect(await ok.probe('https://stand/.well-known')).toEqual({ status: 200, environment: null });
    const service = createKibanaLogs({ kind: 'kibana', url: 'https://k', index: 'i', imageField: 'container.image.name.keyword' }, (async () =>
      new Response('', { status: 404, headers: { 'X-Environment': 'stable' } })) as unknown as typeof fetch);
    expect(await service.probe('https://proxy-stable.example.org/', 'x-environment')).toEqual({ status: 404, environment: 'stable' });
    // Без заголовка среды контура среды у ответа нет.
    expect(await service.probe('https://proxy-stable.example.org/')).toEqual({ status: 404, environment: null });
    const down = createKibanaLogs({ kind: 'kibana', url: 'https://k', index: 'i', imageField: 'container.image.name.keyword' }, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(await down.probe('https://stand/.well-known')).toEqual({ status: 0, environment: null });
  });
});
