import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deployBlockReason, standsFromBamboo } from '@task-pilot/step-kit';
import { applyPersonal, DEMO_TEAM, loadClaudeMcp, loadConfig, loadPersonal, loadProfiles, loadTeam, NO_PERSONAL, ROOT, teamLayers, type ProfileLayer } from '../src/config.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = (prefix = 'task-pilot-profiles-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Учебный слой компании example из репозитория Task Pilot. */
const COMPANY = join(ROOT, 'company', 'example');
/** Пакет команды для тестов: сервисы в контурах учебного слоя компании example. */
const TEAM = join(ROOT, 'apps', 'server', 'test', 'fixtures', 'team');
const LAYERS: ProfileLayer[] = [
  { label: 'company/example', dir: COMPANY },
  { label: 'team', dir: join(TEAM, 'profiles') },
];

/** Копии слоев во временной папке: их можно портить, проверяя отказы загрузки. */
function copyLayers(): { company: string; team: string; layers: ProfileLayer[] } {
  const dir = tempDir();
  const company = join(dir, 'company');
  const team = join(dir, 'team');
  cpSync(COMPANY, company, { recursive: true });
  cpSync(join(TEAM, 'profiles'), team, { recursive: true });
  return { company, team, layers: [{ label: 'company', dir: company }, { label: 'team', dir: team }] };
}

const edit = (file: string, from: string, to: string) => writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));

