import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeCli, parseAuthStatus, prepareClaudeDir, removeClaudeDir } from '../src/integrations/claude-cli.ts';
import { createGit, gitConfigEnv } from '../src/integrations/git.ts';
import { McpHub } from '../src/integrations/mcp.ts';
import { claudeTokenKind, cleanToken, DEFAULT_MCP, effectiveServers, integrationDefs, MCP_PACKAGES, packageName, tokenHint, unpinnedMcp } from '../src/integrations/registry.ts';
import { keychainSecrets, memorySecrets } from '../src/integrations/secrets.ts';
import { AccessDenied, createWhoAmI } from '../src/integrations/whoami.ts';
import type { McpServerConfig, Profiles } from '../src/config.ts';
import { PROFILES } from './helpers.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** ~/.claude.json владельца в тестах: atlassian с Jira и Confluence, Bitbucket и Bamboo контура, логи прода. */
const BASE: Record<string, McpServerConfig> = {
  atlassian: {
    command: 'uvx',
    args: ['mcp-atlassian'],
    env: { JIRA_URL: 'https://jira.example.org', JIRA_PERSONAL_TOKEN: 'owner-jira-token', CONFLUENCE_URL: 'https://wiki.example.org/', CONFLUENCE_PERSONAL_TOKEN: 'owner-wiki-token', TOOLSETS: 'all' },
  },
  bitbucket: { command: 'npx', args: ['-y', 'bitbucket'], env: { BITBUCKET_BASE_URL: 'https://git.example.org', BITBUCKET_USERNAME: 'owner1', BITBUCKET_TOKEN: 'owner-git-token' } },
  elasticsearch: { command: 'npx', args: ['-y', 'es'], env: { ES_URL: 'http://es.example.org:9200', ES_API_KEY: 'owner-es-key' } },
};

