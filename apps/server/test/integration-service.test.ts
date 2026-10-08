import { existsSync, mkdirSync, mkdtempSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig, Profiles } from '../src/config.ts';
import { EventBus } from '../src/engine/events.ts';
import type { ClaudeCli } from '../src/integrations/claude-cli.ts';
import { integrationDefs } from '../src/integrations/registry.ts';
import { memorySecrets, type SecretStore } from '../src/integrations/secrets.ts';
import { IntegrationService, type IntegrationServiceDeps } from '../src/integrations/service.ts';
import { AccessDenied, type WhoAmI } from '../src/integrations/whoami.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { Store } from '../src/store/db.ts';
import { fakeClaudeCli, PROFILES } from './helpers.ts';

/** ~/.claude.json владельца в тестах. */
const BASE: Record<string, McpServerConfig> = {
  atlassian: { command: 'uvx', args: ['mcp-atlassian'], env: { JIRA_URL: 'https://jira.example.org', JIRA_PERSONAL_TOKEN: 'owner-jira-token', TOOLSETS: 'all' } },
  bitbucket: { command: 'npx', args: ['-y', 'bitbucket'], env: { BITBUCKET_BASE_URL: 'https://git.example.org', BITBUCKET_USERNAME: 'owner1', BITBUCKET_TOKEN: 'owner-git-token' } },
};

const PROFILES_MCP: Profiles = {
  ...PROFILES,
  contours: PROFILES.contours.map((c) => (c.id === 'cloud' ? { ...c, mcp: { bitbucket: 'bitbucket' } } : c)),
};

/** "Кто я" тестов: владелец токена по токену, токены с bad не принимаются. */
const WHO: Record<string, { login: string; name: string }> = {
  'owner-jira-token': { login: 'owner', name: 'Владелец' },
  'tech-jira-token-1': { login: 'tech', name: 'Технический' },
  'owner-git-token': { login: 'owner1', name: 'Владелец Git' },
  'tech-git-token-1': { login: 'tech1', name: 'Технический Git' },
};

function setup(over: Partial<IntegrationServiceDeps> = {}, store = new Store(':memory:'), secrets: SecretStore = memorySecrets()) {
  const redact = createRedactor([]);
  const bus = new EventBus(store, redact);
  const lint: string[] = [];
  const asked: { kind: string; url: string; token: string | null }[] = [];
  const whoami: WhoAmI = async (kind, url, token) => {
    asked.push({ kind, url, token });
    if (kind === 'kibana') return { login: null, name: null };
    const who = token ? WHO[token] : undefined;
    if (!who) throw new AccessDenied(`токен ${token} не принят, ответ 401`);
    return who;
  };
  const root = mkdtempSync(join(tmpdir(), 'integrations-'));
  const claudeHome = join(root, 'claude-home');
  mkdirSync(join(claudeHome, 'skills'), { recursive: true });
  const service = new IntegrationService({
    defs: integrationDefs(PROFILES_MCP, BASE),
    base: BASE,
    store,
    secrets,
    whoami,
    claude: fakeClaudeCli(),
    claudeAccountsDir: join(root, 'accounts'),
    claudeHome,
    jira: PROFILES.jira,
    redact,
    onSecret: (value) => {
      redact.add(value);
      lint.push(value);
    },
    bus,
    ...over,
  });
  const seen: string[] = [];
  bus.on('event', (e: { type: string; message: string | null }) => {
    if (e.type === 'integration.changed') seen.push(e.message ?? '');
  });
  const events = () => seen;
  return { service, store, secrets, redact, lint, asked, root, events, bus };
}

