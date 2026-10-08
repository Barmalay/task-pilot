import { join } from 'node:path';
import type { AgentRequest, AgentResult, Contour, JiraConfig, LinkedRun, LintOptions, Ports, RepoProfile, StandProfile, StepAgent, StepContext, StepTeam, StepTexts, WaitEvent } from '../../packages/step-kit/src/index.ts';
import { lintText, NO_STYLE } from '../../packages/step-kit/src/index.ts';

/** Подключенный контур для тестов шагов: с соглашениями контуров учебного слоя о проде, стенде по умолчанию и сборках. */
export const TEST_CONTOUR: Contour = {
  id: 'cloud',
  title: 'cloud',
  git: 'https://git.example.org',
  bamboo: 'https://bamboo.example.org',
  mcp: {},
  connected: true,
  forbiddenBambooEnvIds: [],
  prodLike: 'reserve|staging',
  defaultStand: '^stable',
  builds: { branchTag: '1.0.{build}-{branch}', masterTag: '1.0.{build}-master', masterRelease: '^release-\\d+$' },
  serviceHeader: 'x-environment',
};

/** Доска команды для тестов шагов. */
export const TEST_JIRA: JiraConfig = {
  baseUrl: 'https://jira.example.org',
  me: 'owner',
  mcp: 'atlassian',
  myIssuesJql: 'assignee = currentUser()',
  sprintField: 'customfield_10330',
  epicField: 'customfield_10933',
  path: [
    { from: 'Open', id: '4', name: 'Start Progress', to: 'In Progress' },
    { from: 'In Progress', id: '971', name: 'Готово к ревью', to: 'Ready to Review' },
    { from: 'Ready to Review', id: '1091', name: 'Можно тестировать', to: 'To Testing' },
  ],
  after: [],
  offPath: ['Waiting', 'Closed'],
  finished: ['Closed'],
  milestones: { inProgress: 'In Progress', review: 'Ready to Review' },
};

/** Пакет команды для тестов шагов: скиллы теста на стенде и вики в плагине команды. */
export const TEST_TEAM: StepTeam = {
  id: 'test',
  title: 'Тестовая команда',
  qaSkill: '/skills/keycloak-stand-qa',
  wikiSkill: '/pilot/plugin/skills/wiki-analysis',
  wikiSpace: null,
};

/** Профиль репозитория для тестов шагов. */
export function testRepo(path: string, worktreesDir: string): RepoProfile {
  return {
    id: 'demo',
    title: 'demo',
    contour: 'cloud',
    default: true,
    match: { components: [], labels: [] },
    path,
    remote: 'origin',
    baseBranch: 'master',
    branchPattern: 'feature/{KEY}',
    worktreesDir,
    commitPaths: [],
    docsDir: '.claude/{KEY}',
    artifactsDir: '.claude/artifacts/{KEY}',
  };
}

/** Связанный прогон для тестов шагов: прогон задачи в другом репозитории с шагами и значениями контекста. */
export function testLinked(opts: { repoId?: string; title?: string; steps?: LinkedRun['steps']; context?: Record<string, unknown>; bitbucket?: boolean } = {}): LinkedRun {
  const id = opts.repoId ?? 'adapter';
  const context = opts.context ?? {};
  return {
    runId: `run-${id}`,
    repo: { ...testRepo(`/repos/${id}`, '/wt'), id, title: opts.title ?? id, contour: 'core', ...(opts.bitbucket === false ? {} : { bitbucket: { project: 'TEAM', repo: id, reviewers: [] } }) },
    status: 'running',
    steps: opts.steps ?? [{ id: 'deploy.stand', selected: true, status: 'pending' }],
    get: <T>(key: string) => context[key] as T | undefined,
  };
}