/** Профили тестов с MCP-серверами контура cloud и панелью мониторинга. */
const PROFILES_MCP: Profiles = {
  ...PROFILES,
  contours: PROFILES.contours.map((c) => (c.id === 'cloud' ? { ...c, mcp: { bitbucket: 'bitbucket', bamboo: 'bamboo-cloud' } } : { ...c, mcp: { bamboo: 'bamboo' }, note: 'Подключается позже' })),
  monitor: {
    source: { id: 'es-prod', mcp: 'elasticsearch' },
    services: [{ id: 'keycloak', title: 'Keycloak', index: 'mon-*', container: 'kk', fields: { message: 'message', level: 'level', logger: 'logger', version: 'version', pod: 'pod' }, ids: [] }],
    timeZone: 'UTC',
  },
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('integration registry', () => {
  it('lists Jira, Confluence, Bitbucket and Bamboo of every contour with their MCP servers, prod logs, stand Kibana and Claude', () => {
    const defs = integrationDefs(PROFILES_MCP, BASE);
    expect(defs.map((d) => [d.id, d.kind, d.url, d.mcp])).toEqual([
      ['jira', 'jira', 'https://jira.example.org', 'atlassian'],
      ['confluence', 'confluence', 'https://wiki.example.org', 'atlassian'],
      ['bitbucket-cloud', 'bitbucket', 'https://git.example.org', 'bitbucket'],
      ['bamboo-cloud', 'bamboo', 'https://bamboo.example.org', 'bamboo-cloud'],
      ['bamboo-core', 'bamboo', 'https://bamboo2.example.org', 'bamboo'],
      ['logs-es-prod', 'elasticsearch', 'http://es.example.org:9200', 'elasticsearch'],
      ['stands-kibana', 'kibana', 'https://kibana.example.org', null],
      ['claude', 'claude', null, null],
    ]);
    expect(defs.find((d) => d.id === 'bamboo-core')?.note).toBe('Подключается позже');
    expect(defs.find((d) => d.id === 'stands-kibana')?.tokenHelp).toBeNull();
  });

  it('shows log sources on one Kibana as one integration named after the first of them', () => {
    const logs = { a: { kind: 'kibana' as const, url: 'https://kibana.example.org/', index: 'mon-a-*', imageField: 'x' }, b: { kind: 'kibana' as const, url: 'https://kibana.example.org', index: 'mon-b-*', imageField: 'y' } };
    const kibana = integrationDefs({ ...PROFILES_MCP, logs }, BASE).filter((d) => d.kind === 'kibana');
    expect(kibana.map((d) => [d.id, d.title, d.url])).toEqual([['stands-a', 'Kibana стендов', 'https://kibana.example.org']]);
    const two = integrationDefs({ ...PROFILES_MCP, logs: { ...logs, c: { ...logs.a, url: 'https://kibana2.example.org' } } }, BASE).filter((d) => d.kind === 'kibana');
    expect(two.map((d) => d.title)).toEqual(['Kibana стендов kibana.example.org', 'Kibana стендов kibana2.example.org']);
  });

  it('has no Confluence or prod logs address when their MCP server lacks it, so no token can go there', () => {
    const defs = integrationDefs(PROFILES_MCP, {});
    expect(defs.find((d) => d.id === 'confluence')).toMatchObject({ url: null, note: expect.stringContaining('CONFLUENCE_URL') });
    expect(defs.find((d) => d.id === 'logs-es-prod')).toMatchObject({ url: null, note: expect.stringContaining('ES_URL') });
  });

  it('puts a Task Pilot token into the env of the integration MCP server and keeps the rest of its env', () => {
    const defs = integrationDefs(PROFILES_MCP, BASE);
    const def = (id: string) => defs.find((d) => d.id === id)!;
    const servers = effectiveServers(BASE, [
      { def: def('jira'), token: 'tech-jira-token', user: 'tech' },
      { def: def('confluence'), token: 'tech-wiki-token', user: 'tech' },
      { def: def('bitbucket-cloud'), token: 'tech-git-token', user: 'tech1' },
    ]);
    // Jira и Confluence живут в одном сервере atlassian: у него оба токена, остальное env как было.
    expect(servers.atlassian!.env).toEqual({
      JIRA_URL: 'https://jira.example.org',
      JIRA_PERSONAL_TOKEN: 'tech-jira-token',
      CONFLUENCE_URL: 'https://wiki.example.org',
      CONFLUENCE_PERSONAL_TOKEN: 'tech-wiki-token',
      TOOLSETS: 'all',
    });
    expect(servers.bitbucket!.env).toMatchObject({ BITBUCKET_TOKEN: 'tech-git-token', BITBUCKET_USERNAME: 'tech1' });
    // Серверы без токена Task Pilot - те же объекты, что в ~/.claude.json.
    expect(servers.elasticsearch).toBe(BASE.elasticsearch);
    expect(BASE.atlassian!.env.JIRA_PERSONAL_TOKEN).toBe('owner-jira-token');
  });

  it('starts the MCP server from its default package when ~/.claude.json has none', () => {
    const def = integrationDefs(PROFILES_MCP, BASE).find((d) => d.id === 'bamboo-cloud')!;
    const servers = effectiveServers({}, [{ def, token: 'tech-bamboo-token', user: null }]);
    expect(servers['bamboo-cloud']).toEqual({ ...DEFAULT_MCP.bamboo, env: { BAMBOO_URL: 'https://bamboo.example.org', BAMBOO_TOKEN: 'tech-bamboo-token' } });
  });

  it('starts its own MCP servers only from packages with a pinned version', () => {
    for (const cfg of Object.values(DEFAULT_MCP)) {
      const spec = cfg.args.find((a) => a !== '-y')!;
      expect(Object.values(MCP_PACKAGES)).toContain(spec);
    }
    expect(packageName('@nexus2520/bitbucket-mcp-server@3.0.0')).toBe('@nexus2520/bitbucket-mcp-server');
    expect(packageName('@nexus2520/bitbucket-mcp-server')).toBe('@nexus2520/bitbucket-mcp-server');
    expect(packageName('mcp-atlassian==0.23.1')).toBe('mcp-atlassian');
    expect(packageName('bamboo-mcp-server@latest')).toBe('bamboo-mcp-server');
  });

  it('finds MCP servers of ~/.claude.json that start a package without a version or with @latest', () => {
    const cfg = (command: string, args: string[]): McpServerConfig => ({ command, args, env: {} });
    const servers = {
      bitbucket: cfg('npx', ['-y', '@nexus2520/bitbucket-mcp-server']),
      bamboo: cfg('npx', ['-y', 'bamboo-mcp-server@latest']),
      'bamboo-cloud': cfg('npx', ['-y', 'bamboo-mcp-server@1.2.0']),
      atlassian: cfg('uvx', ['mcp-atlassian']),
      opensearch: cfg('uvx', ['--python', '3.12', 'opensearch-mcp-server']),
    };
    expect(unpinnedMcp(servers)).toEqual([
      { server: 'bitbucket', spec: '@nexus2520/bitbucket-mcp-server', pinned: '@nexus2520/bitbucket-mcp-server@3.0.0' },
      { server: 'bamboo', spec: 'bamboo-mcp-server@latest', pinned: 'bamboo-mcp-server@1.2.0' },
      { server: 'atlassian', spec: 'mcp-atlassian', pinned: 'mcp-atlassian==0.23.1' },
    ]);
  });

  it('tells a claude setup-token token from an API key and rejects pasted garbage', () => {
    expect(claudeTokenKind('sk-ant-oat01-abc')).toBe('oauth-token');
    expect(claudeTokenKind('sk-ant-api03-abc')).toBe('api-key');
    expect(claudeTokenKind('ghp_abc')).toBeNull();
    expect(cleanToken('  token-value-1234 \n')).toBe('token-value-1234');
    expect(() => cleanToken('short')).toThrow('короткий');
    expect(() => cleanToken('two words-long-enough')).toThrow('пробелы');
    expect(tokenHint('token-value-1234')).toBe('...1234');
  });
});

describe('token store', () => {
  function fakeSecurity() {
    const dir = tempDir('fake-security-');
    const script = join(dir, 'security');
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, 'fake-security.ts')}" "$@"\n`);
    chmodSync(script, 0o755);
    const log = join(dir, 'log.jsonl');
    process.env.FAKE_KEYCHAIN = join(dir, 'items.json');
    process.env.FAKE_KEYCHAIN_LOG = log;
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { argv: string[]; stdin: string })
        : [];
    return { store: keychainSecrets({ service: 'task-pilot-test', security: script }), calls };
  }

  afterEach(() => {
    delete process.env.FAKE_KEYCHAIN;
    delete process.env.FAKE_KEYCHAIN_LOG;
  });

  it('writes a token to Keychain through stdin in hex, never in the process arguments, and reads it back', async () => {
    const { store, calls } = fakeSecurity();
    await store.set('jira.ab12cd34', 'secret "token" \\ value');
    expect(await store.get('jira.ab12cd34')).toBe('secret "token" \\ value');
    const all = calls();
    expect(all.some((c) => c.argv.join(' ').includes('secret'))).toBe(false);
    expect(all.find((c) => c.argv[0] === '-i')?.stdin).toBe(`add-generic-password -U -s task-pilot-test -a jira.ab12cd34 -X ${Buffer.from('secret "token" \\ value').toString('hex')}\n`);
    expect(store.where).toBe('Keychain macOS');
  });

  it('answers null for a missing token and removes a token idempotently', async () => {
    const { store } = fakeSecurity();
    expect(await store.get('jira.missing')).toBeNull();
    await store.set('jira.one', 'value-1');
    await store.remove('jira.one');
    await store.remove('jira.one');
    expect(await store.get('jira.one')).toBeNull();
  });

  it('refuses record names that would need quoting in security commands', async () => {
    const { store } = fakeSecurity();
    await expect(store.set('jira one', 'value-1')).rejects.toThrow('Недопустимое имя');
  });

  it('keeps tokens of the demo and tests in memory', async () => {
    const store = memorySecrets();
    await store.set('a', 'value-1');
    expect(await store.get('a')).toBe('value-1');
    await store.remove('a');
    expect(await store.get('a')).toBeNull();
  });
});

