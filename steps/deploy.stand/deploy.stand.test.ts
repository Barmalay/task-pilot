import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { BambooPort, Contour, DeployResult, DeployVersion, EnvironmentStatus, GitPort, PodImage, ProbeResult, RepoProfile, StandLogsPort, StandProfile, WaitEvent } from '../../packages/step-kit/src/index.ts';
import { TEST_CONTOUR, testContext, testRepo } from '../_test/context.ts';
import { throughWaits, waitOf } from '../_test/wait.ts';
import type { Build } from '../../packages/step-kit/src/index.ts';
import step, { ansibleBranchOf } from './index.ts';

const STAND: StandProfile = {
  id: 'testing-5',
  title: 'testing-5',
  contour: 'cloud',
  url: 'https://kc-5.example.org',
  realm: 'sso-test-realm',
  health: '/auth/realms/{realm}/.well-known/openid-configuration',
  namespace: 'testing-cloud-5',
  bambooEnv: 'Testing-Cloud-5',
  bambooEnvId: 30474300,
  logs: 'kibana',
  deployable: true,
  notes: ['партнерские входы только на stable'],
};

const BUILD: Build = { key: 'BUILDS-P246-4', number: 4, plan: 'BUILDS-P', branch: 'feature/TEAM-5', revision: 'a'.repeat(40), tag: '1.0.4-246', url: 'https://bamboo/browse/BUILDS-P246-4' };

const env = (over: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({
  envId: 30474300,
  envName: 'Testing-Cloud-5',
  version: { id: 9, name: 'release-273' },
  state: 'SUCCESS',
  lifeCycle: 'FINISHED',
  resultId: 7,
  startedAt: '2026-09-22T20:25:09.000Z',
  finishedAt: '2026-09-22T20:28:12.000Z',
  ...over,
});

const pod = (tag: string, name = `pod-${tag}`): PodImage => ({ pod: name, tag, firstSeen: '2026-09-23T10:00:00Z', lastSeen: '2026-09-23T10:05:00Z' });

/** Bamboo и логи стенда по сценарию: состояния деплоя и поды берутся по очереди, последнее повторяется. */
function fakeCi(opts: { versions?: DeployVersion[]; current?: EnvironmentStatus; results?: Partial<DeployResult>[]; pods?: PodImage[][]; probe?: (number | ProbeResult)[]; createFails?: boolean; manualAfter?: number }) {
  const calls: string[] = [];
  const versions = [...(opts.versions ?? [])];
  let results = 0;
  let podCalls = 0;
  let probes = 0;
  let manual = 0;
  const bamboo: BambooPort = {
    url: 'https://bamboo.example.org',
    async planBranch() {
      return null;
    },
    async builds() {
      return [];
    },
    async buildLog() {
      return [];
    },
    async versions() {
      return [...versions].reverse();
    },
    async nextVersionName(_p, key) {
      calls.push(`nextVersion ${key}`);
      return 'feature-TEAM-5-4';
    },
    async createVersion(_p, key, name) {
      calls.push(`create ${name}`);
      const v = { id: 21, name, buildKey: key, branch: 'feature-TEAM-5' };
      versions.push(v);
      if (opts.createFails) throw new Error('Bamboo POST /deploy/project/1/version: 400 Version with this name already exists');
      return v;
    },
    async environments() {
      return [opts.current ?? env()];
    },
    async environmentResults(envId) {
      manual += 1;
      calls.push(`results ${envId}`);
      return manual > (opts.manualAfter ?? 0) ? [{ id: 55, envId, versionId: 21, versionName: 'feature-TEAM-5-4', state: 'UNKNOWN', lifeCycle: 'IN_PROGRESS', startedAt: new Date().toISOString(), finishedAt: null }] : [];
    },
    async deploy(envId, versionId) {
      calls.push(`deploy ${envId} ${versionId}`);
      return { resultId: 42 };
    },
    async deployResult(id, withLog) {
      const r = opts.results?.[Math.min(results++, (opts.results?.length ?? 1) - 1)] ?? {};
      return { id, envId: 30474300, versionId: 21, versionName: 'feature-TEAM-5-4', state: 'SUCCESS', lifeCycle: 'FINISHED', startedAt: null, finishedAt: null, ...r, ...(withLog ? { log: r.log ?? [] } : {}) };
    },
  };
  const logs: StandLogsPort = {
    async pods(app, namespaces) {
      calls.push(`pods ${app} ${namespaces.join(',')}`);
      const list = opts.pods?.[Math.min(podCalls++, (opts.pods?.length ?? 1) - 1)] ?? [pod('1.0.4-246')];
      return { [namespaces[0]!]: list };
    },
    async probe(url) {
      calls.push(`probe ${url}`);
      const r = opts.probe?.[Math.min(probes++, opts.probe.length - 1)] ?? 200;
      return typeof r === 'number' ? { status: r, environment: null } : r;
    },
  };
  return { bamboo, logs, calls };
}

/** Репозиторий k8s-ansible: папка есть, ветки remote отвечает поддельный git. */
const DEPLOY_REPO: RepoProfile = { ...testRepo(tmpdir(), '/tmp/wt'), id: 'k8s-ansible-cloud', default: false, bitbucket: { project: 'DEVOPS', repo: 'k8s-ansible', reviewers: [] } };

/** git, у которого на remote репозитория деплоя есть только перечисленные ветки; сбой ls-remote по желанию. */
function fakeGit(branches: string[], fails = false): GitPort & { calls: string[][] } {
  const calls: string[][] = [];
  const answer = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (fails) return { code: 128, stdout: '', stderr: 'fatal: unable to access remote\n' };
    const ref = args.at(-1)!;
    return { code: 0, stdout: branches.some((b) => `refs/heads/${b}` === ref) ? `abc\t${ref}\n` : '', stderr: '' };
  };
  return { run: answer, tryRun: answer, calls };
}

