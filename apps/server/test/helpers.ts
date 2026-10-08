import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presetOrderIssues, TASK_INPUTS, type Issue, type JiraPort, type Ports, type Preset, type StepManifest, type StepModule } from '@task-pilot/step-kit';
import type { AgentRunner } from '../src/agent/claude.ts';
import { memoryJiraFiles } from '../src/demo/jira-files.ts';
import { AgentService } from '../src/agent/service.ts';
import { AskService } from '../src/ask.ts';
import { BudgetService } from '../src/budget.ts';
import { CacheService } from '../src/cache.ts';
import { ForecastService } from '../src/forecast.ts';
import type { CatalogEntry, CatalogView } from '../src/catalog/catalog.ts';
import { createPresetEditor } from '../src/catalog/presets.ts';
import type { McpServerConfig, Profiles } from '../src/config.ts';
import { Engine } from '../src/engine/engine.ts';
import { EventBus } from '../src/engine/events.ts';
import type { Waiting } from '../src/engine/status.ts';
import type { ClaudeCli } from '../src/integrations/claude-cli.ts';
import { integrationDefs } from '../src/integrations/registry.ts';
import { memorySecrets } from '../src/integrations/secrets.ts';
import { IntegrationService, type IntegrationServiceDeps } from '../src/integrations/service.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { createMonitorPort } from '../src/monitor/port.ts';
import { MonitorService } from '../src/monitor/service.ts';
import { Store } from '../src/store/db.ts';
import type { Watcher } from '../src/watch.ts';

/** Манифест шага для тестов движка. */
export function manifest(id: string, over: Partial<StepManifest> = {}): StepManifest {
  return { id, title: id, hint: `шаг ${id}`, phase: 'task', kind: 'code', requires: [], provides: [], gate: 'none', sideEffects: true, interactive: false, params: {}, refresh: [], background: false, ...over };
}

/** Каталог в памяти. */
export class FakeCatalog implements CatalogView {
  readonly map = new Map<string, CatalogEntry>();
  readonly presetMap = new Map<string, Preset>();

  add(m: StepManifest, module?: StepModule): this {
    this.map.set(m.id, { manifest: m, implemented: !!module, module, stage: module ? null : 2 });
    return this;
  }

  addPreset(steps: string[], off: string[] = [], id = 'full', inputs: string[] = [...TASK_INPUTS], params: Preset['params'] = {}): this {
    this.presetMap.set(id, { id, title: 'Пресет', hint: 'тест', steps, off, inputs, params });
    return this;
  }

  entry(id: string) {
    return this.map.get(id);
  }

  entries() {
    return [...this.map.values()];
  }

  preset(id: string) {
    return this.presetMap.get(id);
  }

  presets() {
    return [...this.presetMap.values()];
  }

  presetIssues(id: string) {
    const preset = this.presetMap.get(id);
    return preset ? presetOrderIssues(preset, (step) => this.map.get(step)?.manifest) : [];
  }

  errors() {
    return [];
  }

  loadedAt() {
    return '';
  }
}

const REPO_BASE = {
  remote: 'origin',
  baseBranch: 'master',
  branchPattern: 'feature/{KEY}',
  worktreesDir: '/tmp/wt',
  commitPaths: [],
  docsDir: '.claude/{KEY}',
  artifactsDir: '.claude/artifacts/{KEY}',
};

/** Соглашения контуров учебного слоя: имена прода, стенд по умолчанию, схема сборок Bamboo и заголовок среды сервиса. */
export const CONVENTIONS = {
  prodLike: 'reserve|staging',
  defaultStand: '^stable',
  builds: { branchTag: '1.0.{build}-{branch}', masterTag: '1.0.{build}-master', masterRelease: '^release-\\d+$' },
  serviceHeader: 'x-environment',
};