describe('who am I', () => {
  function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const doFetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      const route = routes[String(url)];
      if (!route) return new Response('not found', { status: 404 });
      return new Response(typeof route.body === 'string' ? route.body : JSON.stringify(route.body), { status: route.status ?? 200 });
    }) as typeof fetch;
    return { doFetch, seen };
  }

  it('asks every system who owns the token with its own endpoint and header', async () => {
    const { doFetch, seen } = fakeFetch({
      'https://jira.example.org/rest/api/2/myself': { body: { name: 'owner', displayName: 'Владелец' } },
      'https://wiki.example.org/rest/api/user/current': { body: { username: 'owner', displayName: 'Владелец', type: 'known' } },
      'https://git.example.org/plugins/servlet/applinks/whoami': { body: 'owner1\n' },
      'https://git.example.org/rest/api/1.0/users/owner1': { body: { displayName: 'Владелец Git' } },
      'https://bamboo.example.org/rest/api/latest/currentUser': { body: { name: 'owner1', fullName: 'Владелец Bamboo' } },
      'http://es.example.org:9200/_security/_authenticate': { body: { username: 'owner', api_key: { name: 'readonly' } } },
      'https://kibana.example.org/api/status': { body: { status: 'ok' } },
    });
    const who = createWhoAmI(doFetch);
    expect(await who('jira', 'https://jira.example.org/', 't-jira')).toEqual({ login: 'owner', name: 'Владелец' });
    expect(await who('confluence', 'https://wiki.example.org', 't-wiki')).toEqual({ login: 'owner', name: 'Владелец' });
    expect(await who('bitbucket', 'https://git.example.org', 't-git')).toEqual({ login: 'owner1', name: 'Владелец Git' });
    expect(await who('bamboo', 'https://bamboo.example.org', 't-bamboo')).toEqual({ login: 'owner1', name: 'Владелец Bamboo' });
    expect(await who('elasticsearch', 'http://es.example.org:9200', 't-es')).toEqual({ login: 'owner', name: 'ключ readonly' });
    expect(await who('kibana', 'https://kibana.example.org', null)).toEqual({ login: null, name: null });
    expect(seen.find((s) => s.url.endsWith('/myself'))?.headers.authorization).toBe('Bearer t-jira');
    expect(seen.find((s) => s.url.endsWith('/_authenticate'))?.headers.authorization).toBe('ApiKey t-es');
    expect(seen.find((s) => s.url.endsWith('/api/status'))?.headers.authorization).toBeUndefined();
  });

  it('rejects a token the system answers as to an anonymous user or with 401', async () => {
    const { doFetch } = fakeFetch({
      'https://wiki.example.org/rest/api/user/current': { body: { displayName: 'Anonymous', type: 'anonymous' } },
      'https://git.example.org/plugins/servlet/applinks/whoami': { body: '' },
      'https://jira.example.org/rest/api/2/myself': { status: 401, body: {} },
    });
    const who = createWhoAmI(doFetch);
    await expect(who('confluence', 'https://wiki.example.org', 't')).rejects.toThrow(AccessDenied);
    await expect(who('bitbucket', 'https://git.example.org', 't')).rejects.toThrow('анонимному');
    await expect(who('jira', 'https://jira.example.org', 't')).rejects.toThrow('Jira: токен не принят, ответ 401');
  });

  it('says in words that a system did not answer in time or could not be reached', async () => {
    const timeout = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(createWhoAmI(timeout, 10_000)('bamboo', 'https://bamboo.example.org', 't')).rejects.toThrow('Bamboo: нет ответа за 10 с');
    const refused = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    }) as unknown as typeof fetch;
    await expect(createWhoAmI(refused)('bitbucket', 'https://git.example.org', 't')).rejects.toThrow('Bitbucket: не удалось подключиться (UND_ERR_CONNECT_TIMEOUT)');
  });

  it('keeps the Bitbucket login when its display name is not available', async () => {
    const { doFetch } = fakeFetch({ 'https://git.example.org/plugins/servlet/applinks/whoami': { body: 'owner1' } });
    expect(await createWhoAmI(doFetch)('bitbucket', 'https://git.example.org', 't')).toEqual({ login: 'owner1', name: null });
  });
});

