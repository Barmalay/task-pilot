import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest } from '@task-pilot/step-kit';
import { ClaudeRunner, parseStreamLine } from '../src/agent/claude.ts';
import { eventDetails } from '../src/feed.ts';
import { agentEnv, baseDeny, buildClaudeArgs, mcpWriteTools, sandboxSettings, writableDirs } from '../src/agent/policy.ts';
import { describeTool } from '../src/agent/service.ts';
import { buildServer } from '../src/http/server.ts';
import { TaskService } from '../src/tasks.ts';
import { FakeCatalog, makeEngine, manifest, PROFILES, type AgentOptions } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.ts', import.meta.url));
const PIPELINE = fileURLToPath(new URL('../src/agent/pipeline-mcp.ts', import.meta.url));

function request(over: Partial<AgentRequest> = {}): AgentRequest {
  return { label: 'план', prompt: 'Сделай план', cwd: '/work/repo', tools: ['Read', 'Grep'], ...over };
}

describe('buildClaudeArgs', () => {
  const base = { sessionId: 's-1', resume: false, mcpConfigFile: '/data/agent/1/mcp.json', deny: ['Bash(git push *)'], settings: '{"sandbox":{"enabled":true}}' };

  it('narrows built-in tools, pre-allows only reading and the pipeline, and denies publishing', () => {
    const args = buildClaudeArgs({ ...base, request: request() });
    expect(args.slice(0, 2)).toEqual(['-p', 'Сделай план']);
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose']));
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,ToolSearch');
    const allowAt = args.indexOf('--allowedTools');
    const denyAt = args.indexOf('--disallowedTools');
    expect(args.slice(allowAt + 1, denyAt)).toEqual(['ToolSearch', 'mcp__pipeline__ask_owner', 'mcp__pipeline__report_progress', 'Read', 'Grep']);
    expect(args.slice(denyAt + 1)).toEqual(['Bash(git push *)']);
    expect(args[args.indexOf('--session-id') + 1]).toBe('s-1');
    expect(args).not.toContain('--resume');
  });

  it('allows writing only into the working folder and the listed folders', () => {
    const args = buildClaudeArgs({ ...base, request: request({ tools: ['Read', 'Edit', 'Write', 'Bash'], writeDirs: ['/work/docs'], allow: ['Bash(mvn *)'] }) });
    const allow = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allow).toEqual(['ToolSearch', 'mcp__pipeline__ask_owner', 'mcp__pipeline__report_progress', 'Read', 'Edit(//work/repo/**)', 'Edit(//work/docs/**)', 'Bash(mvn *)']);
    expect(args.filter((a, i) => args[i - 1] === '--add-dir')).toEqual(['/work/docs']);
    expect(allow).not.toContain('Bash');
    expect(allow).not.toContain('Edit');
  });

  it('gives the agent the Task Pilot plugin with its skills when there is one', () => {
    const args = buildClaudeArgs({ ...base, pluginDir: '/pilot/plugin', request: request() });
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/pilot/plugin');
    expect(args.indexOf('--plugin-dir')).toBeLessThan(args.indexOf('--allowedTools'));
    expect(buildClaudeArgs({ ...base, request: request() })).not.toContain('--plugin-dir');
  });

  it('runs Bash commands in the sandbox from --settings', () => {
    const args = buildClaudeArgs({ ...base, request: request() });
    expect(args[args.indexOf('--settings') + 1]).toBe('{"sandbox":{"enabled":true}}');
  });

  it('keeps the working folder read-only when the step asks so and still allows its own folders', () => {
    const r = request({ tools: ['Read', 'Write', 'Edit'], writeDirs: ['/work/repo/.claude/TEAM-1'], writeCwd: false });
    const args = buildClaudeArgs({ ...base, request: r });
    const allow = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allow).toContain('Edit(//work/repo/.claude/TEAM-1/**)');
    expect(allow).not.toContain('Edit(//work/repo/**)');
    expect(writableDirs(r)).toEqual(['/work/repo/.claude/TEAM-1']);
    expect(writableDirs(request({ writeDirs: ['/d'] }))).toEqual(['/work/repo', '/d']);
  });

  it('continues a session with --resume and passes model, effort, budget and schema', () => {
    const args = buildClaudeArgs({ ...base, resume: true, effort: 'high', request: request({ model: 'opus', maxBudgetUsd: 5, schema: { type: 'object' } }) });
    expect(args[args.indexOf('--resume') + 1]).toBe('s-1');
    expect(args).not.toContain('--session-id');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual({ type: 'object' });
  });

  it('always denies git push and commit, direct network, token files and write tools of the owner MCP servers', () => {
    const servers = { atlassian: ['atlassian'], bitbucket: ['bitbucket', 'bitbucket-core'], bamboo: ['bamboo', 'bamboo-cloud'] };
    const deny = baseDeny('/data', [], servers);
    expect(deny).toEqual(expect.arrayContaining(['Bash(git push *)', 'Bash(git commit *)', 'Bash(curl *)', 'Read(~/.claude.json)', 'Read(~/.claude/backups/**)', 'Read(//data/**)']));
    expect(deny).toEqual(expect.arrayContaining(['mcp__atlassian__jira_transition_issue', 'mcp__bitbucket__create_pull_request', 'mcp__bamboo-cloud__bamboo_trigger_deployment']));
    const tools = mcpWriteTools(servers);
    expect(tools.some((t) => /get_|search|list_/.test(t))).toBe(false);
    // Пишущие инструменты каждого вида: у Jira и Confluence 40, у каждого Bitbucket 9, у каждого Bamboo 7.
    expect(tools).toHaveLength(40 + 2 * 9 + 2 * 7);
    // Без профилей запрещены пишущие инструменты сервера Jira по умолчанию.
    expect(baseDeny('/data')).toEqual(expect.arrayContaining(['mcp__atlassian__jira_update_issue', 'mcp__atlassian__confluence_create_page']));
  });

  it('denies write tools of the servers the profiles name, whatever their names are', () => {
    const tools = mcpWriteTools({ atlassian: ['jira-team'], bitbucket: ['git-team', 'git-team'], bamboo: ['ci-team'] });
    expect(tools).toEqual(expect.arrayContaining(['mcp__jira-team__jira_transition_issue', 'mcp__git-team__merge_pull_request', 'mcp__ci-team__bamboo_trigger_build']));
    expect(tools.filter((t) => t.startsWith('mcp__git-team__'))).toHaveLength(9);
    expect(tools.some((t) => t.startsWith('mcp__atlassian__') || t.startsWith('mcp__bitbucket__'))).toBe(false);
  });

  it('denies the git flags that turn reading commands into writing or reading any file', () => {
    expect(baseDeny('/data')).toEqual(expect.arrayContaining(['Bash(git *--output*)', 'Bash(git *--no-index*)', 'Bash(git *--contents*)']));
  });
});