describe('company layer example under a team pack', () => {
  const profiles = loadProfiles(LAYERS);

  it('stacks the layers: contours, deploy config repositories and log sources of the company, services, stands and the board of the team', () => {
    expect(profiles.contours.map((c) => c.id)).toEqual(['cloud', 'core']);
    // Репозитории и контуры идут по id, как файлы одной папки, в каком бы слое ни лежал профиль.
    expect(profiles.repos.map((r) => r.id)).toEqual(['adapter', 'api', 'gate', 'gate-theme', 'k8s-ansible-cloud', 'k8s-ansible-core', 'mobile', 'proxy']);
    expect(Object.keys(profiles.logs)).toEqual(['kibana-cloud', 'kibana-core']);
    expect(profiles.stands.map((s) => s.id)).toEqual(['load', 'stable', 'testing-1']);
    // Адрес Jira и поля - компании, путь и вехи - команды.
    expect(profiles.jira).toMatchObject({ baseUrl: 'https://jira.example.com', sprintField: 'customfield_10330', epicField: 'customfield_10933', milestones: { merged: 'Merged' } });
    expect(profiles.jira.path.map((p) => p.id)).toEqual(['1', '2', '3', '4']);
    // Источник логов прода - компании, сервисы и задачи панели - команды.
    expect(profiles.monitor).toMatchObject({ source: { id: 'es-prod', mcp: 'elasticsearch' }, services: [{ id: 'gate' }], tasksJql: expect.stringContaining('project = TEAM') });
  });

  it('expands ~ in repository paths and has exactly one default repository', () => {
    const gate = profiles.repos.find((r) => r.id === 'gate');
    expect(gate?.path).toBe(join(homedir(), 'src/gate'));
    expect(gate?.worktreesDir.includes('~')).toBe(false);
    expect(profiles.repos.filter((r) => r.default).map((r) => r.id)).toEqual(['gate']);
  });

  it('link the services of a team to the deploy config repository of their contour in the company layer', () => {
    expect(profiles.repos.find((r) => r.id === 'gate')?.deployRepo).toBe('k8s-ansible-cloud');
    for (const id of ['api', 'mobile', 'adapter', 'proxy']) expect(profiles.repos.find((r) => r.id === id)?.deployRepo).toBe('k8s-ansible-core');
    expect(profiles.repos.find((r) => r.id === 'k8s-ansible-core')).toMatchObject({ contour: 'core', bitbucket: { project: 'DEVOPS', repo: 'k8s-ansible' } });
    expect(profiles.contours.find((c) => c.id === 'core')?.stands).toMatchObject({ serviceUrl: 'https://{service}-{host}.test.example.com', host: { from: '^testing-', to: 'team-' } });
    // Ветку k8s-ansible задачи деплой контура core берет только из Customize Deploy, контура cloud - сам по имени.
    expect(profiles.contours.find((c) => c.id === 'core')?.deploy).toEqual({ ansibleBranch: 'customize', customizeUrl: 'https://bamboo.example.com/plugins/deploy/customDeploymentVersion.action' });
    expect(profiles.contours.find((c) => c.id === 'cloud')?.deploy).toBeUndefined();
    expect(profiles.logs['kibana-core']).toMatchObject({ messageField: 'messagetext', loggerField: 'logger', dataView: '00000000-0000-4000-8000-000000000002' });
  });

  it('never allow deploying to production', () => {
    const cloud = profiles.contours.find((c) => c.id === 'cloud');
    expect(cloud?.forbiddenBambooEnvIds).toContain(24674389);
    expect(profiles.stands.some((s) => /prod|reserve|staging/i.test(`${s.namespace} ${s.bambooEnv}`))).toBe(false);
    const deployable = profiles.stands.filter((s) => deployBlockReason(s, profiles.contours.find((c) => c.id === s.contour)) === null);
    expect(deployable.map((s) => s.id).sort()).toEqual(['stable', 'testing-1']);
  });

  it('forbid Production, Reserve and Staging of every core service and take Stable and the testing stands from Bamboo by the rule', () => {
    const core = profiles.contours.find((c) => c.id === 'core')!;
    expect(core.connected).toBe(true);
    // Production, Reserve и Staging четырех сервисов контура core.
    expect(core.forbiddenBambooEnvIds).toEqual(expect.arrayContaining([531631202, 531631203, 531631204, 620726234, 620726235, 620726236, 649986389, 649986390, 649986391, 565674233, 565674234, 565674235]));
    expect(core.stands).toMatchObject({ include: '^(Stable|Testing-.+)$', idPrefix: 'core-', logs: 'kibana-core' });
    // Стенды контура core в файлах не описаны: их список Task Pilot читает из Bamboo.
    expect(profiles.stands.filter((s) => s.contour === 'core')).toEqual([]);
    const services = ['mobile', 'api', 'adapter', 'proxy'];
    for (const repo of services) expect(profiles.repos.find((r) => r.id === repo)?.bamboo?.deploymentProject).toBeTypeOf('number');
    // Окружения, как их отдает Bamboo: у Stable id следующий за Production, Reserve и Staging.
    const envs = Object.fromEntries(
      services.map((repo, i) => {
        const base = [531631202, 620726234, 649986389, 565674233][i]!;
        return [repo, ['Production', 'Reserve', 'Staging', 'Stable', 'Testing-A-0'].map((envName, j) => ({ envId: base + j, envName }))];
      }),
    );
    const stands = standsFromBamboo(core, envs);
    expect(stands.map((s) => s.id)).toEqual(['core-stable', 'core-testing-a-0']);
    expect(stands.every((s) => deployBlockReason(s, core) === null)).toBe(true);
    for (const repo of services) expect(deployBlockReason(stands[0]!, core, repo)).toBeNull();
    expect(stands[0]).toMatchObject({ namespace: 'stable', logs: 'kibana-core', notes: ['Общий стенд, сюда же ставят ветки других задач'] });
  });
});

