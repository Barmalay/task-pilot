/**
 * Демо-режим: полный цикл шагов на учебном репозитории без настоящих Jira и Bitbucket.
 * Запуск: pnpm demo, интерфейс на http://127.0.0.1:5187 (сервер на 127.0.0.1:5186).
 * pnpm demo:script (TASK_PILOT_DEMO_AGENT=script) вместо CLI claude и QA-браузера берет сценарного агента:
 * его реализация DEMO-1 теряет знак разности, тест на стенде это находит, и видна петля доработки по тесту.
 *
 * Профили берутся из учебной команды examples/demo, а не из пакета команды личных настроек. При каждом старте во
 * временной папке заново создаются учебный Java-проект с локальным remote (bare-репозиторий), задачи DEMO-1 и DEMO-2
 * в подмененной Jira, пустой подмененный Bitbucket и подменные Bamboo и Kibana с учебными стендами demo-1 и demo-2,
 * вики в памяти и копия самого Task Pilot вместе с учебной командой: разбор прогона, пресеты и мастер шагов в демо
 * правят ее, а не настоящие файлы. Шаги, агенты, git, сборка в песочнице и подтверждения работают по-настоящему,
 * поэтому цикл проходится целиком, а во внешних системах ничего не меняется.
 */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitOnSignals, startApp } from './app.ts';
import { DEMO_TEAM, loadConfig } from './config.ts';
import { demoBrowser, scriptedAgent } from './demo/agent.ts';
import { demoCi } from './demo/ci.ts';
import { DEMO_ASK_KEY, DEMO_KEY, demoConfig, demoJira, demoPilot, demoScm, seed } from './demo/fixture.ts';
import { demoIntegrations } from './demo/integrations.ts';
import { demoLogs } from './demo/logs.ts';
import { memoryWiki } from './demo/wiki.ts';
import { createGit } from './integrations/git.ts';
import { createShell } from './integrations/shell.ts';
import { seatbeltSandbox } from './integrations/sandbox.ts';
import { integrationDefs } from './integrations/registry.ts';
import { createMonitorPort } from './monitor/port.ts';
import { createQaBrowser, qaBrowserOptions } from './qa/browser.ts';

// Папка вне проекта task-pilot: иначе агент подхватил бы CLAUDE.md самого инструмента как родительский. Смоук и эталоны
// задают свою папку, чтобы не трогать демо, которое открыто рядом.
const root = process.env.TASK_PILOT_DEMO_ROOT ?? join(realpathSync(tmpdir()), 'task-pilot-demo');
const { origin, repo } = seed(root);
const base = demoConfig(loadConfig({ ...process.env, TASK_PILOT_TEAM: DEMO_TEAM }, { otherTeam: true }), root, repo, Number(process.env.TASK_PILOT_DEMO_PORT ?? 5186));
const pilot = demoPilot(root, base.root);
// Учебная команда в копии Task Pilot: разбор прогона правит ее скиллы, шаг "Дашборд задачи" пишет в ее дашборды.
const team = join(pilot, 'examples', 'demo');
const config = {
  ...base,
  root: pilot,
  stepsDir: join(pilot, 'steps'),
  pipelinesDir: join(pilot, 'pipelines'),
  team: { ...base.team, dir: team },
  dashboardsDir: join(team, 'dashboards'),
  featuresDir: join(team, 'features'),
  attemptFile: join(team, 'attempt.yaml'),
  pluginDir: join(team, 'plugin'),
};
const gitPort = createGit();
const ci = demoCi(origin, gitPort);
const scripted = process.env.TASK_PILOT_DEMO_AGENT === 'script';
const app = await startApp(
  config,
  () => ({
    jira: demoJira(config.profiles.jira),
    git: gitPort,
    shell: createShell({ sandbox: seatbeltSandbox({ home: homedir(), dataDir: config.dataDir }) }),
    scm: demoScm(origin, gitPort),
    bamboo: () => ci.bamboo,
    logs: () => ci.logs,
    // Свой порт, чтобы демо не мешало QA-браузеру рабочего экземпляра.
    browser: scripted ? demoBrowser : createQaBrowser(qaBrowserOptions(config.dataDir, process.env, 9344)),
    wiki: memoryWiki(),
    // Дашборды учебной команды из копии Task Pilot, логи прода подменные: к настоящим логам демо не ходит.
    monitor: createMonitorPort({ profile: config.profiles.monitor, dir: config.dashboardsDir, features: config.featuresDir, attempt: config.attemptFile, logs: demoLogs() }),
  }),
  {
    ...(scripted ? { runner: scriptedAgent({ bug: true }).runner } : {}),
    // Экран "Интеграции" в демо: только учебный контур, токены в памяти, проверки подменные.
    integrations: {
      ...demoIntegrations(config.profiles.jira.me, scripted, 'owner@demo.invalid'),
      defs: integrationDefs(config.profiles, config.mcpServers),
    },
  },
);
console.log(`Демо: учебный репозиторий ${repo}, задачи ${DEMO_KEY} (полный цикл) и ${DEMO_ASK_KEY} (вопрос агента)${scripted ? ', агент по сценарию' : ''}`);
exitOnSignals(app);
