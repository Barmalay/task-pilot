import { homedir } from 'node:os';
import type { BambooPort, StandLogsPort } from '@task-pilot/step-kit';
import { exitOnSignals, startApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createScmMcp } from './integrations/bitbucket-mcp.ts';
import { bambooFor } from './integrations/bamboo-rest.ts';
import { createGit } from './integrations/git.ts';
import { createWikiMcp } from './integrations/confluence-mcp.ts';
import { createJiraMcp, jiraRestOf } from './integrations/jira-mcp.ts';
import { esLogsLive } from './integrations/es-logs.ts';
import { createKibanaLogs } from './integrations/kibana.ts';
import { createMonitorPort } from './monitor/port.ts';
import { createQaBrowser, qaBrowserOptions } from './qa/browser.ts';
import { createShell } from './integrations/shell.ts';
import { seatbeltSandbox } from './integrations/sandbox.ts';

const config = loadConfig();
// MCP-сервер Jira и Confluence: имя задает профиль доски.
const atlassian = config.profiles.jira.mcp;
// Порт Bamboo контура пересоздается, когда на экране "Интеграции" сменился доступ к его Bamboo или стенды контура
// перечитаны из Bamboo: порт разрешает деплой только на окружения стендов.
const bamboo = new Map<string, { key: string; port: BambooPort }>();
const logs = new Map<string, StandLogsPort>();

const app = await startApp(config, ({ hub, integrations }) => ({
  jira: createJiraMcp((tool, args) => hub.call(atlassian, tool, args), {
    baseUrl: config.profiles.jira.baseUrl,
    sprintField: config.profiles.jira.sprintField,
    epicField: config.profiles.jira.epicField,
    rest: () => jiraRestOf(integrations.servers()[atlassian]),
  }),
  git: createGit({ headers: () => integrations.gitHeaders() }),
  shell: createShell({ sandbox: seatbeltSandbox({ home: homedir(), dataDir: config.dataDir }) }),
  scm: createScmMcp((server, tool, args) => hub.call(server, tool, args), config.profiles.contours),
  bamboo: (contour) => {
    const servers = integrations.servers();
    const stands = config.profiles.stands.filter((s) => s.contour === contour.id);
    const key = JSON.stringify([(contour.mcp.bamboo && servers[contour.mcp.bamboo]?.env) ?? null, stands]);
    const cached = bamboo.get(contour.id);
    if (cached?.key === key) return cached.port;
    const port = bambooFor(contour, servers, config.profiles.stands);
    bamboo.set(contour.id, { key, port });
    return port;
  },
  logs: (id) => {
    const source = config.profiles.logs[id];
    if (!source) throw new Error(`Неизвестный источник логов ${id}: его нет в logs.yaml слоев`);
    let port = logs.get(id);
    if (!port) logs.set(id, (port = createKibanaLogs(source)));
    return port;
  },
  browser: createQaBrowser(qaBrowserOptions(config.dataDir, process.env)),
  wiki: createWikiMcp((tool, args) => hub.call(atlassian, tool, args)),
  monitor: createMonitorPort({ profile: config.profiles.monitor, dir: config.dashboardsDir, features: config.featuresDir, attempt: config.attemptFile, logs: esLogsLive(config.profiles.monitor, () => integrations.servers()) }),
}));
exitOnSignals(app);