describe('IntegrationService', () => {
  it('shows access "as usual" from ~/.claude.json with the owner of each token and the CLI login of claude', async () => {
    const t = setup();
    const list = await t.service.list();
    const jira = list.integrations.find((i) => i.id === 'jira')!;
    expect(jira.accounts).toEqual([
      {
        id: null,
        kind: 'default',
        label: 'Как обычно, из Claude Code',
        source: 'MCP-сервер atlassian в ~/.claude.json',
        active: true,
        check: { ok: true, login: 'owner', name: 'Владелец', detail: null, error: null, at: expect.any(String) },
      },
    ]);
    expect(list.integrations.find((i) => i.id === 'claude')!.accounts[0]).toMatchObject({ label: 'Вход CLI claude', check: { ok: true, login: 'owner@example.org', name: 'Команда', detail: 'тариф team' } });
    expect(list.integrations.find((i) => i.id === 'stands-kibana')!.accounts[0]).toMatchObject({ kind: 'none', label: 'Без входа', check: { ok: true, login: null } });
    // Confluence без адреса: токен ему задать нельзя, у Bamboo контура без MCP-сервера интеграции нет вовсе.
    expect(list.integrations.find((i) => i.id === 'confluence')).toMatchObject({ canToken: false, accounts: [{ check: { ok: false } }] });
    expect(list.integrations.some((i) => i.kind === 'bamboo')).toBe(false);
    expect(t.asked).toContainEqual({ kind: 'jira', url: 'https://jira.example.org', token: 'owner-jira-token' });
    expect(t.service.servers()).toBe(t.service.servers());
    expect(t.service.servers().atlassian).toBe(BASE.atlassian);
  });

  it('does not send the token of ~/.claude.json to a host other than the one of the profile', async () => {
    const base = { ...BASE, bitbucket: { ...BASE.bitbucket!, env: { ...BASE.bitbucket!.env, BITBUCKET_BASE_URL: 'https://evil.example.com' } } };
    const t = setup({ base, defs: integrationDefs(PROFILES_MCP, base) });
    const bitbucket = await t.service.check('bitbucket-cloud');
    expect(bitbucket.accounts[0]!.check).toMatchObject({ ok: false, error: expect.stringContaining('токен не отправляется') });
    expect(t.asked.some((a) => a.kind === 'bitbucket')).toBe(false);
  });

  it('checks a new token with the system, keeps it in the store, masks it and makes Task Pilot work under its owner', async () => {
    const t = setup();
    const jira = await t.service.addToken('jira', { token: ' tech-jira-token-1 ', label: 'Технический' });
    const account = jira.accounts.find((a) => a.id !== null)!;
    expect(account).toEqual({
      id: expect.any(String),
      kind: 'token',
      label: 'Технический',
      source: 'токен в памяти процесса, ...en-1',
      active: true,
      check: { ok: true, login: 'tech', name: 'Технический', detail: null, error: null, at: expect.any(String) },
    });
    expect(jira.accounts[0]!.active).toBe(false);
    expect(await t.secrets.get(`jira.${account.id}`)).toBe('tech-jira-token-1');
    expect(t.redact.text('ответ для tech-jira-token-1')).toBe('ответ для ***');
    expect(t.lint).toEqual(['tech-jira-token-1']);
    // MCP-сервер atlassian берет токен Task Pilot, остальное env - из ~/.claude.json; задачи назначаются на его владельца.
    expect(t.service.servers().atlassian!.env).toEqual({ JIRA_URL: 'https://jira.example.org', JIRA_PERSONAL_TOKEN: 'tech-jira-token-1', TOOLSETS: 'all' });
    expect(t.service.jiraProfile().me).toBe('tech');
    expect(t.events()).toEqual(['Jira: заведен токен, активен аккаунт Технический (tech)']);
    expect(JSON.stringify(await t.service.list())).not.toContain('tech-jira-token-1');
  });

  it('does not save a token the system rejects and hides it in the error', async () => {
    const t = setup();
    await expect(t.service.addToken('jira', { token: 'bad-jira-token-1' })).rejects.toThrow('Токен не прошел проверку: токен *** не принят, ответ 401');
    expect(t.store.integrationAccounts('jira')).toEqual([]);
    expect(t.lint).toEqual([]);
    await expect(t.service.addToken('stands-kibana', { token: 'any-token-value' })).rejects.toThrow('без входа');
    await expect(t.service.addToken('jira', { token: 'short' })).rejects.toThrow('короткий');
    await expect(t.service.addToken('nope', { token: 'any-token-value' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('takes the login of a Bitbucket token for the MCP server that asks for it and gives the token to git for its host', async () => {
    const t = setup();
    expect(t.service.gitHeaders()).toEqual([]);
    await t.service.addToken('bitbucket-cloud', { token: 'tech-git-token-1' });
    expect(t.service.servers().bitbucket!.env).toMatchObject({ BITBUCKET_TOKEN: 'tech-git-token-1', BITBUCKET_USERNAME: 'tech1', BITBUCKET_BASE_URL: 'https://git.example.org' });
    expect(t.service.gitHeaders()).toEqual([{ prefix: 'https://git.example.org/', header: 'Authorization: Bearer tech-git-token-1' }]);
    // Как обычно git берет учетные данные из Keychain: заголовка нет.
    await t.service.activate('bitbucket-cloud', null);
    expect(t.service.gitHeaders()).toEqual([]);
  });

  it('switches between accounts and back to access as usual, and removes a token from the store', async () => {
    const t = setup();
    const added = await t.service.addToken('jira', { token: 'tech-jira-token-1' });
    const id = added.accounts[1]!.id!;
    await t.service.activate('jira', null);
    expect(t.service.servers().atlassian).toBe(BASE.atlassian);
    expect(t.service.jiraProfile().me).toBe('owner');
    await t.service.activate('jira', id);
    expect(t.service.jiraProfile().me).toBe('tech');
    await expect(t.service.activate('jira', 'nope')).rejects.toMatchObject({ statusCode: 404 });
    const removed = await t.service.remove('jira', id);
    expect(removed.accounts.map((a) => [a.id, a.active])).toEqual([[null, true]]);
    expect(await t.secrets.get(`jira.${id}`)).toBeNull();
    expect(t.service.servers().atlassian).toBe(BASE.atlassian);
    // Удаленный токен маскируется и дальше: он мог попасть в уже записанный вывод.
    expect(t.redact.text('tech-jira-token-1')).toBe('***');
    expect(t.events().at(-1)).toBe('Jira: аккаунт Технический удален, доступ как обычно, из Claude Code');
  });

  it('turns an active account off at start when its token is gone from the store, instead of working under another access', async () => {
    const store = new Store(':memory:');
    const secrets = memorySecrets();
    const first = setup({}, store, secrets);
    const added = await first.service.addToken('jira', { token: 'tech-jira-token-1' });
    const id = added.accounts[1]!.id!;
    await secrets.remove(`jira.${id}`);
    const second = setup({}, store, secrets);
    await second.service.init();
    expect(store.activeIntegrationAccount('jira')).toBeNull();
    expect(second.service.jiraProfile().me).toBe('owner');
    expect(second.events().at(-1)).toContain('Jira: Токена нет в памяти процесса');
    const jira = (await second.service.list()).integrations.find((i) => i.id === 'jira')!;
    expect(jira.accounts[1]).toMatchObject({ active: false, check: { ok: false, error: expect.stringContaining('Токена нет в памяти процесса') } });
    await expect(second.service.activate('jira', id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reads the tokens of the store at start and masks them before anything is shown', async () => {
    const store = new Store(':memory:');
    const secrets = memorySecrets();
    await setup({}, store, secrets).service.addToken('jira', { token: 'tech-jira-token-1' });
    const again = setup({}, store, secrets);
    await again.service.init();
    expect(again.redact.text('tech-jira-token-1')).toBe('***');
    expect(again.lint).toEqual(['tech-jira-token-1']);
    expect(again.service.servers().atlassian!.env.JIRA_PERSONAL_TOKEN).toBe('tech-jira-token-1');
  });

  it('runs agents under a claude token: setup-token and API key go to their own variables after a probe', async () => {
    const probed: Record<string, string>[] = [];
    const t = setup({ claude: fakeClaudeCli({ probe: async (env) => void probed.push(env) }) });
    await expect(t.service.addToken('claude', { token: 'ghp_not-a-claude-token' })).rejects.toThrow('Это не токен Claude');
    const claude = await t.service.addToken('claude', { token: 'sk-ant-oat01-second-account', label: 'Личный' });
    expect(claude.accounts[1]).toMatchObject({ kind: 'oauth-token', label: 'Личный', active: true, source: expect.stringContaining('токен claude setup-token'), check: { ok: true } });
    expect(probed).toEqual([{ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second-account' }]);
    expect(t.service.claudeEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second-account' });
    await t.service.addToken('claude', { token: 'sk-ant-api03-console-key' });
    expect(t.service.claudeEnv()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-console-key' });
    // Токены Claude не проверяются запуском claude -p при каждом показе экрана, только по кнопке.
    await t.service.list();
    expect(probed).toHaveLength(2);
    await t.service.check('claude');
    expect(probed).toHaveLength(4);
    await t.service.activate('claude', null);
    expect(t.service.claudeEnv()).toEqual({});
  });

  it('keeps a claude token that the CLI does not accept out of the list', async () => {
    const t = setup({
      claude: fakeClaudeCli({
        probe: async () => {
          throw new Error('CLI claude не ответил с этим доступом: Invalid bearer token sk-ant-oat01-rejected');
        },
      }),
    });
    await expect(t.service.addToken('claude', { token: 'sk-ant-oat01-rejected' })).rejects.toThrow('Invalid bearer token ***');
    expect(t.store.integrationAccounts('claude')).toEqual([]);
  });

  it('logs into claude through the browser in an account folder of its own and runs agents with it', async () => {
    const logins: { env: Record<string, string>; email: string | null }[] = [];
    let finish: (code: number) => void = () => {};
    const codes: string[] = [];
    const claude: ClaudeCli = fakeClaudeCli({
      login(env, email) {
        logins.push({ env, email });
        const done = new Promise<{ code: number | null; output: string }>((resolve) => (finish = (code) => resolve({ code, output: '' })));
        return { url: () => 'https://claude.example.org/login', sendCode: (c) => void codes.push(c), cancel: () => finish(143), done };
      },
      async status(env) {
        return env.CLAUDE_CONFIG_DIR ? { loggedIn: true, method: 'claude.ai', email: 'second@example.org', org: 'Вторая', plan: 'max' } : { loggedIn: true, method: 'claude.ai', email: 'owner@example.org', org: 'Команда', plan: 'team' };
      },
    });
    const t = setup({ claude });
    const started = await t.service.startClaudeLogin({ email: 'second@example.org' });
    const login = started.logins[0]!;
    expect(login).toMatchObject({ state: 'waiting', url: 'https://claude.example.org/login', error: null });
    const dir = logins[0]!.env.CLAUDE_CONFIG_DIR!;
    expect(dir.startsWith(join(t.root, 'accounts'))).toBe(true);
    expect(logins[0]!.email).toBe('second@example.org');
    expect(readlinkSync(join(dir, 'skills'))).toBe(join(t.root, 'claude-home', 'skills'));
    // Пока идет вход, его файлы уже закрыты от агентов.
    expect(t.service.claudeSecretPaths()).toEqual([join(dir, '.credentials.json'), `${join(dir, '.claude.json')}*`, join(dir, 'backups')]);
    t.service.claudeLoginCode(login.id, 'code-from-page');
    expect(codes).toEqual(['code-from-page']);
    finish(0);
    await expect.poll(async () => (await t.service.list()).integrations.find((i) => i.id === 'claude')!.accounts.length).toBe(2);
    const claudeDto = (await t.service.list()).integrations.find((i) => i.id === 'claude')!;
    expect(claudeDto.logins).toEqual([]);
    expect(claudeDto.accounts[1]).toMatchObject({ kind: 'login', label: 'second@example.org', active: true, source: expect.stringContaining(`${login.id}`), check: { ok: true, login: 'second@example.org', detail: 'тариф max' } });
    expect(t.service.claudeEnv()).toEqual({ CLAUDE_CONFIG_DIR: dir });
    const account = await t.service.account();
    expect(account.claude.active).toMatchObject({ kind: 'login', label: 'second@example.org' });
    // Удаление выходит из аккаунта и убирает папку, но не общее из ~/.claude.
    await t.service.remove('claude', claudeDto.accounts[1]!.id!);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(t.root, 'claude-home', 'skills'))).toBe(true);
    expect(t.service.claudeEnv()).toEqual({});
  });

  it('shows a failed browser login with its reason, removes its folder and forgets it on cancel', async () => {
    let finish: (code: number) => void = () => {};
    const t = setup({
      claude: fakeClaudeCli({
        login() {
          const done = new Promise<{ code: number | null; output: string }>((resolve) => (finish = (code) => resolve({ code, output: 'Invalid code' })));
          return { url: () => null, sendCode: () => undefined, cancel: () => finish(143), done };
        },
      }),
    });
    const login = (await t.service.startClaudeLogin({})).logins[0]!;
    const dir = join(t.root, 'accounts', login.id);
    expect(existsSync(dir)).toBe(true);
    finish(1);
    await expect.poll(async () => (await t.service.list()).integrations.find((i) => i.id === 'claude')!.logins[0]?.state).toBe('failed');
    const failed = (await t.service.list()).integrations.find((i) => i.id === 'claude')!.logins[0]!;
    expect(failed.error).toBe('claude auth login завершился с кодом 1: Invalid code');
    expect(existsSync(dir)).toBe(false);
    expect(() => t.service.claudeLoginCode(login.id, 'x')).toThrow('не ждет кода');
    t.service.cancelClaudeLogin(login.id);
    expect((await t.service.list()).integrations.find((i) => i.id === 'claude')!.logins).toEqual([]);
    expect(() => t.service.cancelClaudeLogin(login.id)).toThrow('уже закончился');
    expect(t.store.integrationAccounts('claude')).toEqual([]);
  });

  it('does not remove a claude login folder while an agent of a step is running, since the agent may work in it', async () => {
    let running = true;
    const t = setup({ agentsRunning: () => running });
    const login = (await t.service.startClaudeLogin({})).logins[0]!;
    t.service.claudeLoginCode(login.id, 'code');
    await expect.poll(() => t.store.integrationAccounts('claude').length).toBe(1);
    await expect(t.service.remove('claude', login.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('работает агент') });
    expect(existsSync(join(t.root, 'accounts', login.id))).toBe(true);
    // Токены агенту уже переданы при запуске: их удаление работающему агенту не мешает.
    const withToken = await t.service.addToken('claude', { token: 'sk-ant-oat01-second-account' });
    await t.service.remove('claude', withToken.accounts.find((a) => a.kind === 'oauth-token')!.id!);
    running = false;
    await t.service.remove('claude', login.id);
    expect(existsSync(join(t.root, 'accounts', login.id))).toBe(false);
  });

  it('gives the header the active accounts and the login steps assign tasks to', async () => {
    const t = setup();
    expect(await t.service.account()).toMatchObject({ jira: { me: 'owner', active: { id: null, check: { login: 'owner' } } }, claude: { active: { id: null, check: { login: 'owner@example.org' } } } });
    await t.service.addToken('jira', { token: 'tech-jira-token-1' });
    expect(await t.service.account()).toMatchObject({ jira: { me: 'tech', active: { kind: 'token', label: 'Технический' } } });
  });

  it('checks each account once while its result is fresh and joins parallel checks', async () => {
    let now = 1_000_000;
    const t = setup({ now: () => now });
    await Promise.all([t.service.list(), t.service.list(), t.service.account()]);
    const jiraChecks = () => t.asked.filter((a) => a.kind === 'jira').length;
    expect(jiraChecks()).toBe(1);
    await t.service.list();
    expect(jiraChecks()).toBe(1);
    now += 6 * 60_000;
    await t.service.list();
    expect(jiraChecks()).toBe(2);
    await t.service.check('jira');
    expect(jiraChecks()).toBe(3);
  });
});
