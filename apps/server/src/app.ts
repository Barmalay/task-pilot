import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ports } from '@task-pilot/step-kit';
import { ClaudeRunner, type AgentRunner } from './agent/claude.ts';
import { scheduleBackups } from './backup.ts';
import { BambooStands } from './bamboo-stands.ts';
import { BudgetService } from './budget.ts';
import { CacheService } from './cache.ts';
import { ForecastService } from './forecast.ts';
import { runDoctor } from './doctor.ts';
import { AgentService } from './agent/service.ts';
import { AskService } from './ask.ts';
import { Catalog } from './catalog/catalog.ts';
import { createPresetEditor } from './catalog/presets.ts';
import { pluginSkills, stepTeamOf, teamRules, type AppConfig } from './config.ts';
import { Engine } from './engine/engine.ts';
import { EventBus } from './engine/events.ts';
import { buildServer } from './http/server.ts';
import { createClaudeCli, type ClaudeCli } from './integrations/claude-cli.ts';
import { McpHub } from './integrations/mcp.ts';
import { integrationDefs, type IntegrationDef } from './integrations/registry.ts';
import { keychainSecrets, type SecretStore } from './integrations/secrets.ts';
import { IntegrationService, type IntegrationServiceDeps } from './integrations/service.ts';
import { createWhoAmI, type WhoAmI } from './integrations/whoami.ts';
import { createRedactor } from './lib/redact.ts';
import { AttemptService } from './monitor/attempts.ts';
import { EditService } from './monitor/edits.ts';
import { FeatureService } from './monitor/features.ts';
import { MonitorService } from './monitor/service.ts';
import { createPilotPort } from './pilot.ts';
import { profileOf } from './profile.ts';
import { createServiceInfo } from './service.ts';
import { Store } from './store/db.ts';
import { TaskService } from './tasks.ts';
import { Watcher } from './watch.ts';

/** Запущенный сервер Task Pilot. */
export interface RunningApp {
  /** Останавливает прогоны, агентов и сервер; шаги в работе помечаются прерванными перезапуском. */
  close(): Promise<void>;
}

/** Из чего собирается сервис интеграций; по умолчанию - Keychain, запросы "кто я" к самим системам и CLI claude. */
export interface IntegrationParts {
  secrets?: SecretStore;
  whoami?: WhoAmI;
  checkDefault?: IntegrationServiceDeps['checkDefault'];
  claude?: ClaudeCli;
  defs?: IntegrationDef[];
}

/** Что получает сборщик портов внешних систем: MCP-серверы и доступ к интеграциям, который может смениться. */
export interface PortsContext {
  hub: McpHub;
  integrations: IntegrationService;
}

/**
 * Собирает и запускает сервер: хранилище, каталог шагов с горячей перезагрузкой, интеграции, агентов, движок и
 * HTTP API. Порты внешних систем собирает вызывающий: настоящие Jira и Bitbucket в main.ts,
 * подмененные в демо-режиме. MCP-серверы владельца нужны в обоих случаях: их получают агенты шагов.
 * Доступ к ним дают интеграции: "как обычно" из ~/.claude.json или токены с экрана "Интеграции".
 * Порт самого Task Pilot (журнал прогона и проверка правок) собирается здесь: ему нужны хранилище и каталог.
 * Агенты работают через CLI claude; демо со сценарным агентом передает свой runner.
 */