describe('claude CLI accounts', () => {
  afterEach(() => {
    delete process.env.CLAUDE_TEST_PARENT;
    delete process.env.FAKE_AUTH_LOG;
  });

  it('reads the login of claude auth status --json', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","orgName":"Org","subscriptionType":"team"}')).toEqual({
      loggedIn: true,
      method: 'claude.ai',
      email: 'a@b.c',
      org: 'Org',
      plan: 'team',
    });
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toMatchObject({ loggedIn: false, email: null });
    expect(() => parseAuthStatus('Usage: claude')).toThrow('не JSON');
  });

  it('links the shared parts of ~/.claude into an account folder and removes the folder without touching them', () => {
    const home = tempDir('claude-home-');
    mkdirSync(join(home, 'skills', 'qa'), { recursive: true });
    writeFileSync(join(home, 'skills', 'qa', 'SKILL.md'), 'скилл');
    writeFileSync(join(home, 'CLAUDE.md'), 'правила');
    mkdirSync(join(home, 'projects'));
    const root = tempDir('claude-accounts-');
    const dir = join(root, 'ab12cd34');
    prepareClaudeDir(dir, home);
    prepareClaudeDir(dir, home);
    expect(readlinkSync(join(dir, 'skills'))).toBe(join(home, 'skills'));
    expect(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, 'agents'))).toBe(false);
    writeFileSync(join(dir, '.claude.json'), '{}');
    removeClaudeDir(dir, root);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(home, 'skills', 'qa', 'SKILL.md'), 'utf8')).toBe('скилл');
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(true);
    expect(() => removeClaudeDir(home, root)).toThrow('не внутри');
  });

  it('runs the CLI in the account folder without the parent session, logs in with a pasted code and probes a token', async () => {
    const log = join(tempDir('claude-auth-'), 'log.txt');
    process.env.FAKE_AUTH_LOG = log;
    process.env.CLAUDE_TEST_PARENT = 'parent-session';
    const cli = createClaudeCli(join(FIXTURES, 'fake-claude-auth.sh'));
    const dir = tempDir('claude-account-');
    expect(await cli.status({ CLAUDE_CONFIG_DIR: dir })).toMatchObject({ loggedIn: false });
    const login = cli.login({ CLAUDE_CONFIG_DIR: dir }, null);
    await expect.poll(() => login.url()).toBe('https://claude.example.org/oauth/authorize?code=true&state=x');
    login.sendCode('good-code');
    expect((await login.done).code).toBe(0);
    expect(await cli.status({ CLAUDE_CONFIG_DIR: dir })).toEqual({ loggedIn: true, method: 'claude.ai', email: 'second@example.org', org: 'Вторая', plan: 'max' });
    await cli.probe({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-good-token' });
    await expect(cli.probe({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-rejected-token' })).rejects.toThrow('Invalid bearer token');
    await cli.logout({ CLAUDE_CONFIG_DIR: dir });
    expect(await cli.status({ CLAUDE_CONFIG_DIR: dir })).toMatchObject({ loggedIn: false });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.every((l) => l.includes('parent= |'))).toBe(true);
    expect(lines.filter((l) => l.startsWith('auth ')).every((l) => l.includes(`dir=${dir}`))).toBe(true);
    expect(lines.find((l) => l.startsWith('-p '))).toContain('--model haiku --tools  --strict-mcp-config --no-session-persistence');
  });

  it('ends a login with a wrong code as a failure with the CLI output', async () => {
    process.env.FAKE_AUTH_LOG = join(tempDir('claude-auth-'), 'log.txt');
    const login = createClaudeCli(join(FIXTURES, 'fake-claude-auth.sh')).login({ CLAUDE_CONFIG_DIR: tempDir('claude-account-') }, 'second@example.org');
    login.sendCode('bad-code');
    const done = await login.done;
    expect(done.code).toBe(1);
    expect(done.output).toContain('Invalid code');
    // Код, пришедший после выхода CLI, никуда не пишется и не роняет сервер.
    login.sendCode('late-code');
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(process.env.FAKE_AUTH_LOG, 'utf8')).toContain('auth login --email second@example.org');
  });
});

describe('McpHub with changing access', () => {
  it('opens a new connection when the server config changes and keeps the old one for calls in flight', async () => {
    const server = (token: string): McpServerConfig => ({ command: process.execPath, args: [join(FIXTURES, 'env-mcp.ts')], env: { TEST_TOKEN: token } });
    let servers: Record<string, McpServerConfig> = { env: server('first-token') };
    const hub = new McpHub(() => servers);
    try {
      expect(await hub.call('env', 'env', { name: 'TEST_TOKEN' })).toBe('first-token');
      expect(await hub.call('env', 'env', { name: 'TEST_TOKEN' })).toBe('first-token');
      servers = { env: server('second-token') };
      expect(await hub.call('env', 'env', { name: 'TEST_TOKEN' })).toBe('second-token');
      servers = {};
      expect(hub.has('env')).toBe(false);
      await expect(hub.call('env', 'env', { name: 'TEST_TOKEN' })).rejects.toThrow('не настроен');
    } finally {
      await hub.close();
    }
  });
});

describe('git with a Bitbucket token of the integrations screen', () => {
  it('passes the token to git as a header for its host only, through the environment and not the arguments', async () => {
    expect(gitConfigEnv([])).toEqual({});
    expect(gitConfigEnv([{ prefix: 'https://git.example.com/', header: 'Authorization: Bearer t-1' }])).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://git.example.com/.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer t-1',
    });
    const repo = tempDir('git-headers-');
    let headers = [{ prefix: 'https://git.example.com/', header: 'Authorization: Bearer secret-git-token' }];
    const git = createGit({ headers: () => headers });
    await git.run(repo, ['init', '-q']);
    // git сам сопоставляет адрес: для git.example.com заголовок есть, для другого хоста нет.
    const forCore = await git.tryRun(repo, ['config', '--get-urlmatch', 'http.extraHeader', 'https://git.example.com/scm/mobile/mobile.git']);
    expect(forCore.stdout.trim()).toBe('Authorization: Bearer secret-git-token');
    const forOther = await git.tryRun(repo, ['config', '--get-urlmatch', 'http.extraHeader', 'https://git.cloud.example.com/scm/cloud/x.git']);
    expect(forOther.stdout.trim()).toBe('');
    // В конфиг репозитория токен не записан.
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('secret-git-token');
    headers = [];
    expect((await git.tryRun(repo, ['config', '--get-urlmatch', 'http.extraHeader', 'https://git.example.com/x.git'])).stdout.trim()).toBe('');
  });
});

