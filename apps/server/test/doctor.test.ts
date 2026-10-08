import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, ROOT, type AppConfig } from '../src/config.ts';
import { doctorChecks, formatDoctor, javaMajor, parseDu, type Facts } from '../src/doctor.ts';
import type { DoctorCheckDto } from '@task-pilot/api-types';
import { activeIntegrationsIn, Store } from '../src/store/db.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-pilot-doctor-'));
  dirs.push(dir);
  return dir;
};

/** MCP-серверы всех подключенных интеграций профилей, с закрепленными версиями пакетов. */
const SERVERS: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
  atlassian: { command: 'uvx', args: ['mcp-atlassian==0.23.1'], env: { CONFLUENCE_URL: 'https://wiki.example.org' } },
  bitbucket: { command: 'npx', args: ['-y', '@nexus2520/bitbucket-mcp-server@3.0.0'] },
  'bitbucket-core': { command: 'npx', args: ['-y', '@nexus2520/bitbucket-mcp-server@3.0.0'] },
  bamboo: { command: 'npx', args: ['-y', 'bamboo-mcp-server@1.2.0'] },
  'bamboo-cloud': { command: 'npx', args: ['-y', 'bamboo-mcp-server@1.2.0'] },
  elasticsearch: { command: 'npx', args: ['-y', '@elastic/mcp-server-elasticsearch@0.3.1'], env: { ES_URL: 'https://es.example.org' } },
};

/** Пакет команды для тестов: сервисы в контурах учебного слоя компании example. */
const TEAM = join(ROOT, 'apps', 'server', 'test', 'fixtures', 'team');

/** Конфигурация по пакету команды тестов с личными настройками personal и MCP-серверами servers. */
function configWith(personal: string | null = 'me: colleague\njavaHome: /jdk21\n', servers = SERVERS): AppConfig {
  const dir = tempDir();
  writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: servers }));
  if (personal !== null) writeFileSync(join(dir, 'profile.yaml'), personal);
  return loadConfig({ TASK_PILOT_CLAUDE_JSON: join(dir, 'claude.json'), TASK_PILOT_PERSONAL: join(dir, 'profile.yaml'), TASK_PILOT_DATA: join(dir, 'data'), TASK_PILOT_TEAM: TEAM });
}