describe('sandboxSettings', () => {
  it('closes the network, limits writes to the step folders and .m2 and hides token files and the data folder', () => {
    const s = JSON.parse(sandboxSettings({ writeDirs: ['/work/repo', '/work/docs'], dataDir: '/data' })) as { sandbox: Record<string, unknown> };
    expect(s.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [] },
      filesystem: { allowWrite: ['/work/repo', '/work/docs', '~/.m2'], denyRead: ['~/.claude.json*', '~/.claude/backups', '/data'] },
    });
  });
});

describe('agentEnv', () => {
  it('drops variables of the parent Claude session so the agent runs under the owner CLI login', () => {
    const env = agentEnv({ PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_BASE_URL: 'http://proxy', MCP_CONNECTION_NONBLOCKING: '1' }, { JAVA_HOME: '/jdk', MCP_TOOL_TIMEOUT: '10' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', JAVA_HOME: '/jdk', MCP_TOOL_TIMEOUT: '10' });
  });
});

describe('parseStreamLine', () => {
  it('reads init, tool calls, text and the structured result from a real CLI stream', () => {
    const lines = readFileSync(new URL('./fixtures/stream-read.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
    const events = lines.flatMap(parseStreamLine);
    expect(events[0]).toEqual({ kind: 'init', sessionId: '4983bfb5-d437-4c5a-9f2d-7b646205e87f', model: 'claude-haiku-4-5-20251001' });
    expect(events.filter((e) => e.kind === 'tool').map((e) => e.kind === 'tool' && [e.name, e.id])).toEqual([
      ['Read', 'toolu_01CxwVGhD2M2ttuAPNQhuoU5'],
      ['StructuredOutput', 'toolu_015gW3Gw1MrGHNXSY4M4GzVX'],
    ]);
    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ result: { isError: false, subtype: 'success', output: { text: 'hello fixture' }, turns: 3, denials: [] } });
  });

  it('ignores garbage and service lines', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine('{"type":"system","subtype":"thinking_tokens"}')).toEqual([]);
  });

  it('treats a result that is not success as an error', () => {
    const [e] = parseStreamLine('{"type":"result","subtype":"error_max_turns","is_error":false,"session_id":"s"}');
    expect(e).toMatchObject({ kind: 'result', result: { isError: true, subtype: 'error_max_turns' } });
  });
});