/** Профили для тестов движка и API: репозиторий по умолчанию и репозиторий неподключенного контура. */
export const PROFILES: Profiles = {
  repos: [
    { id: 'api-auth', title: 'api-auth', contour: 'core', default: false, match: { components: ['api'], labels: [] }, path: '/tmp/api-auth', ...REPO_BASE },
    { id: 'demo', title: 'demo', contour: 'cloud', default: true, match: { components: ['keycloak'], labels: [] }, path: '/tmp/demo', ...REPO_BASE },
  ],
  stands: [
    { id: 'stable', title: 'stable', contour: 'cloud', namespace: 'stable-cloud', bambooEnv: 'Stable-Cloud', bambooEnvId: 1, logs: 'kibana', deployable: true, notes: [] },
  ],
  contours: [
    { id: 'cloud', title: 'cloud', git: 'https://git.example.org', bamboo: 'https://bamboo.example.org', mcp: {}, connected: true, forbiddenBambooEnvIds: [], ...CONVENTIONS },
    { id: 'core', title: 'core', git: 'https://git2.example.org', bamboo: 'https://bamboo2.example.org', mcp: {}, connected: false, forbiddenBambooEnvIds: [], ...CONVENTIONS },
  ],
  jira: {
    baseUrl: 'https://jira.example.org',
    me: 'owner',
    mcp: 'atlassian',
    myIssuesJql: 'assignee = currentUser()',
    board: { id: 1061, name: 'Доска' },
    sprintField: 'customfield_10330',
    epicField: 'customfield_10933',
    path: [{ from: 'Open', id: '4', name: 'Start Progress', to: 'In Progress' }],
    after: [],
    offPath: [],
    finished: [],
    milestones: { inProgress: 'In Progress' },
  },
  lint: { names: ['Петров'], allowEmails: [] },
  logs: { kibana: { kind: 'kibana', url: 'https://kibana.example.org', index: 'mon-*', imageField: 'container.image.name.keyword' } },
  monitor: null,
};

/** Задача для фейкового порта Jira. */
export function issue(key: string, over: Partial<Issue> = {}): Issue {
  return {
    key,
    summary: `Задача ${key}`,
    status: 'Open',
    url: `https://jira.example.org/browse/${key}`,
    labels: [],
    components: [],
    sprint: null,
    assignee: { name: 'owner' },
    description: '## Критерии приемки\n- первый\n- второй',
    ...over,
  };
}

/** Фейковый порт Jira: задачи из словаря, запросы поиска сохраняются. */
export function fakeJira(issues: Record<string, Issue> = {}) {
  const searches: string[] = [];
  const port: JiraPort = {
    async search(jql) {
      searches.push(jql);
      return Object.values(issues);
    },
    async getIssue(key) {
      const found = issues[key];
      if (!found) throw new Error(`Задача ${key} не найдена`);
      return found;
    },
    async getTransitions() {
      return [];
    },
    async transition() {},
    async assign() {},
    async sprints(_board, state) {
      return state === 'active' ? [{ id: 4911, name: 'Спринт', state: 'active' }] : [{ id: 4314, name: 'Оцененные задачи', state: 'future' }];
    },
    ...memoryJiraFiles('https://jira.example.org').port,
  };
  return { port, searches };
}

/** Раннер агента, которого в тесте нет: любой запуск агента - ошибка. */
export const NO_RUNNER: AgentRunner = {
  async run() {
    throw new Error('агент в тесте не настроен');
  },
};

/** Настройки сервиса агентов в тестах. */
export interface AgentOptions {
  runner?: AgentRunner;
  serverUrl?: () => string;
  pipelineScript?: string;
  ownerMcp?: Record<string, McpServerConfig>;
  askTimeoutMs?: number;
  /** Подмены в сервисе интеграций: проверки доступа, CLI claude, хранилище токенов. */
  integrations?: Partial<IntegrationServiceDeps>;
  /** Профили движка вместо PROFILES. */
  profiles?: Profiles;
}

/** CLI claude тестов: вошел владелец, токены принимаются, вход через браузер заканчивается кодом. */
export function fakeClaudeCli(over: Partial<ClaudeCli> = {}): ClaudeCli {
  return {
    async status() {
      return { loggedIn: true, method: 'claude.ai', email: 'owner@example.org', org: 'Команда', plan: 'team' };
    },
    login() {
      let finish: (r: { code: number | null; output: string }) => void = () => {};
      const done = new Promise<{ code: number | null; output: string }>((resolve) => (finish = resolve));
      return { url: () => 'https://claude.example.org/login', sendCode: () => finish({ code: 0, output: '' }), cancel: () => finish({ code: null, output: '' }), done };
    },
    async logout() {},
    async probe() {},
    ...over,
  };
}