/** Машина, на которой все на месте. */
function facts(config: AppConfig, over: Partial<Facts> = {}): Facts {
  return {
    platform: 'darwin',
    node: '26.7.0',
    nodeWanted: 26,
    pnpm: '10.34.5',
    pnpmWanted: '10.34.5',
    git: 'git version 2.54.0',
    gitCredentialHelper: 'osxkeychain',
    hooksPath: '.githooks',
    mvn: 'Apache Maven 3.9.16',
    jdks: { '/jdk21': 21 },
    claude: { exists: true, version: '2.1.280 (Claude Code)', auth: { loggedIn: true, method: 'claude.ai', email: 'owner@example.org', org: 'Команда', plan: 'team' }, authError: null },
    sandbox: { available: true, missing: 'нет /usr/bin/sandbox-exec' },
    chrome: { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', exists: true },
    clones: Object.fromEntries(config.profiles.repos.map((r) => [r.path, true])),
    tokenIntegrations: [],
    personalExists: true,
    plugin: { manifest: true, skills: ['stand-qa', 'wiki-pages'] },
    sizes: { db: 950_000, agents: 17 * 1024 ** 2, qaProfile: 231 * 1024 ** 2 },
    backups: [{ file: '/data/backups/task-pilot-2026-09-24T10-00-00.db', at: new Date('2026-09-24T10:00:00Z'), size: 950_000 }],
    now: new Date('2026-09-24T12:00:00Z'),
    ...over,
  };
}

const byId = (checks: DoctorCheckDto[], id: string) => checks.find((c) => c.id === id)!;

describe('environment check', () => {
  it('finds nothing to fix on a Mac where everything is in place', () => {
    const config = configWith();
    const checks = doctorChecks(config, facts(config));
    expect(checks.map((c) => c.id)).toEqual(['node', 'pnpm', 'git', 'sandbox', 'claude', 'team', 'personal', 'jira-login', 'jdk', 'maven', 'repos', 'mcp', 'mcp-versions', 'plugin', 'chrome', 'git-hooks', 'git-credentials', 'data']);
    expect(checks.filter((c) => c.level !== 'ok')).toEqual([]);
    expect(byId(checks, 'jdk').detail).toBe('/jdk21 для adapter, api, gate, mobile');
    expect(byId(checks, 'team').detail).toMatch(/^Команда тестов \(.+fixtures\/team\), слой компании example \(.+company\/example\)$/);
  });

  it('fails Java builds without JDK 21 and says which repositories and where to set it', () => {
    const config = configWith();
    const old = byId(doctorChecks(config, facts(config, { jdks: { '/jdk21': 17 } })), 'jdk');
    expect(old).toMatchObject({ level: 'fail', fix: expect.stringContaining('javaHome с JDK 21') });
    expect(old.detail).toContain('gate: JDK 17 вместо 21');
    expect(byId(doctorChecks(config, facts(config, { jdks: { '/jdk21': null } })), 'jdk').detail).toContain('adapter: java не запускается из /jdk21');
    const none = configWith('me: colleague\n');
    expect(byId(doctorChecks(none, facts(none, { jdks: {} })), 'jdk')).toMatchObject({ level: 'fail', detail: expect.stringContaining('gate: JDK не задан') });
  });

  it('warns without personal settings and the Jira login and fails without a clone of the default repository', () => {
    const config = configWith(null);
    const checks = doctorChecks(config, facts(config, { personalExists: false, jdks: {} }));
    expect(byId(checks, 'personal')).toMatchObject({ level: 'warn', fix: expect.stringContaining('docs/setup.md') });
    expect(byId(checks, 'jira-login')).toMatchObject({ level: 'warn', detail: expect.stringContaining('откажется назначать задачу') });
    const path = (id: string) => config.profiles.repos.find((r) => r.id === id)!.path;
    const clones = facts(config).clones;
    expect(byId(doctorChecks(config, facts(config, { clones: { ...clones, [path('mobile')]: false } })), 'repos')).toMatchObject({ level: 'warn', detail: expect.stringContaining('нет клона: mobile (') });
    expect(byId(doctorChecks(config, facts(config, { clones: { ...clones, [path('gate')]: false } })), 'repos').level).toBe('fail');
  });

  it('counts an MCP server replaced by a token from the Integrations screen and names the ones without access', () => {
    const { 'bitbucket-core': _core, ...rest } = SERVERS;
    const config = configWith(undefined, rest);
    expect(byId(doctorChecks(config, facts(config)), 'mcp')).toMatchObject({ level: 'warn', detail: expect.stringContaining('без доступа: bitbucket-core') });
    expect(byId(doctorChecks(config, facts(config, { tokenIntegrations: ['bitbucket-core'] })), 'mcp')).toMatchObject({
      level: 'ok',
      detail: expect.stringContaining('токеном с экрана "Интеграции": bitbucket-core'),
    });
  });

  it('recommends pinned versions for MCP packages without a version or with @latest', () => {
    const config = configWith(undefined, { ...SERVERS, bamboo: { command: 'npx', args: ['-y', 'bamboo-mcp-server@latest'] }, atlassian: { command: 'uvx', args: ['mcp-atlassian'], env: SERVERS.atlassian!.env } });
    expect(byId(doctorChecks(config, facts(config)), 'mcp-versions')).toMatchObject({
      level: 'warn',
      detail: 'atlassian: mcp-atlassian -> mcp-atlassian==0.23.1; bamboo: bamboo-mcp-server@latest -> bamboo-mcp-server@1.2.0',
    });
  });

  it('fails outside macOS, without the CLI claude or the agent plugin and warns when the CLI is not logged in', () => {
    const config = configWith();
    expect(byId(doctorChecks(config, facts(config, { platform: 'linux' })), 'sandbox')).toMatchObject({ level: 'fail', detail: expect.stringContaining('только в macOS') });
    expect(byId(doctorChecks(config, facts(config, { claude: { exists: false, version: null, auth: null, authError: null } })), 'claude').level).toBe('fail');
    const out = facts(config).claude;
    expect(byId(doctorChecks(config, facts(config, { claude: { ...out, auth: { ...out.auth!, loggedIn: false } } })), 'claude')).toMatchObject({ level: 'warn', detail: expect.stringContaining('не вошел') });
    expect(byId(doctorChecks(config, facts(config, { plugin: { manifest: true, skills: ['wiki-pages'] } })), 'plugin')).toMatchObject({ level: 'fail', detail: 'нет скиллов из team.yaml: stand-qa' });
  });

  it('warns about a missing or stale backup and an oversized QA profile, but not about backups where there are none by design', () => {
    const config = configWith();
    expect(byId(doctorChecks(config, facts(config, { backups: [] })), 'data')).toMatchObject({ level: 'warn', detail: expect.stringContaining('копий базы нет'), fix: expect.stringContaining('раз в сутки') });
    const stale = facts(config, { now: new Date('2026-09-27T12:00:00Z') });
    expect(byId(doctorChecks(config, stale), 'data').level).toBe('warn');
    const big = byId(doctorChecks(config, facts(config, { sizes: { db: 1, agents: 1, qaProfile: 2 * 1024 ** 3 } })), 'data');
    expect(big).toMatchObject({ level: 'warn', fix: expect.stringContaining('очистите его кэш в карточке "Место на диске"') });
    expect(byId(doctorChecks({ ...config, backupsDir: null }, facts(config, { backups: [] })), 'data').level).toBe('ok');
  });

  it('reads the Java version and the folder size from command output', () => {
    expect(javaMajor('openjdk version "21.0.12" 2025-10-21 LTS\nOpenJDK Runtime Environment Zulu21')).toBe(21);
    expect(javaMajor('java version "1.8.0_392"')).toBe(8);
    expect(javaMajor('command not found')).toBeNull();
    expect(parseDu('236544\t/data/qa-chrome\n')).toBe(236544 * 1024);
    expect(parseDu('')).toBeNull();
  });

  it('prints a line per check, the fix under a problem and a summary for the terminal', () => {
    const ok: DoctorCheckDto = { id: 'node', title: 'Node', level: 'ok', detail: '26.7.0', fix: null };
    const warn: DoctorCheckDto = { id: 'jira-login', title: 'Логин Jira', level: 'warn', detail: 'не задан', fix: 'Укажите me' };
    expect(formatDoctor([ok, warn]).split('\n')).toEqual(['Task Pilot: проверка окружения', '', '  ✓ Node: 26.7.0', '  ! Логин Jira: не задан', '      Как исправить: Укажите me', '', 'Проблем: 0, предупреждений: 1']);
    expect(formatDoctor([ok])).toContain('Все в порядке');
  });

  it('reads from the database only which integrations have an active Task Pilot account', () => {
    const dir = tempDir();
    const file = join(dir, 'task-pilot.db');
    const store = new Store(file);
    const row = store.addIntegrationAccount({ integration: 'bitbucket-core', kind: 'token', label: null, login: 'owner', name: null, hint: '...abcd', dir: null });
    store.setActiveIntegrationAccount('bitbucket-core', row.id);
    store.addIntegrationAccount({ integration: 'jira', kind: 'token', label: null, login: 'tech', name: null, hint: '...efgh', dir: null });
    expect(activeIntegrationsIn(file)).toEqual(['bitbucket-core']);
    store.close();
    expect(activeIntegrationsIn(join(dir, 'none.db'))).toEqual([]);
    new DatabaseSync(join(dir, 'empty.db')).close();
    expect(activeIntegrationsIn(join(dir, 'empty.db'))).toEqual([]);
  });
});