describe('profile layers', () => {
  it('refuse a deploy config repository that is unknown or lives in another contour', () => {
    const { team, layers } = copyLayers();
    const file = join(team, 'repos', 'gate.yaml');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('deployRepo: k8s-ansible-cloud', 'deployRepo: k8s-ansible-nowhere'));
    expect(() => loadProfiles(layers)).toThrow('Профиль репозитория gate: неизвестный репозиторий деплоя k8s-ansible-nowhere');
    writeFileSync(file, original.replace('deployRepo: k8s-ansible-cloud', 'deployRepo: mobile'));
    expect(() => loadProfiles(layers)).toThrow('Профиль репозитория gate: репозиторий деплоя mobile из контура core, а не cloud');
  });

  it('read a file with a list of stands and refuse a stand described twice or an environment of an unknown repository', () => {
    const { company, team, layers } = copyLayers();
    const file = join(team, 'stands', 'list.yaml');
    const stand = (id: string, env: string) =>
      `- id: ${id}\n  title: ${env}\n  contour: core\n  namespace: ${env.toLowerCase()}\n  bambooEnv: ${env}\n  bambooEnvIds: { mobile: 1, adapter: 2 }\n  logs: kibana-core\n  deployable: true\n`;
    const original = stand('core-extra-1', 'Extra-1') + stand('core-extra-2', 'Extra-2');
    writeFileSync(file, original);
    expect(loadProfiles(layers).stands.filter((s) => s.contour === 'core').map((s) => s.id)).toEqual(['core-extra-1', 'core-extra-2']);
    writeFileSync(join(team, 'stands', 'more.yaml'), stand('core-extra-1', 'Extra-1'));
    expect(() => loadProfiles(layers)).toThrow('Стенд core-extra-1 описан дважды');
    rmSync(join(team, 'stands', 'more.yaml'));
    writeFileSync(file, original.replace('mobile: 1', 'mobile-id: 1'));
    expect(() => loadProfiles(layers)).toThrow('Профиль стенда core-extra-1: неизвестный репозиторий mobile-id в bambooEnvIds');
    writeFileSync(file, original.replace('mobile: 1', 'gate: 1'));
    expect(() => loadProfiles(layers)).toThrow('Профиль стенда core-extra-1: репозиторий gate из контура cloud, а стенд - из core');
    writeFileSync(file, original.replace('  bambooEnv: Extra-1\n', '  bambooEnv: Extra-1\n  bambooEnvId: 1\n'));
    expect(() => loadProfiles(layers)).toThrow('нужен ровно один из bambooEnvId и bambooEnvIds');
    rmSync(file);
    const service = join(team, 'repos', 'adapter.yaml');
    const text = readFileSync(service, 'utf8');
    writeFileSync(service, text.replace('keycloak: { stand: stable,', 'keycloak: { stand: nowhere,'));
    expect(() => loadProfiles(layers)).toThrow('Профиль репозитория adapter: стенд Keycloak nowhere для теста не найден');
    writeFileSync(service, text);
    edit(join(company, 'contours', 'core.yaml'), 'logs: kibana-core', 'logs: kibana-nowhere');
    expect(() => loadProfiles(layers)).toThrow('Профиль контура core: неизвестный источник логов стендов kibana-nowhere');
  });

  it('refuse service addresses on stands without the header that tells the environment of a service', () => {
    const { company, team, layers } = copyLayers();
    const contour = join(company, 'contours', 'core.yaml');
    const text = readFileSync(contour, 'utf8');
    writeFileSync(contour, text.replace('serviceHeader: x-environment', ''));
    expect(() => loadProfiles(layers)).toThrow('Профиль контура core: у адреса сервисов на стендах нужен serviceHeader');
    writeFileSync(contour, text.replace(/\n  serviceUrl: .*\n/, '\n').replace('serviceHeader: x-environment', ''));
    writeFileSync(join(team, 'stands', 'svc.yaml'), 'id: core-svc\ntitle: Svc\ncontour: core\nserviceUrl: https://{service}.example.org\nnamespace: svc\nbambooEnv: Svc\nbambooEnvIds: { mobile: 1 }\nlogs: kibana-core\ndeployable: true\n');
    expect(() => loadProfiles(layers)).toThrow('Профиль стенда core-svc: у адреса сервисов нужен serviceHeader контура core');
  });

  it('refuse the same contour, repository, stand or log source in two layers: one layer does not silently replace another', () => {
    for (const [sub, file, what] of [
      ['contours', 'core.yaml', 'Контур core описан дважды'],
      ['repos', 'k8s-ansible-core.yaml', 'Репозиторий k8s-ansible-core описан дважды'],
    ] as const) {
      const { company, team, layers } = copyLayers();
      mkdirSync(join(team, sub), { recursive: true });
      cpSync(join(company, sub, file), join(team, sub, file));
      expect(() => loadProfiles(layers)).toThrow(what);
    }
    const stands = copyLayers();
    mkdirSync(join(stands.company, 'stands'));
    cpSync(join(stands.team, 'stands', 'stable.yaml'), join(stands.company, 'stands', 'stable.yaml'));
    expect(() => loadProfiles(stands.layers)).toThrow('Стенд stable описан дважды');
    const logs = copyLayers();
    writeFileSync(join(logs.team, 'logs.yaml'), 'kibana-cloud:\n  kind: kibana\n  url: https://kibana.example.org\n  index: other-*\n');
    expect(() => loadProfiles(logs.layers)).toThrow('Источник логов kibana-cloud описан дважды');
  });

  it('lay the keys of the team jira.yaml and monitor.yaml over the company ones and merge the lint lists', () => {
    const { company, team, layers } = copyLayers();
    writeFileSync(join(team, 'jira.yaml'), `${readFileSync(join(team, 'jira.yaml'), 'utf8')}baseUrl: https://jira.example.org\n`);
    writeFileSync(join(team, 'monitor.yaml'), `${readFileSync(join(team, 'monitor.yaml'), 'utf8')}source: { id: team-prod, mcp: team-es }\n`);
    writeFileSync(join(company, 'lint.yaml'), 'names: [Петров]\nallowEmails: [support@example.org]\n');
    writeFileSync(join(team, 'lint.yaml'), 'names: [Сидоров, Петров]\n');
    const p = loadProfiles(layers);
    expect(p.jira).toMatchObject({ baseUrl: 'https://jira.example.org', sprintField: 'customfield_10330' });
    expect(p.monitor?.source).toEqual({ id: 'team-prod', mcp: 'team-es' });
    expect(p.lint).toEqual({ names: ['Петров', 'Сидоров'], allowEmails: ['support@example.org'] });
  });

  it('refuse a board without jira.yaml in any layer and a board that is invalid after the merge, naming the layers', () => {
    const { company, team, layers } = copyLayers();
    const board = readFileSync(join(team, 'jira.yaml'), 'utf8');
    rmSync(join(team, 'jira.yaml'));
    rmSync(join(company, 'jira.yaml'));
    expect(() => loadProfiles(layers)).toThrow('Нет профиля доски jira.yaml ни в одном слое: company, team');
    writeFileSync(join(team, 'jira.yaml'), board);
    expect(() => loadProfiles(layers)).toThrow('Профиль доски (jira.yaml: company, team): baseUrl');
  });
});