/** Контур, чей деплой берет ветку k8s-ansible задачи только из формы Customize Deploy. */
const CUSTOMIZE: Contour = {
  ...TEST_CONTOUR,
  id: 'core',
  title: 'core',
  deploy: { ansibleBranch: 'customize', customizeUrl: 'https://bamboo2.example.org/plugins/deploy/customDeploymentVersion.action?environmentId={envId}&versionId={versionId}' },
};

function setup(ci: ReturnType<typeof fakeCi>, over: { stand?: StandProfile | undefined; values?: Record<string, unknown>; deployRepo?: RepoProfile; git?: GitPort; repo?: Partial<RepoProfile>; waited?: WaitEvent | null; contour?: Contour } = {}) {
  const repo = { ...testRepo('/tmp/none', '/tmp/wt'), id: 'gate', bamboo: { plan: 'BUILDS-P', deploymentProject: 1 }, ...over.repo };
  return testContext({
    issueKey: 'TEAM-5',
    repo,
    ports: { bamboo: () => ci.bamboo, logs: () => ci.logs, ...(over.git ? { git: over.git } : {}) },
    stand: 'stand' in over ? over.stand : STAND,
    deployRepo: over.deployRepo,
    ...(over.contour ? { contour: over.contour } : {}),
    values: { build: BUILD, ...over.values },
    waited: over.waited ?? null,
  });
}

/** Деплой так, как его ведет движок с наблюдателем: каждое ожидание сразу случилось, и шаг продолжается. */
const deploy = (ci: ReturnType<typeof fakeCi>, over: Parameters<typeof setup>[1] = {}) => throughWaits(step, (waited) => setup(ci, { ...over, waited }));