/** Агент для тестов шагов: запросы сохраняются, ответ и побочные действия задает сценарий. */
export function fakeAgent(script: (req: AgentRequest, n: number) => Promise<Partial<AgentResult>> | Partial<AgentResult> = () => ({})) {
  const requests: AgentRequest[] = [];
  const sessions: { label: string; sessionId: string; status: string }[] = [];
  const agent: StepAgent = {
    async run(req) {
      requests.push(req);
      const n = requests.length;
      const sessionId = req.resume ?? `s-${n}`;
      try {
        const r = await script(req, n);
        sessions.push({ label: req.label, sessionId, status: 'succeeded' });
        return { sessionId, text: '', output: null, costUsd: 0, durationMs: 0, turns: 1, denials: [], ...r };
      } catch (e) {
        sessions.push({ label: req.label, sessionId, status: 'failed' });
        throw e;
      }
    },
    lastSession(label) {
      const s = [...sessions].reverse().find((x) => x.label === label);
      return s ? { sessionId: s.sessionId, status: s.status } : null;
    },
  };
  return { agent, requests, sessions };
}

/** Порт, который тест не настроил: любое обращение к нему - ошибка с именем порта. */
function unused(name: string): never {
  throw new Error(`Порт ${name} в тесте не настроен`);
}

const UNUSED_PORTS: Ports = {
  jira: new Proxy({}, { get: () => unused('jira') }) as Ports['jira'],
  git: new Proxy({}, { get: () => unused('git') }) as Ports['git'],
  shell: new Proxy({}, { get: () => unused('shell') }) as Ports['shell'],
  scm: new Proxy({}, { get: () => unused('scm') }) as Ports['scm'],
  bamboo: () => unused('bamboo'),
  logs: () => unused('logs'),
  browser: new Proxy({}, { get: () => unused('browser') }) as Ports['browser'],
  wiki: new Proxy({}, { get: () => unused('wiki') }) as Ports['wiki'],
  pilot: new Proxy({}, { get: () => unused('pilot') }) as Ports['pilot'],
  monitor: new Proxy({}, { get: () => unused('monitor') }) as Ports['monitor'],
};

/** Контекст шага для тестов: логи собираются в массив, порты, которых нет в ports, падают при обращении. */
export function testContext(opts: {
  issueKey: string;
  repo: RepoProfile;
  ports: Partial<Ports>;
  stand?: StandProfile;
  deployRepo?: RepoProfile;
  values?: Record<string, unknown>;
  jira?: JiraConfig;
  contour?: Contour;
  agent?: StepAgent;
  draft?: unknown;
  feedback?: string | null;
  params?: Record<string, unknown>;
  lint?: LintOptions;
  signal?: AbortSignal;
  linked?: () => LinkedRun[];
  /** Стенды, которые шаг может найти по id, кроме стенда прогона. */
  stands?: StandProfile[];
  /** Событие, которого шаг ждал перед этим входом. */
  waited?: WaitEvent | null;
  team?: StepTeam;
  texts?: StepTexts;
}): StepContext & { logs: string[] } {
  const logs: string[] = [];
  const values = opts.values ?? {};
  return {
    run: { id: 'test-run', issueKey: opts.issueKey, dryRun: false },
    params: opts.params ?? {},
    get: <T>(key: string) => values[key] as T | undefined,
    repo: opts.repo,
    contour: opts.contour ?? TEST_CONTOUR,
    stand: opts.stand,
    deployRepo: opts.deployRepo,
    team: opts.team ?? TEST_TEAM,
    texts: opts.texts ?? { rules: '', style: NO_STYLE },
    jira: opts.jira ?? TEST_JIRA,
    ports: { ...UNUSED_PORTS, ...opts.ports },
    agent: opts.agent ?? fakeAgent().agent,
    paths: {
      docs: join(opts.repo.path, '.claude', opts.issueKey),
      artifacts: join(opts.repo.path, '.claude', 'artifacts', opts.issueKey),
      run: join(opts.repo.worktreesDir, '.run'),
      agentDocs: join(opts.repo.worktreesDir, '.task-pilot', `${opts.repo.id}-${opts.issueKey}`, 'docs'),
    },
    draft: opts.draft,
    feedback: opts.feedback ?? null,
    lint: (text) => lintText(text, opts.lint ?? {}),
    linked: opts.linked ?? (() => []),
    standById: (id) => [...(opts.stand ? [opts.stand] : []), ...(opts.stands ?? [])].find((s) => s.id === id),
    waited: opts.waited ?? null,
    signal: opts.signal ?? new AbortController().signal,
    scratch: new Map(),
    log: (message: string) => {
      logs.push(message);
    },
    logs,
  };
}