describe('team pack', () => {
  it('names its company layer, and the demo team of Task Pilot is a pack without one', () => {
    const team = loadTeam(ROOT, TEAM);
    expect(team).toMatchObject({ id: 'fixture', title: 'Команда тестов', dir: TEAM, company: { id: 'example', dir: COMPANY } });
    expect(teamLayers(team).map((l) => l.dir)).toEqual([COMPANY, join(TEAM, 'profiles')]);
    const demo = loadTeam(ROOT, DEMO_TEAM);
    expect(demo).toMatchObject({ id: 'demo', company: null });
    expect(teamLayers(demo).map((l) => l.label)).toEqual(['examples/demo/profiles']);
    expect(loadProfiles(teamLayers(demo)).repos.map((r) => r.id)).toEqual(['demo-calculator']);
  });

  it('is required and must have a valid team.yaml and an existing company layer', () => {
    expect(() => loadTeam(ROOT, undefined)).toThrow('Не задан пакет команды: укажите team в личных настройках ~/.task-pilot/profile.yaml или переменную TASK_PILOT_TEAM (пример пакета - examples/demo)');
    const dir = tempDir('task-pilot-team-');
    expect(() => loadTeam(ROOT, dir)).toThrow('нет team.yaml');
    writeFileSync(join(dir, 'team.yaml'), 'id: other\ntitle: Другая\ncompany: nowhere\n');
    expect(() => loadTeam(ROOT, dir)).toThrow('Пакет команды other: слоя компании nowhere нет, ждется папка company/nowhere');
    writeFileSync(join(dir, 'team.yaml'), 'id: other\ntitel: Другая\n');
    expect(() => loadTeam(ROOT, dir)).toThrow('team.yaml:');
  });
});