export async function startApp(
  config: AppConfig,
  makePorts: (ctx: PortsContext) => Omit<Ports, 'pilot'>,
  opts: { runner?: AgentRunner; integrations?: IntegrationParts } = {},
): Promise<RunningApp> {
  mkdirSync(config.dataDir, { recursive: true });
  const startedAt = new Date();
  // Один список секретов у маскировщика и линтера: токены с экрана "Интеграции" добавляются в оба.
  const lintSecrets = [...config.secrets];
  const redact = createRedactor(config.secrets);
  const store = new Store(join(config.dataDir, 'task-pilot.db'));
  const bus = new EventBus(store, redact);
  const stopBackups = config.backupsDir
    ? scheduleBackups({
        db: store,
        dir: config.backupsDir,
        onError: (e) => {
          console.error('Резервная копия базы не сделана', e);
          bus.emitEvent({ type: 'backup.failed', message: `Резервная копия базы не сделана: ${e instanceof Error ? e.message : String(e)}` });
        },
      })
    : () => {};
  const budget = new BudgetService({ store, bus });

  const catalog = new Catalog(config.stepsDir, config.pipelinesDir);
  catalog.on('updated', () => {
    const errors = catalog.errors();
    bus.emitEvent({ type: 'catalog.updated', message: errors.length ? `Каталог перезагружен, ошибок: ${errors.length}` : 'Каталог перезагружен', data: { errors } });
  });
  catalog.on('error', (e: unknown) => bus.emitEvent({ type: 'catalog.error', message: e instanceof Error ? e.message : String(e) }));
  await catalog.load();
  catalog.watch();

  const parts = opts.integrations ?? {};
  const integrations = new IntegrationService({
    defs: parts.defs ?? integrationDefs(config.profiles, config.mcpServers),
    base: config.mcpServers,
    store,
    secrets: parts.secrets ?? keychainSecrets(),
    whoami: parts.whoami ?? createWhoAmI(),
    ...(parts.checkDefault ? { checkDefault: parts.checkDefault } : {}),
    claude: parts.claude ?? createClaudeCli(config.claudeCli),
    claudeAccountsDir: config.claudeAccountsDir,
    claudeHome: join(homedir(), '.claude'),
    jira: config.profiles.jira,
    redact,
    onSecret: (value) => {
      redact.add(value);
      lintSecrets.push(value);
    },
    bus,
    // Сервис агентов собирается ниже: к моменту удаления аккаунта он уже есть.
    agentsRunning: () => agents.running(),
  });
  await integrations.init();

  const hub = new McpHub(() => integrations.servers());
  const external = makePorts({ hub, integrations });
  const title = (stepId: string) => catalog.entry(stepId)?.manifest.title ?? stepId;
  const ports: Ports = {
    ...external,
    pilot: createPilotPort({ root: config.root, skillsDir: pluginSkills(config.pluginDir), teamRules: join(config.team.dir, 'rules.md'), store, redact, shell: external.shell, title }),
  };
  // Стенды контуров с правилом в профиле: сначала из снимков в базе, чтобы движок и API видели их сразу при запуске.
  const bambooStands = new BambooStands({ profiles: config.profiles, store, bus, bamboo: ports.bamboo });
  bambooStands.loadSnapshots();

  const agents = new AgentService({
    store,
    bus,
    redact,
    runner: opts.runner ?? new ClaudeRunner(config.claudeCli),
    ownerMcp: () => integrations.servers(),
    claudeEnv: () => integrations.claudeEnv(),
    claudeSecrets: () => integrations.claudeSecretPaths(),
    pipelineScript: fileURLToPath(new URL('./agent/pipeline-mcp.ts', import.meta.url)),
    pluginDir: config.pluginDir,
    // Серверы, чьи пишущие инструменты агентам запрещены: имена из профилей доски и контуров, а не из списка.
    writeServers: {
      atlassian: [config.profiles.jira.mcp],
      bitbucket: config.profiles.contours.flatMap((c) => c.mcp.bitbucket ?? []),
      bamboo: config.profiles.contours.flatMap((c) => c.mcp.bamboo ?? []),
    },
    budget,
    serverUrl: () => `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    askTimeoutMs: config.askTimeoutMs,
    // Таймаут инструментов CLI длиннее ожидания ask_owner: вопрос закрывается сам и агент заканчивает шаг аккуратно.
    mcpToolTimeoutMs: config.askTimeoutMs + 5 * 60_000,
  });

  const engine = new Engine({
    store,
    bus,
    catalog,
    profiles: config.profiles,
    ports,
    redact,
    agents,
    lint: { secrets: lintSecrets, names: config.profiles.lint.names, allowEmails: config.profiles.lint.allowEmails, style: config.style },
    dataDir: config.dataDir,
    jira: () => integrations.jiraProfile(),
    team: stepTeamOf(config),
    texts: () => ({ rules: teamRules(config.team.dir), style: config.style }),
  });
  engine.recover();
  const tasks = new TaskService({ engine, store, bus, ports, profiles: config.profiles, redact });
  const watcher = new Watcher({ store, engine, bus, ports, profiles: config.profiles, jira: () => integrations.jiraProfile(), redact }, config.watchMs, config.watchFastMs);
  watcher.start();
  const monitor = new MonitorService({ port: ports.monitor, profile: config.profiles.monitor, jira: ports.jira, jiraBaseUrl: config.profiles.jira.baseUrl, store, bus });
  monitor.start();
  // Воронки фич входа: дневные итоги копятся в базе, их обновление идет сразу и раз в час.
  const features = new FeatureService({ port: ports.monitor, store, timeZone: config.profiles.monitor?.timeZone ?? 'UTC' });
  features.start();
  const attempts = new AttemptService({ port: ports.monitor });
  const stopStands = bambooStands.start();

  const cache = new CacheService({
    store,
    bus,
    dataDir: config.dataDir,
    qaProfileDir: join(config.dataDir, 'qa-chrome'),
    isActive: (runId) => engine.isActive(runId),
    qaRunning: () => ports.browser.running?.() ?? Promise.resolve(false),
  });
  const forecast = new ForecastService({ store, bus, manifestOf: (stepId) => catalog.entry(stepId)?.manifest });
  const asks = new AskService({ store, bus, agents, redact, title, root: config.root });
  // Правка мониторинга по запросу: агент вне прогона готовит черновик файла пакета команды, пишет его владелец.
  const edits = new EditService({ port: ports.monitor, store, agents, redact, monitor, features, root: config.root, teamDir: config.team.dir });
  const presets = createPresetEditor({ dir: config.pipelinesDir, catalog, reload: () => catalog.load(), board: () => integrations.jiraProfile() });
  const service = await createServiceInfo({
    root: config.root,
    dataDir: config.dataDir,
    personalFile: config.personalFile,
    teamAreas: [join(config.team.dir, 'team.yaml'), join(config.team.dir, 'profiles')],
    store,
    git: ports.git,
    redact,
    startedAt,
    pid: process.pid,
  });
  const app = buildServer({
    profiles: config.profiles,
    store,
    bus,
    catalog,
    engine,
    tasks,
    agents,
    ports,
    redact,
    integrations,
    presets,
    dataDir: config.dataDir,
    monitor,
    features,
    attempts,
    edits,
    budget,
    cache,
    forecast,
    asks,
    profile: () => profileOf(config),
    doctor: () => runDoctor(config),
    service,
    qaLogs: config.team.manifest.qa?.logs ?? null,
  });
  await app.listen({ host: config.host, port: config.port });
  console.log(`Task Pilot API: http://${config.host}:${config.port}`);
  for (const e of catalog.errors()) console.warn(`Каталог: ${e.file}: ${e.message}`);

  return {
    async close() {
      // Сначала наблюдатель и движок: шаги помечаются прерванными перезапуском, сборки и агенты останавливаются.
      watcher.stop();
      monitor.stop();
      features.stop();
      integrations.close();
      await engine.shutdown(8000);
      asks.close();
      edits.close();
      agents.close();
      catalog.close();
      await app.close();
      await hub.close();
      stopStands();
      stopBackups();
      store.close();
    },
  };
}

/** Завершает процесс по SIGINT и SIGTERM, закрывая сервер. */
export function exitOnSignals(app: RunningApp): void {
  const shutdown = async () => {
    // Страховка: если что-то держит процесс, выходим все равно, иначе перезапуск в dev зависает.
    // Запас больше 5 с, за которые сборка и агент получают SIGKILL после SIGTERM.
    setTimeout(() => process.exit(0), 12_000).unref();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