describe('deploy.stand', () => {
  it('shows which release of which build replaces what on the stand and warns about another task there', async () => {
    const ci = fakeCi({ current: env({ version: { id: 3, name: 'feature-TEAM-2827-over-2700-1' }, resultId: 70 }) });
    const p = await step.preview!(setup(ci));
    expect(p.title).toBe('Деплой на testing-5');
    expect(p.actions).toEqual([
      'Создать релиз feature-TEAM-5-4 из сборки BUILDS-P246-4',
      'Деплой на testing-5 (Testing-Cloud-5): заменить feature-TEAM-2827-over-2700-1 на feature-TEAM-5-4',
      'Проверить выкатку: под с образом 1.0.4-246 в testing-cloud-5 по логам и ответ https://kc-5.example.org/auth/realms/sso-test-realm/.well-known/openid-configuration',
    ]);
    expect(p.warnings).toEqual(['На testing-5 сейчас feature-TEAM-2827-over-2700-1 задачи TEAM-2827: деплой его заменит', 'Стенд testing-5: партнерские входы только на stable']);
    expect(p.payload).toMatchObject({ stand: 'testing-5', envId: 30474300, build: 'BUILDS-P246-4', version: 'feature-TEAM-5-4', versionId: null, replacing: 70 });
  });

  it('reuses the release that already exists for the build and does not warn about a master release', async () => {
    const ci = fakeCi({ versions: [{ id: 11, name: 'feature-TEAM-5-4', buildKey: 'BUILDS-P246-4', branch: 'feature-TEAM-5' }] });
    const p = await step.preview!(setup(ci));
    expect(p.actions[0]).toBe('Релиз feature-TEAM-5-4 из сборки BUILDS-P246-4 уже есть');
    expect(p.warnings).toEqual(['Стенд testing-5: партнерские входы только на stable']);
    expect(ci.calls).not.toContain('nextVersion BUILDS-P246-4');
  });

  it('refuses without a stand, on a stand switched off, on a stand of another contour and while the stand is being deployed', async () => {
    await expect(step.preview!(setup(fakeCi({}), { stand: undefined }))).rejects.toThrow('Выберите стенд в шапке прогона');
    await expect(step.preview!(setup(fakeCi({}), { stand: { ...STAND, deployable: false } }))).rejects.toThrow('выключен для деплоя');
    await expect(step.preview!(setup(fakeCi({}), { stand: { ...STAND, contour: 'core' } }))).rejects.toThrow('Стенд testing-5 из контура core');
    await expect(step.preview!(setup(fakeCi({ current: env({ lifeCycle: 'IN_PROGRESS', state: 'UNKNOWN' }) })))).rejects.toThrow('сейчас идет деплой');
  });

  it('creates the release, deploys it, waits for the deployment and the rollout and confirms the new pod and the stand answer', async () => {
    const ci = fakeCi({ results: [{ lifeCycle: 'QUEUED', state: 'UNKNOWN' }, { lifeCycle: 'IN_PROGRESS', state: 'UNKNOWN' }, { lifeCycle: 'FINISHED', state: 'SUCCESS' }], pods: [[pod('1.0.273-master')], [pod('1.0.4-246', 'kc-new')]], probe: [503, 200] });
    const { outputs, events, logs } = await deploy(ci);
    expect(outputs).toEqual({
      release: { id: 21, name: 'feature-TEAM-5-4' },
      deployedBuild: { stand: 'testing-5', build: 'BUILDS-P246-4', tag: '1.0.4-246', resultId: 42, pod: 'kc-new' },
    });
    // Деплой и выкатку шаг не опрашивает сам: он ждет их событиями, а наблюдатель продолжает его.
    expect(events.map((e) => e.kind)).toEqual(['deploy', 'deploy', 'rollout', 'rollout']);
    expect(events[0]).toMatchObject({ kind: 'deploy', contour: 'cloud', resultId: 42 });
    expect(events[1]!.since).toBe(events[0]!.since);
    expect(events[2]).toMatchObject({ kind: 'rollout', standId: 'testing-5', repoId: 'gate', app: 'gate', tag: '1.0.4-246', resultId: 42 });
    expect(events[2]).toMatchObject({ probe: { url: 'https://kc-5.example.org/auth/realms/sso-test-realm/.well-known/openid-configuration', service: false } });
    expect(events[3]!.since).toBe(events[2]!.since);
    // Релиз создан и деплой поставлен один раз: продолжение идет за тем же деплоем.
    expect(ci.calls.filter((x) => /^(create|deploy)/.test(x))).toEqual(['create feature-TEAM-5-4', 'deploy 30474300 21']);
    expect(ci.calls).toContain('pods gate testing-cloud-5');
    expect(logs).toEqual(
      expect.arrayContaining([
        'Деплой feature-TEAM-5-4 на testing-5 поставлен в очередь: https://bamboo.example.org/deploy/viewDeploymentResult.action?deploymentResultId=42',
        'Bamboo: деплой feature-TEAM-5-4: QUEUED',
        'Выкатка подтверждена по логам: под kc-new с образом 1.0.4-246 в testing-cloud-5',
      ]),
    );
  });

  it('keeps the release in the context while it waits and the old deadlines of each wait', async () => {
    const ci = fakeCi({ results: [{ lifeCycle: 'IN_PROGRESS', state: 'UNKNOWN' }] });
    const e = await step.run(setup(ci)).catch((x: { event: WaitEvent; outputs: unknown }) => x);
    expect(e.outputs).toEqual({ release: { id: 21, name: 'feature-TEAM-5-4' } });
    const first = await waitOf(step.run(setup(ci)));
    expect(Date.parse(first.deadline.at) - Date.parse(first.since)).toBe(40 * 60_000);
    expect(first.deadline.error).toBe('Деплой на testing-5 не закончился за 40 минут: https://bamboo.example.org/deploy/viewDeploymentResult.action?deploymentResultId=42');
    const again = await waitOf(step.resume!(setup(ci, { waited: first }), first));
    expect(again).toMatchObject({ kind: 'deploy', since: first.since, deadline: first.deadline });
  });

  it('deploys to the environment of the stand in the deployment project of its own repository', async () => {
    // Стенд core: у каждого сервиса свой проект деплоя и свое окружение Stable.
    const stand: StandProfile = { ...STAND, bambooEnvId: undefined, bambooEnvIds: { 'gate': 777, 'other-service': 888 } };
    const ci = fakeCi({ current: env({ envId: 777 }) });
    const c = setup(ci, { stand });
    expect((await step.preview!(c)).payload).toMatchObject({ envId: 777 });
    await step.run(setup(ci, { stand }));
    expect(ci.calls.filter((x) => x.startsWith('deploy'))).toEqual(['deploy 777 21']);
    await expect(step.preview!(setup(fakeCi({}), { stand: { ...stand, bambooEnvIds: { 'other-service': 888 } } }))).rejects.toThrow('нет окружения в проекте деплоя gate');
  });

  it('reports a failed deployment with the lines of its log that look like errors, without the Grafana noise', async () => {
    const log = ['TASK [deploy]', '[ERROR]: Could not submit message to Grafana: <urlopen error>', 'fatal: [host]: FAILED! => {"msg": "apply timed out"}'];
    const ci = fakeCi({ results: [{ lifeCycle: 'FINISHED', state: 'FAILED', log }] });
    const error = await step.run(setup(ci)).catch((e: Error) => e.message);
    expect(error).toContain('Деплой на testing-5 завершился с FAILED: https://bamboo.example.org/deploy/viewDeploymentResult.action?deploymentResultId=42');
    expect(error).toContain('apply timed out');
    expect(error).not.toContain('Grafana');
  });

  it('checks on a stand with service addresses that the service of the stand answers itself, not Stable in its place', async () => {
    const stand: StandProfile = { ...STAND, url: undefined, realm: undefined, serviceUrl: 'https://{service}-team-a-0.test.example.com', namespace: 'testing-a-0', title: 'Testing-A-0' };
    const health = { health: '/health/readiness' };
    const check = 'https://gate-team-a-0.test.example.com/health/readiness';
    const preview = await step.preview!(setup(fakeCi({}), { stand, repo: health }));
    expect(preview.actions[2]).toBe(`Проверить выкатку: под с образом 1.0.4-246 в testing-a-0 по логам и ответ сервиса ${check} из окружения testing-a-0`);
    // Сначала по адресу сервиса отвечает Stable, потом сам сервис, но еще не готов, и наконец готов.
    const ci = fakeCi({ probe: [{ status: 200, environment: 'stable' }, { status: 503, environment: 'testing-a-0' }, { status: 200, environment: 'testing-a-0' }] });
    const { events, logs } = await deploy(ci, { stand, repo: health });
    expect(ci.calls.filter((x) => x.startsWith('probe'))).toEqual([`probe ${check}`, `probe ${check}`, `probe ${check}`]);
    expect(events.map((e) => e.kind)).toEqual(['rollout', 'rollout']);
    expect(events[0]).toMatchObject({ probe: { url: check, service: true } });
    expect(logs).toContain(`Сервис gate отвечает на стенде testing-a-0: ${check}`);
  });

  it('waits for the service itself when only Stable answers at its address and names that in the error after the deadline', async () => {
    const stand: StandProfile = { ...STAND, url: undefined, realm: undefined, serviceUrl: 'https://{service}-team-a-0.test.example.com', namespace: 'testing-a-0', title: 'Testing-A-0' };
    const e = await waitOf(step.run(setup(fakeCi({ probe: [{ status: 200, environment: 'stable' }] }), { stand })));
    expect(e).toMatchObject({ kind: 'rollout', standId: 'testing-5' });
    expect(Date.parse(e.deadline.at) - Date.parse(e.since)).toBe(10 * 60_000);
    expect(e.deadline.error).toBe('Сервис gate на стенде Testing-A-0 не отвечает сам: https://gate-team-a-0.test.example.com/ ответил со стенда stable: сервиса на Testing-A-0 нет');
  });

  it('waits for the new image in the namespace after a successful deployment and names the newest pod in the error after the deadline', async () => {
    const e = await waitOf(step.run(setup(fakeCi({ pods: [[pod('1.0.273-master', 'old')]] }))));
    expect(e.deadline.error).toBe('Деплой прошел, но за 10 минут в testing-cloud-5 не появился под с образом 1.0.4-246: самый новый под old с 1.0.273-master');
  });

  it('deploys through REST when the k8s-ansible branch of the task is named like the release branch', async () => {
    const ci = fakeCi({ results: [{ lifeCycle: 'FINISHED', state: 'SUCCESS', log: ['Для релиза найдена ветка k8s-ansible: feature/TEAM-5', 'Деплой выполняется из ветки k8s-ansible: feature/TEAM-5'] }] });
    const c = setup(ci, { values: { ansibleBranch: 'feature/TEAM-5' } });
    const p = await step.preview!(c);
    expect(p.actions[1]).toBe('Деплой на testing-5 (Testing-Cloud-5): заменить release-273 на feature-TEAM-5-4, конфиг из ветки k8s-ansible feature/TEAM-5: скрипт деплоя найдет ее по имени ветки релиза');
    expect(p.payload).toMatchObject({ config: { branch: 'feature/TEAM-5', manual: false } });
    await step.run(c);
    expect(ci.calls).toContain('deploy 30474300 21');
    expect(ci.calls.some((x) => x.startsWith('results '))).toBe(false);
    expect(c.logs).toContain('Конфиг деплоя из ветки k8s-ansible feature/TEAM-5');
  });

  it('waits for the Customize Deploy the owner runs in Bamboo when the k8s-ansible branch has another name', async () => {
    const ci = fakeCi({ manualAfter: 2 });
    const values = { ansibleBranch: 'bugfix/TEAM-5-keys' };
    const p = await step.preview!(setup(ci, { values }));
    expect(p.actions[1]).toBe(
      'Customize Deploy на testing-5 (Testing-Cloud-5) с веткой k8s-ansible bugfix/TEAM-5-keys: заменить release-273 на feature-TEAM-5-4; кнопку Deploy в Bamboo нажимаете вы, потому что ветка bugfix/TEAM-5-keys названа не как ветка релиза feature/TEAM-5, скрипт деплоя сам ее не найдет',
    );
    const { outputs, events, logs } = await deploy(ci, { values });
    expect((outputs as { deployedBuild: { resultId: number } }).deployedBuild.resultId).toBe(55);
    expect(events.map((e) => e.kind)).toEqual(['manual-deploy', 'manual-deploy']);
    expect(events[0]).toMatchObject({ kind: 'manual-deploy', contour: 'cloud', envId: 30474300, versionId: 21, deadline: { error: 'За 60 минут деплой feature-TEAM-5-4 на testing-5 так и не запустили' } });
    expect(events[1]!.since).toBe(events[0]!.since);
    expect(ci.calls.some((x) => x.startsWith('deploy '))).toBe(false);
    expect(logs.find((l) => l.includes('Customize Deploy'))).toContain('https://bamboo.example.org/deploy/viewEnvironment.action?id=30474300');
  });

  it('goes through the Customize Deploy form of a contour whose deploy takes the task branch only from it, even when the branch is named like the release branch', async () => {
    const ci = fakeCi({ manualAfter: 2 });
    const values = { ansibleBranch: 'feature/TEAM-5' };
    const p = await step.preview!(setup(ci, { values, contour: CUSTOMIZE }));
    expect(p.actions[1]).toBe(
      'Customize Deploy на testing-5 (Testing-Cloud-5) с веткой k8s-ansible feature/TEAM-5: заменить release-273 на feature-TEAM-5-4; кнопку Deploy в Bamboo нажимаете вы, потому что деплой контура core берет ветку k8s-ansible задачи только из Customize Deploy',
    );
    expect(p.payload).toMatchObject({ config: { branch: 'feature/TEAM-5', manual: true } });
    const { events, logs } = await deploy(ci, { values, contour: CUSTOMIZE });
    expect(events.map((e) => e.kind)).toEqual(['manual-deploy', 'manual-deploy']);
    expect(ci.calls.some((x) => x.startsWith('deploy '))).toBe(false);
    expect(logs).toContain(
      'С веткой k8s-ansible feature/TEAM-5 деплой идет через Customize Deploy: откройте https://bamboo2.example.org/plugins/deploy/customDeploymentVersion.action?environmentId=30474300&versionId=21, выберите окружение Testing-Cloud-5, релиз feature-TEAM-5-4 и ветку k8s-ansible feature/TEAM-5 и нажмите Deploy. Шаг сам найдет этот деплой',
    );
  });

  it('sends the release-named branch of k8s-ansible through the form in such a contour and deploys master as usual without a task branch', async () => {
    const own = setup(fakeCi({}), { contour: CUSTOMIZE, deployRepo: DEPLOY_REPO, git: fakeGit(['master', 'feature/TEAM-5']) });
    expect((await step.preview!(own)).payload).toMatchObject({ config: { branch: 'feature/TEAM-5', manual: true } });
    const none = setup(fakeCi({}), { contour: CUSTOMIZE, deployRepo: DEPLOY_REPO, git: fakeGit(['master']) });
    expect((await step.preview!(none)).payload).toMatchObject({ config: { branch: 'master', manual: false } });
  });

  it('checks that the Customize Deploy took the k8s-ansible branch of the task', async () => {
    const ci = fakeCi({ results: [{ lifeCycle: 'FINISHED', state: 'SUCCESS', log: ['Деплой выполняется из ветки k8s-ansible: master'] }] });
    const c = setup(ci, { values: { ansibleBranch: 'bugfix/TEAM-5-keys' } });
    await expect(step.run(c)).rejects.toThrow('Деплой на testing-5 прошел с конфигом из ветки k8s-ansible master, а нужна bugfix/TEAM-5-keys: повторите Customize Deploy с веткой bugfix/TEAM-5-keys');
    const right = fakeCi({ results: [{ lifeCycle: 'FINISHED', state: 'SUCCESS', log: ['TASK [x]', 'Деплой выполняется из ветки k8s-ansible: bugfix/TEAM-5-keys'] }] });
    const ok = setup(right, { values: { ansibleBranch: 'bugfix/TEAM-5-keys' } });
    await step.run(ok);
    expect(ok.logs).toContain('Конфиг деплоя из ветки k8s-ansible bugfix/TEAM-5-keys');
  });

  it('tells from the deploy repository which k8s-ansible branch the deployment will take', async () => {
    const own = setup(fakeCi({}), { deployRepo: DEPLOY_REPO, git: fakeGit(['master', 'feature/TEAM-5']) });
    expect((await step.preview!(own)).actions[1]).toBe('Деплой на testing-5 (Testing-Cloud-5): заменить release-273 на feature-TEAM-5-4, конфиг из ветки k8s-ansible feature/TEAM-5: скрипт деплоя найдет ее по имени ветки релиза');
    const git = fakeGit(['master']);
    const none = setup(fakeCi({}), { deployRepo: DEPLOY_REPO, git });
    expect((await step.preview!(none)).actions[1]).toBe('Деплой на testing-5 (Testing-Cloud-5): заменить release-273 на feature-TEAM-5-4, конфиг из ветки k8s-ansible master: ветки feature/TEAM-5 в k8s-ansible нет');
    expect(git.calls).toEqual([['ls-remote', '--heads', 'origin', 'refs/heads/feature/TEAM-5']]);
  });

  it('fails when the deployment took another k8s-ansible branch than the approval showed', async () => {
    const ci = fakeCi({ results: [{ lifeCycle: 'FINISHED', state: 'SUCCESS', log: ['Деплой выполняется из ветки k8s-ansible: master'] }] });
    const c = setup(ci, { deployRepo: DEPLOY_REPO, git: fakeGit(['feature/TEAM-5']) });
    await expect(step.run(c)).rejects.toThrow('Деплой на testing-5 прошел с конфигом из ветки k8s-ansible master, а на подтверждении была feature/TEAM-5: проверьте ветки k8s-ansible и повторите шаг');
  });

  it('only notes the k8s-ansible branch when it could not tell it in advance', async () => {
    const noRepo = setup(fakeCi({ results: [{ lifeCycle: 'FINISHED', state: 'SUCCESS', log: ['Деплой выполняется из ветки k8s-ansible: feature/TEAM-9'] }] }));
    expect((await step.preview!(noRepo)).actions[1]).toBe('Деплой на testing-5 (Testing-Cloud-5): заменить release-273 на feature-TEAM-5-4');
    await step.run(noRepo);
    expect(noRepo.logs).toContain('Конфиг деплоя из ветки k8s-ansible feature/TEAM-9');
    const offline = setup(fakeCi({}), { deployRepo: DEPLOY_REPO, git: fakeGit([], true) });
    await step.run(offline);
    expect(offline.logs).toContain('Не удалось узнать, есть ли ветка feature/TEAM-5 в k8s-ansible: fatal: unable to access remote');
    expect(offline.logs).toContain('В логе деплоя нет строки о ветке k8s-ansible: из какой ветки шел конфиг, проверить нечем');
  });

  it('reads the k8s-ansible branch from the line of one deploy script and from the git branch line after the clone in another', () => {
    // Строки лога деплоя контура core вокруг клона k8s-ansible, как их отдает Bamboo.
    const core = (branch: string) => ["Starting task 'Script' of type 'com.atlassian.bamboo.plugins.scripttask:task.builder.script'", "Cloning into 'k8s-ansible'...", "Warning: Permanently added '[git.example.com]:7999' (RSA) to the list of known hosts.", 'Return code: 0', branch, 'Launching the api adapter deployment'];
    expect(ansibleBranchOf(['TASK [x]', 'Деплой выполняется из ветки k8s-ansible: feature/TEAM-5'])).toBe('feature/TEAM-5');
    expect(ansibleBranchOf(core('* master'))).toBe('master');
    expect(ansibleBranchOf(core('* feature/TEAM-2586'))).toBe('feature/TEAM-2586');
    // Между клоном и веткой git печатает ход клона десятками строк.
    const progress = Array.from({ length: 40 }, (_x, i) => `Updating files: ${i + 60}% (${i}/4478)`);
    expect(ansibleBranchOf(["Cloning into 'k8s-ansible'...", ...progress, 'Updating files: 100% (4478/4478), done.', 'Return code: 0', '* master'])).toBe('master');
    // Отсоединенный HEAD, строка со звездочкой уже в выводе ansible и без клона веткой не считаются.
    expect(ansibleBranchOf(core('* (HEAD detached at c6cd4c8)'))).toBeNull();
    expect(ansibleBranchOf(["Cloning into 'k8s-ansible'...", 'PLAY [localhost] ****', 'TASK [x] ****', '* item'])).toBeNull();
    expect(ansibleBranchOf(['* master'])).toBeNull();
  });

  it('does not count a release deployed in core with master when the task has its own k8s-ansible branch', async () => {
    const release = { id: 11, name: 'feature-TEAM-5-4', buildKey: 'BUILDS-P246-4', branch: 'feature-TEAM-5' };
    const current = env({ version: { id: 11, name: 'feature-TEAM-5-4' }, resultId: 77 });
    const log = (branch: string) => ["Cloning into 'k8s-ansible'...", 'Return code: 0', `* ${branch}`];
    expect(await step.done!(setup(fakeCi({ versions: [release], current, results: [{ log: log('master') }] }), { values: { ansibleBranch: 'feature/TEAM-5' } }))).toBeNull();
    expect(await step.done!(setup(fakeCi({ versions: [release], current, results: [{ log: log('feature/TEAM-5') }] }), { values: { ansibleBranch: 'feature/TEAM-5' } }))).toMatchObject({ note: 'На testing-5 уже выкачен feature-TEAM-5-4' });
  });

  it('does not count a release deployed with another k8s-ansible branch than the task needs now', async () => {
    const release = { id: 11, name: 'feature-TEAM-5-4', buildKey: 'BUILDS-P246-4', branch: 'feature-TEAM-5' };
    const current = env({ version: { id: 11, name: 'feature-TEAM-5-4' }, resultId: 77 });
    const master = fakeCi({ versions: [release], current, results: [{ log: ['Деплой выполняется из ветки k8s-ansible: master'] }] });
    expect(await step.done!(setup(master, { values: { ansibleBranch: 'feature/TEAM-5' } }))).toBeNull();
    const own = fakeCi({ versions: [release], current, results: [{ log: ['Деплой выполняется из ветки k8s-ansible: feature/TEAM-5'] }] });
    expect(await step.done!(setup(own, { values: { ansibleBranch: 'feature/TEAM-5' } }))).toMatchObject({ note: 'На testing-5 уже выкачен feature-TEAM-5-4' });
  });

  it('is done when the stand already runs the release of the build and the pod has its image', async () => {
    const release = { id: 11, name: 'feature-TEAM-5-4', buildKey: 'BUILDS-P246-4', branch: 'feature-TEAM-5' };
    const deployed = fakeCi({ versions: [release], current: env({ version: { id: 11, name: 'feature-TEAM-5-4' }, resultId: 77 }) });
    expect(await step.done!(setup(deployed))).toMatchObject({ note: 'На testing-5 уже выкачен feature-TEAM-5-4', outputs: { deployedBuild: { resultId: 77, tag: '1.0.4-246' } } });
    const replaced = fakeCi({ versions: [release], current: env({ version: { id: 11, name: 'feature-TEAM-5-4' } }), pods: [[pod('1.0.9-250')]] });
    expect(await step.done!(setup(replaced))).toBeNull();
    expect(await step.done!(setup(fakeCi({ versions: [release] })))).toBeNull();
  });

  it('uses the release someone created while the step waited for the approval', async () => {
    const ci = fakeCi({ createFails: true });
    const out = (await step.run(setup(ci))) as { release: { name: string } };
    expect(out.release.name).toBe('feature-TEAM-5-4');
  });

  it('goes on after a restart of the wait without a second release or deployment and refuses when the release is gone', async () => {
    const ci = fakeCi({ results: [{ lifeCycle: 'IN_PROGRESS', state: 'UNKNOWN' }, { lifeCycle: 'FINISHED', state: 'SUCCESS' }] });
    const first = await waitOf(step.run(setup(ci)));
    expect(await step.resume!(setup(ci, { waited: first }), first)).toMatchObject({ deployedBuild: { resultId: 42 } });
    expect(ci.calls.filter((x) => /^(create|deploy)/.test(x))).toEqual(['create feature-TEAM-5-4', 'deploy 30474300 21']);
    await expect(step.resume!(setup(fakeCi({})), first)).rejects.toThrow('Релиза сборки BUILDS-P246-4 больше нет в Bamboo: повторите шаг');
  });

  it('refuses to deploy without a build from the build step', async () => {
    await expect(step.preview!(setup(fakeCi({}), { values: { build: { ...BUILD, key: 'dry-run' } } }))).rejects.toThrow('сначала нужен шаг "Сборка ветки"');
  });
});
