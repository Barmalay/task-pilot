import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRequest, Issue, LogRequest, LogResult, MonitorLogsPort } from '../../packages/step-kit/src/index.ts';
import { monitorProfileSchema } from '../../packages/step-kit/src/index.ts';
import { createMonitorPort } from '../../apps/server/src/monitor/port.ts';
import { GIT_READ } from '../_shared/agent.ts';
import { fakeAgent, testContext, testRepo } from '../_test/context.ts';
import step from './index.ts';

const KEY = 'TEAM-2609';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const PROFILE = monitorProfileSchema.parse({
  source: { id: 'es-prod', mcp: 'elasticsearch' },
  services: [
    {
      id: 'keycloak',
      title: 'Keycloak',
      index: 'cloud-k8s-log-*',
      container: 'gate',
      fields: { message: 'message', level: 'level', logger: 'loggerName.keyword', version: 'container.image.name.keyword', pod: 'kubernetes.pod.name.keyword' },
    },
  ],
});

const ISSUE = { key: KEY, summary: 'Дашборд по RBA', status: 'Monitoring', url: 'https://jira.example.org/browse/TEAM-2609', labels: [], components: ['keycloak'], sprint: null, assignee: null, description: 'Нужен дашборд по логам RBA' } as Issue;

const YAML = `# Дашборд по RBA
id: team-2609-rba
title: RBA
task: ${KEY}
service: keycloak
panels:
  - id: checks
    title: Проверки антифрода
    type: timeseries
    match: ['Проверка антифрода RBA для state', 'status = success']
  - id: red
    title: Красная зона
    type: stat
    match: ['помечена на имитацию']
alerts:
  - id: no-checks
    panel: checks
    when: zero
    window: 15m
`;

/** Логи прода по отбору: у красной зоны строк нет. */
function logs(): MonitorLogsPort {
  const answer = (r: LogRequest): LogResult => {
    const n = r.filter.match.includes('помечена на имитацию') ? 0 : 12;
    if (r.kind === 'count') return { kind: 'count', count: n };
    if (r.kind === 'histogram') {
      const buckets = [];
      for (let t = r.from; t < r.to; t += r.bucketMs) buckets.push({ t, n });
      return { kind: 'histogram', buckets };
    }
    return { kind: 'error', message: 'не ждали' };
  };
  return { run: async (rs) => rs.map(answer), stats: () => ({ windowMs: 1, calls: 0, searches: 0, cached: 0, errors: 0, avgTookMs: null, lastError: null }) };
}

function setup(opts: { files?: string[]; feedback?: string | null; draft?: unknown } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-dashboard-')));
  roots.push(root);
  const dashboards = join(root, 'dashboards');
  const monitor = createMonitorPort({ profile: PROFILE, dir: dashboards, logs: logs() });
  const repo = testRepo(join(root, 'repo'), join(root, 'wt'));
  const files = [...(opts.files ?? [YAML])];
  let c: ReturnType<typeof testContext>;
  const agent = fakeAgent((req: AgentRequest) => {
    const text = files.shift();
    if (text !== undefined) writeFileSync(join(c.paths.agentDocs, 'dashboard.yaml'), text);
    return { sessionId: req.resume ?? 's-1', output: { summary: 'Здоровье интеграции антифрода', lines: ['log.info("Проверка антифрода RBA для state = {}: status = {}")'] } };
  });
  c = testContext({ issueKey: KEY, repo, ports: { monitor }, agent: agent.agent, values: { issue: ISSUE, ac: ['Дашборд показывает ошибки антифрода'] }, feedback: opts.feedback ?? null, draft: opts.draft });
  return { c, agent, dashboards, monitor };
}

describe('monitor.dashboard', () => {
  it('asks the agent to read the code of the task and write only the dashboard file into the docs', async () => {
    const t = setup();
    const draft = (await step.prepare!(t.c)) as { source: string; dashboard: { id: string }; summary: string };
    const req = t.agent.requests[0]!;
    expect(req).toMatchObject({ label: 'дашборд задачи', writeCwd: false, writeDirs: [t.c.paths.agentDocs], allow: GIT_READ });
    expect(req.prompt).toContain(`git log --all --grep=${KEY}`);
    expect(req.prompt).toContain('`keycloak` - Keycloak: контейнер gate, индекс cloud-k8s-log-*');
    expect(req.prompt).toContain('1. Дашборд показывает ошибки антифрода');
    expect(req.prompt).toContain(join(t.c.paths.agentDocs, 'dashboard.yaml'));
    expect(draft).toMatchObject({ source: YAML, dashboard: { id: 'team-2609-rba' }, summary: 'Здоровье интеграции антифрода' });
    expect(readFileSync(join(t.c.paths.docs, 'dashboard.yaml'), 'utf8')).toBe(YAML);
  });

  it('returns the check errors to the agent once in the same session and fails when the file is still wrong', async () => {
    const fixed = setup({ files: ['id: team-2609-rba\ntitle: RBA\n', YAML] });
    await step.prepare!(fixed.c);
    expect(fixed.agent.requests).toHaveLength(2);
    expect(fixed.agent.requests[1]).toMatchObject({ resume: 's-1' });
    expect(fixed.agent.requests[1]!.prompt).toContain('не прошел проверку');
    const broken = setup({ files: ['id: [', 'id: ['] });
    await expect(step.prepare!(broken.c)).rejects.toThrow('Дашборд не прошел проверку: YAML не разбирается');
  });

  it('shows the file, live numbers from prod and a warning for a panel without lines, then saves the file as written', async () => {
    const t = setup();
    t.c.draft = await step.prepare!(t.c);
    const preview = await step.preview!(t.c);
    expect(preview.actions[0]).toBe('Сохранить дашборд "RBA" в dashboards/team-2609-rba/dashboard.yaml: панелей 2, алертов 1');
    // Подтверждается только файл: живые цифры меняются сами и идут справкой вне хэша подтверждения.
    expect(preview.texts?.map((x) => x.id)).toEqual(['dashboard']);
    expect(preview.notes?.map((x) => x.id)).toEqual(['live', 'lines']);
    expect(preview.notes?.find((x) => x.id === 'live')?.text).toBe(['Проверки антифрода: за час 12, за сутки 288', 'Красная зона: за час 0, за сутки 0'].join('\n'));
    expect(preview.warnings).toEqual(['Панель "Красная зона": за сутки на проде ни одной строки - проверьте фразы или что код уже выкачен']);
    expect(await step.done!(t.c)).toBeNull();
    const out = await step.run(t.c);
    expect(out).toEqual({ dashboard: { id: 'team-2609-rba', file: join(t.dashboards, 'team-2609-rba', 'dashboard.yaml') } });
    expect(readFileSync(join(t.dashboards, 'team-2609-rba', 'dashboard.yaml'), 'utf8')).toBe(YAML);
    expect(await step.done!(t.c)).toEqual({ note: 'Дашборд задачи уже есть: "RBA" (dashboards/team-2609-rba)' });
  });

  it('reworks the dashboard in the previous session by the remark of the owner', async () => {
    const first = setup();
    const draft = await step.prepare!(first.c);
    const t = setup({ feedback: 'добавь долю fail-open', draft });
    await step.prepare!(t.c);
    expect(t.agent.requests[0]).toMatchObject({ resume: 's-1' });
    expect(t.agent.requests[0]!.prompt).toContain('добавь долю fail-open');
    expect(existsSync(join(t.dashboards, 'team-2609-rba'))).toBe(false);
  });
});