/** Движок на базе в памяти; сервис агентов работает с переданным раннером. */
export function makeEngine(catalog: FakeCatalog, secrets: string[] = [], jira: JiraPort = fakeJira().port, agentOptions: AgentOptions = {}) {
  const store = new Store(':memory:');
  const redact = createRedactor(secrets);
  const bus = new EventBus(store, redact);
  const ports = { jira, git: {}, shell: {}, scm: {} } as Ports;
  const dataDir = mkdtempSync(join(tmpdir(), 'task-pilot-test-'));
  // Стиль текстов владельца: движок проверяет публикуемые тексты его линтером.
  const lint = { secrets: [...secrets], names: PROFILES.lint.names, allowEmails: [], style: { yo: true, dash: true, quotes: true } };
  // Интеграции тестов: токены в памяти, доступ "как обычно" у всех - владелец, вошел CLI claude владельца.
  const integrations = new IntegrationService({
    defs: integrationDefs(PROFILES, {}),
    base: {},
    store,
    secrets: memorySecrets(),
    whoami: async () => ({ login: 'owner', name: 'Владелец' }),
    checkDefault: async (def) => (def.kind === 'kibana' ? { login: null, name: null } : { login: 'owner', name: 'Владелец' }),
    claude: fakeClaudeCli(),
    claudeAccountsDir: join(dataDir, 'claude-accounts'),
    claudeHome: join(dataDir, 'claude-home'),
    jira: PROFILES.jira,
    redact,
    onSecret: (value) => {
      redact.add(value);
      lint.secrets.push(value);
    },
    bus,
    agentsRunning: () => agents.running(),
    ...agentOptions.integrations,
  });
  // Агенты получают доступ так же, как в app.ts: MCP-серверы и аккаунт Claude с экрана "Интеграции".
  // Лимиты расхода по умолчанию: тесты агентов тратят ноль и в лимит не упираются, пока тест сам его не поставит.
  const budget = new BudgetService({ store, bus });
  const agents = new AgentService({
    store,
    bus,
    redact,
    runner: agentOptions.runner ?? NO_RUNNER,
    ownerMcp: agentOptions.ownerMcp ?? (() => integrations.servers()),
    claudeEnv: () => integrations.claudeEnv(),
    claudeSecrets: () => integrations.claudeSecretPaths(),
    pipelineScript: agentOptions.pipelineScript ?? '/dev/null',
    serverUrl: agentOptions.serverUrl ?? (() => 'http://127.0.0.1:1'),
    dataDir,
    askTimeoutMs: agentOptions.askTimeoutMs ?? 1000,
    mcpToolTimeoutMs: 60_000,
    budget,
  });
  const engine = new Engine({ store, bus, catalog, profiles: agentOptions.profiles ?? PROFILES, ports, redact, agents, lint, dataDir, jira: () => integrations.jiraProfile() });
  // Пресеты пишутся во временную папку: каталог тестов их не перечитывает.
  const presets = createPresetEditor({ dir: join(dataDir, 'pipelines'), catalog, reload: async () => {}, board: () => PROFILES.jira });
  // Панель мониторинга без профиля: тесты API и движка в логи прода не ходят.
  const monitorPort = createMonitorPort({ profile: null, dir: join(dataDir, 'dashboards'), logs: { unavailable: 'Логи прода в тестах не подключены' } });
  const monitor = new MonitorService({ port: monitorPort, profile: null, jira, jiraBaseUrl: PROFILES.jira.baseUrl, store, bus });
  // Кэш на служебной папке теста; QA-браузер в тестах закрыт.
  const cache = new CacheService({ store, bus, dataDir, qaProfileDir: join(dataDir, 'qa-chrome'), isActive: (runId) => engine.isActive(runId), qaRunning: async () => false });
  // Прогноз по истории базы теста и шагам его каталога.
  const forecast = new ForecastService({ store, bus, manifestOf: (stepId) => catalog.entry(stepId)?.manifest });
  // Вопросы о прогоне отвечает тот же сервис агентов: исполнитель теста видит и их задания.
  const asks = new AskService({ store, bus, agents, redact, title: (stepId) => catalog.entry(stepId)?.manifest.title ?? stepId, root: dataDir });
  return { store, bus, engine, redact, ports, agents, dataDir, integrations, presets, monitor, budget, cache, forecast, asks };
}

/**
 * Ведет прогон через ожидания сборки, деплоя и выкатки так, как это делает наблюдатель: пока прогон ждет события,
 * проверка наблюдателя повторяется, а продолжение прогона дожидается. Возвращает, когда прогон остановился не на
 * таком ожидании: ждет подтверждения, выполнен, упал или ждет PR, который тест ведет сам (замечания, мерж).
 */
export async function throughWaits(d: { engine: Engine; watcher: Watcher; store: Store }, runId: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (d.engine.isActive(runId)) {
      await d.engine.settled(runId);
      continue;
    }
    const waiting = d.store.getContext(runId).waiting as Waiting | undefined;
    if (d.store.getRun(runId)?.status !== 'waiting' || !waiting || waiting.event.kind === 'pr') return;
    if (Date.now() > until) throw new Error(`Прогон так и не дождался ${waiting.event.kind}: ${d.store.getStep(runId, waiting.stepId)?.note ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await d.watcher.tick();
  }
}