describe('personal settings', () => {
  const team = loadProfiles(LAYERS);
  const repo = (p: typeof team, id: string) => p.repos.find((r) => r.id === id)!;

  it('are absent from the profiles of the layers: no Jira login and no JDK path of a particular machine', () => {
    expect(team.jira.me).toBe('');
    expect(team.repos.filter((r) => r.build?.javaHome).map((r) => r.id)).toEqual([]);
    const demo = loadProfiles(teamLayers(loadTeam(ROOT, DEMO_TEAM)));
    expect(demo.jira.me).toBe('');
    expect(demo.repos.filter((r) => r.build?.javaHome)).toEqual([]);
  });

  it('are optional: without the file the profiles of the layers are used as they are', () => {
    expect(loadPersonal(join(tempDir('task-pilot-personal-'), 'profile.yaml'))).toEqual(NO_PERSONAL);
    expect(applyPersonal(team, NO_PERSONAL)).toEqual(team);
  });

  it('give the Jira login, the JDK to Java builds only, repository paths on this machine and the default repository', () => {
    const p = applyPersonal(team, {
      me: 'colleague',
      javaHome: '~/jdk21',
      defaultRepo: 'adapter',
      repos: { adapter: { path: '~/work/adapter', worktreesDir: '/work/wt' } },
      lintNames: [],
    });
    expect(p.jira.me).toBe('colleague');
    expect(repo(p, 'gate').build?.javaHome).toBe(join(homedir(), 'jdk21'));
    expect(repo(p, 'mobile').build?.javaHome).toBe(join(homedir(), 'jdk21'));
    expect(repo(p, 'gate-theme').build).toMatchObject({ command: 'npm run build', javaHome: undefined });
    expect(repo(p, 'adapter')).toMatchObject({ path: join(homedir(), 'work/adapter'), worktreesDir: '/work/wt', default: true });
    expect(repo(p, 'mobile').path).toBe(repo(team, 'mobile').path);
    expect(p.repos.filter((r) => r.default).map((r) => r.id)).toEqual(['adapter']);
  });

  it('keep the JDK a profile of a layer sets itself', () => {
    const own = { ...team, repos: team.repos.map((r) => (r.build ? { ...r, build: { ...r.build, javaHome: '/team/jdk' } } : r)) };
    expect(repo(applyPersonal(own, { ...NO_PERSONAL, javaHome: '/my/jdk' }), 'gate').build?.javaHome).toBe('/team/jdk');
  });

  it('add names for the linter on top of the list of the layers', () => {
    const withTeam = { ...team, lint: { ...team.lint, names: ['Петров'] } };
    expect(applyPersonal(withTeam, { ...NO_PERSONAL, lintNames: ['Сидоров', 'Петров'] }).lint.names).toEqual(['Петров', 'Сидоров']);
  });

  it('refuse an unknown repository and an unknown or misspelled field, naming the file', () => {
    expect(() => applyPersonal(team, { ...NO_PERSONAL, repos: { nowhere: { path: '/x' } } })).toThrow('Личные настройки: неизвестный репозиторий nowhere');
    expect(() => applyPersonal(team, { ...NO_PERSONAL, defaultRepo: 'nowhere' })).toThrow('Личные настройки: неизвестный репозиторий по умолчанию nowhere');
    const file = join(tempDir('task-pilot-personal-'), 'profile.yaml');
    writeFileSync(file, 'me: colleague\njavahome: /jdk\n');
    expect(() => loadPersonal(file)).toThrow(`Личные настройки ${file}:`);
    writeFileSync(file, '# только комментарий\n');
    expect(loadPersonal(file)).toEqual(NO_PERSONAL);
  });

  it('are read by loadConfig from TASK_PILOT_PERSONAL, whose team names the pack unless TASK_PILOT_TEAM names another', () => {
    const dir = tempDir('task-pilot-personal-');
    const file = join(dir, 'profile.yaml');
    writeFileSync(file, `me: colleague\njavaHome: ~/jdk21\nteam: ${TEAM}\n`);
    const env = { TASK_PILOT_PERSONAL: file, TASK_PILOT_CLAUDE_JSON: join(dir, 'claude.json'), TASK_PILOT_DATA: join(dir, 'data') };
    const config = loadConfig(env);
    expect(config.personalFile).toBe(file);
    expect(config.team.id).toBe('fixture');
    expect(config.profiles.jira.me).toBe('colleague');
    expect(repo(config.profiles, 'gate').build?.javaHome).toBe(join(homedir(), 'jdk21'));
    expect(config.dashboardsDir).toBe(join(TEAM, 'dashboards'));
    expect(config.pluginDir).toBe(join(TEAM, 'plugin'));
    expect(loadConfig({ ...env, TASK_PILOT_TEAM: DEMO_TEAM }).team.id).toBe('demo');
  });

  it('keep the repository paths of their own pack away from another pack such as the demo team', () => {
    const dir = tempDir('task-pilot-personal-');
    const file = join(dir, 'profile.yaml');
    writeFileSync(file, `javaHome: /jdk21\nteam: ${TEAM}\ndefaultRepo: adapter\nrepos:\n  adapter: { path: ~/work/adapter }\n`);
    const env = { TASK_PILOT_PERSONAL: file, TASK_PILOT_CLAUDE_JSON: join(dir, 'claude.json'), TASK_PILOT_TEAM: DEMO_TEAM };
    expect(() => loadConfig(env)).toThrow('Личные настройки: неизвестный репозиторий adapter');
    const demo = loadConfig(env, { otherTeam: true });
    expect(demo.profiles.repos.map((r) => [r.id, r.default, r.build?.javaHome])).toEqual([['demo-calculator', true, '/jdk21']]);
  });

  it('refuse default test logs of a team from a source no layer has', () => {
    const dir = tempDir('task-pilot-personal-');
    const pack = join(dir, 'pack');
    cpSync(TEAM, pack, { recursive: true });
    edit(join(pack, 'team.yaml'), 'source: kibana-cloud', 'source: kibana-nowhere');
    expect(() => loadConfig({ TASK_PILOT_PERSONAL: join(dir, 'profile.yaml'), TASK_PILOT_CLAUDE_JSON: join(dir, 'claude.json'), TASK_PILOT_TEAM: pack })).toThrow(
      'Пакет команды fixture: источника логов kibana-nowhere из qa.logs нет в logs.yaml слоев',
    );
  });
});

describe('loadClaudeMcp', () => {
  it('reads stdio servers, skips remote ones and collects secret values for masking', () => {
    const file = join(tempDir('task-pilot-config-'), 'claude.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          atlassian: { command: 'uvx', args: ['mcp-atlassian'], env: { JIRA_URL: 'https://jira.example.org', JIRA_PERSONAL_TOKEN: 'jira-secret-token-1' } },
          remote: { type: 'http', url: 'https://mcp.example.org' },
        },
      }),
    );
    const { servers, secrets } = loadClaudeMcp(file);
    expect(Object.keys(servers)).toEqual(['atlassian']);
    expect(secrets).toEqual(['jira-secret-token-1']);
  });

  it('returns nothing when the file does not exist', () => {
    expect(loadClaudeMcp('/nonexistent/claude.json')).toEqual({ servers: {}, secrets: [] });
  });
});