describe('describeTool', () => {
  it('shows commands, files relative to the working folder and search patterns', () => {
    expect(describeTool('Bash', { command: 'mvn   -o\npackage' }, ['/w'])).toBe('Bash: mvn -o package');
    expect(describeTool('Edit', { file_path: '/w/src/A.java' }, ['/w'])).toBe('Edit: src/A.java');
    expect(describeTool('Edit', { file_path: '/private/w/src/A.java' }, ['/w', '/private/w'])).toBe('Edit: src/A.java');
    expect(describeTool('Read', { file_path: '/other/B.java' }, ['/w'])).toBe('Read: /other/B.java');
    expect(describeTool('Grep', { pattern: 'foo', path: '/w/src' }, ['/w'])).toBe('Grep: foo в src');
    expect(describeTool('mcp__atlassian__jira_get_issue', { issue_key: 'TEAM-1' }, ['/w'])).toBe('mcp__atlassian__jira_get_issue');
  });
});

describe('AgentService with the CLI runner', () => {
  const servers: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  function setup(options: AgentOptions = {}) {
    const catalog = new FakeCatalog().add(manifest('a.one'), { run: async () => ({}) }).addPreset(['a.one']);
    const deps = makeEngine(catalog, ['secret-token-value-123'], undefined, { runner: new ClaudeRunner(process.execPath, [FAKE]), ...options });
    const run = deps.engine.createRun({ issueKey: 'TEAM-1' });
    const cwd = mkdtempSync(join(tmpdir(), 'agent-cwd-'));
    const controller = new AbortController();
    const agent = deps.agents.forStep({ runId: run.id, stepId: 'a.one', manifest: manifest('a.one', { agent: { model: 'haiku', maxBudgetUsd: 1, browser: false } }), signal: controller.signal });
    const argsFile = join(cwd, 'args.json');
    const types = () => deps.store.listEvents(run.id).map((e) => e.type);
    return { ...deps, run, cwd, controller, agent, argsFile, types };
  }

  it('runs the agent with the manifest model, streams tool calls to the feed and records the session', async () => {
    const t = setup();
    process.env.CLAUDECODE = '1';
    try {
      const r = await t.agent.run({ label: 'план', prompt: 'Сделай план', cwd: t.cwd, tools: ['Read'], env: { FAKE_ARGS_FILE: t.argsFile } });
      expect(r).toMatchObject({ output: { prompt: 'Сделай план' }, costUsd: 0.12, turns: 3, denials: ['Bash git push origin HEAD'] });
    } finally {
      delete process.env.CLAUDECODE;
    }
    const seen = JSON.parse(readFileSync(t.argsFile, 'utf8')) as { args: string[]; env: string[] };
    expect(seen.args[seen.args.indexOf('--model') + 1]).toBe('haiku');
    const settings = JSON.parse(seen.args[seen.args.indexOf('--settings') + 1]!) as { sandbox: { filesystem: { allowWrite: string[] } } };
    expect(settings.sandbox.filesystem.allowWrite).toEqual([t.cwd, '~/.m2']);
    expect(seen.args[seen.args.indexOf('--max-budget-usd') + 1]).toBe('1');
    expect(seen.env).not.toContain('CLAUDECODE');
    expect(seen.env).toContain('MCP_TOOL_TIMEOUT');
    const feed = t.store.listEvents(t.run.id).map((e) => `${e.type}: ${e.message}`);
    expect(feed).toEqual(
      expect.arrayContaining([
        'agent.started: Агент "план": запуск, модель haiku',
        'agent.text: Читаю код',
        'agent.tool: Read: src/A.java',
        'agent.denied: Агент "план": отказано в 1 вызовах: Bash git push origin HEAD',
      ]),
    );
    expect(feed.some((f) => f.includes('ToolSearch'))).toBe(false);
    // Вызов инструмента хранит ссылку на свой запуск: подробности лента читает из журнала потока, секреты в нем скрыты.
    const read = t.store.listEvents(t.run.id).find((e) => e.type === 'agent.tool')!;
    const session = t.store.lastAgentSession(t.run.id, 'a.one', 'план')!;
    expect(read.data).toEqual({ tool: 'Read', session: session.id, toolUseId: 'toolu_fake_read' });
    expect(await eventDetails(t.store, t.dataDir, read)).toMatchObject({
      kind: 'tool',
      call: { tool: 'Read', input: { file_path: join(realpathSync(t.cwd), 'src/A.java') }, result: { isError: false, text: '1\tclass A {} // ***', filePath: join(realpathSync(t.cwd), 'src/A.java') } },
    });
    expect(t.store.lastAgentSession(t.run.id, 'a.one', 'план')).toMatchObject({ status: 'succeeded', costUsd: 0.12, turns: 3, model: 'haiku' });
    expect(t.agent.lastSession('план')?.status).toBe('succeeded');
    expect(readdirSync(join(t.dataDir, 'agent')).every((d) => !existsSync(join(t.dataDir, 'agent', d, 'mcp.json')))).toBe(true);
  });

  it('continues a session by id', async () => {
    const t = setup();
    await t.agent.run({ label: 'план', prompt: 'еще', cwd: t.cwd, tools: ['Read'], resume: 'session-7', env: { FAKE_ARGS_FILE: t.argsFile } });
    const seen = JSON.parse(readFileSync(t.argsFile, 'utf8')) as { args: string[] };
    expect(seen.args[seen.args.indexOf('--resume') + 1]).toBe('session-7');
    expect(t.store.lastAgentSession(t.run.id, 'a.one', 'план')?.sessionId).toBe('session-7');
  });

  it('fails with the CLI error kind and keeps the cost of the failed run', async () => {
    const t = setup();
    await expect(t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_MODE: 'error' } })).rejects.toThrow('error_max_budget_usd');
    expect(t.store.lastAgentSession(t.run.id, 'a.one', 'план')).toMatchObject({ status: 'failed', costUsd: 0.5 });
    expect(t.types()).toContain('agent.failed');
  });

  it('does not offer to resume a session the CLI never started', async () => {
    const t = setup();
    await expect(t.agent.run({ label: 'реализация', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_MODE: 'noinit' } })).rejects.toThrow('без итога');
    expect(t.agent.lastSession('реализация')).toBeNull();
    await expect(t.agent.run({ label: 'реализация', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_MODE: 'crash' } })).rejects.toThrow('без итога');
    expect(t.agent.lastSession('реализация')).toMatchObject({ status: 'failed' });
  });

  it('fails when the CLI exits without a result and shows its stderr', async () => {
    const t = setup();
    await expect(t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_MODE: 'crash' } })).rejects.toThrow('без итога, код 3: boom');
  });

  it('kills the agent when the owner stops the run', async () => {
    const t = setup();
    const started = Date.now();
    const p = t.agent.run({ label: 'реализация', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_MODE: 'hang' } });
    setTimeout(() => t.controller.abort(), 500);
    await expect(p).rejects.toThrow('Остановлено владельцем');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.store.lastAgentSession(t.run.id, 'a.one', 'реализация')?.status).toBe('aborted');
  });

  it('gives the agent only the owner MCP servers the step asked for, plus the pipeline', async () => {
    const t = setup({ ownerMcp: { atlassian: { command: 'npx', args: ['mcp-atlassian'], env: { JIRA_TOKEN: 'secret-token-value-123' } }, bitbucket: { command: 'npx', args: [], env: {} } } });
    const r = await t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], mcp: ['atlassian'], env: { FAKE_MODE: 'servers' } });
    expect(r.output).toEqual({ servers: ['atlassian', 'pipeline'] });
    await expect(t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], mcp: ['nope'] })).rejects.toThrow('nope не настроен');
  });

  it('gives a new agent the MCP access that is active on the integrations screen when it starts', async () => {
    const t = setup();
    await t.integrations.addToken('jira', { token: 'tech-jira-token-1' });
    const r = await t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], mcp: ['atlassian'], env: { FAKE_MODE: 'mcp-env' } });
    expect(r.output).toMatchObject({ atlassian: { JIRA_URL: 'https://jira.example.org', JIRA_PERSONAL_TOKEN: 'tech-jira-token-1' } });
  });

  it('warns at 80% of the day limit, tells when a session spends it and then starts no new agent', async () => {
    const t = setup();
    // Подменный CLI тратит $0.12 за запуск: первый переходит 80% лимита, второй его исчерпывает.
    t.budget.setLimits({ dayUsd: 0.14, weekUsd: null });
    const run = () => t.agent.run({ label: 'план', prompt: 'Сделай план', cwd: t.cwd, tools: ['Read'], env: { FAKE_ARGS_FILE: t.argsFile } });
    const budgetEvents = () => t.types().filter((type) => type.startsWith('budget.'));
    await run();
    expect(budgetEvents()).toEqual(['budget.warning']);
    await run();
    expect(budgetEvents()).toEqual(['budget.warning', 'budget.exhausted']);
    await expect(run()).rejects.toThrow('Лимит расхода агентов на день исчерпан: $0.24 из $0.14');
    expect(budgetEvents()).toEqual(['budget.warning', 'budget.exhausted', 'budget.exceeded']);
    expect(t.store.agentSessionsOf(t.run.id)).toHaveLength(2);
  });

  it('runs the agent under the active claude account, which the variables of the step cannot replace', async () => {
    const t = setup();
    await t.integrations.addToken('claude', { token: 'sk-ant-oat01-second-account' });
    await t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_ARGS_FILE: t.argsFile, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-step' } });
    expect((JSON.parse(readFileSync(t.argsFile, 'utf8')) as { account: unknown }).account).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second-account' });
    await t.integrations.activate('claude', null);
    await t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_ARGS_FILE: t.argsFile } });
    expect((JSON.parse(readFileSync(t.argsFile, 'utf8')) as { account: unknown }).account).toEqual({});
  });

  it('runs the agent in the folder of a claude account logged in through the browser and keeps its login files unreadable', async () => {
    const t = setup();
    const login = (await t.integrations.startClaudeLogin({})).logins[0]!;
    t.integrations.claudeLoginCode(login.id, 'code-from-page');
    await expect.poll(() => t.integrations.claudeEnv().CLAUDE_CONFIG_DIR).toBeTruthy();
    const dir = t.integrations.claudeEnv().CLAUDE_CONFIG_DIR!;
    await t.agent.run({ label: 'план', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_ARGS_FILE: t.argsFile } });
    const seen = JSON.parse(readFileSync(t.argsFile, 'utf8')) as { args: string[]; account: Record<string, string> };
    expect(seen.account).toEqual({ CLAUDE_CONFIG_DIR: dir });
    expect(seen.args.slice(seen.args.indexOf('--disallowedTools') + 1)).toEqual(expect.arrayContaining([`Read(/${dir}/.credentials.json)`, `Read(/${dir}/.claude.json*)`, `Read(/${dir}/backups/**)`]));
    const settings = JSON.parse(seen.args[seen.args.indexOf('--settings') + 1]!) as { sandbox: { filesystem: { denyRead: string[] } } };
    expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([join(dir, '.credentials.json'), `${join(dir, '.claude.json')}*`, join(dir, 'backups')]));
  });

  /** Сервер Task Pilot на случайном порту с каталогом шага a.one; браузер подменен и запоминает вызовы. */
  async function browserServer(browser: boolean) {
    let url = '';
    const t = setup({ serverUrl: () => url, pipelineScript: PIPELINE });
    const calls: { actions: unknown; shotDir: string }[] = [];
    t.ports.browser = {
      port: 9343,
      ensure: async () => ({ started: false }),
      act: async (actions, shotDir) => {
        calls.push({ actions, shotDir });
        return 'navigated https://stand.example.org/\nshot 01-login';
      },
      kibanaLogs: async () => '',
    };
    const catalog = new FakeCatalog().add(manifest('a.one', { agent: { model: 'haiku', browser } }), { run: async () => ({}) });
    const server = buildServer({ profiles: PROFILES, catalog, tasks: new TaskService({ ...t, profiles: PROFILES }), ...t });
    servers.push(server);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return { ...t, calls };
  }

  it('lets a step whose manifest allows the browser act in the QA browser and keeps screenshots in the task artifacts', async () => {
    const t = await browserServer(true);
    const actions = [{ navigate: 'https://stand.example.org/' }, { shot: '01-login' }];
    const r = await t.agent.run({ label: 'тест', prompt: 'x', cwd: t.cwd, tools: ['Read'], allow: ['mcp__pipeline__qa_browser'], env: { FAKE_MODE: 'browser', FAKE_BROWSER_ACTIONS: JSON.stringify(actions) } });
    expect(r.output).toEqual({ text: 'navigated https://stand.example.org/\nshot 01-login', isError: false });
    expect(t.calls).toEqual([{ actions, shotDir: `${t.engine.artifactsDir(t.run.id)}/qa` }]);
    expect(t.calls[0]!.shotDir).toContain('/.claude/artifacts/TEAM-1/qa');
  });

  it('refuses the QA browser to a step whose manifest does not allow it', async () => {
    const t = await browserServer(false);
    const r = await t.agent.run({ label: 'тест', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_MODE: 'browser', FAKE_BROWSER_ACTIONS: JSON.stringify([{ navigate: 'https://stand.example.org/' }]) } });
    expect(r.output).toMatchObject({ isError: true });
    expect(String((r.output as { text: string }).text)).toContain('Шагу a.one QA-браузер не разрешен');
    expect(t.calls).toEqual([]);
  });

  it('asks the owner through the pipeline MCP server and returns the answer given in the interface', async () => {
    let url = '';
    const t = setup({ serverUrl: () => url, pipelineScript: PIPELINE, askTimeoutMs: 20_000 });
    const tasks = new TaskService({ ...t, profiles: PROFILES });
    const server = buildServer({ profiles: PROFILES, catalog: new FakeCatalog(), tasks, ...t });
    servers.push(server);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const p = t.agent.run({ label: 'тест', prompt: 'x', cwd: t.cwd, tools: ['Read'], env: { FAKE_MODE: 'ask' } });
    let question = t.store.openQuestions(t.run.id)[0];
    for (let i = 0; !question && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      question = t.store.openQuestions(t.run.id)[0];
    }
    expect(question).toMatchObject({ question: 'Какой стенд?', options: ['stable', 'testing-2'], stepId: 'a.one' });
    expect(t.engine.view(t.run.id).questions).toHaveLength(1);
    const answered = await fetch(`${url}/api/questions/${question!.id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-pilot': '1' },
      body: JSON.stringify({ answer: 'testing-2' }),
    });
    expect(answered.status).toBe(200);
    const r = await p;
    expect(r.output).toEqual({ answer: 'testing-2' });
    expect(t.types()).toEqual(expect.arrayContaining(['question.asked', 'question.answered', 'agent.progress', 'agent.finished']));
    expect(t.store.getQuestion(question!.id)?.status).toBe('answered');

    const stranger = await fetch(`${url}/api/agent/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-pilot': '1', 'x-task-pilot-agent': 'forged' },
      body: JSON.stringify({ question: 'x' }),
    });
    expect(stranger.status).toBe(401);
    const late = await fetch(`${url}/api/questions/${question!.id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-pilot': '1' },
      body: JSON.stringify({ answer: 'еще раз' }),
    });
    expect(late.status).toBe(409);
  });
});
