import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, MINUTE, monitorProfileSchema, type IssueRef, type JiraPort, type LogRequest, type LogResult, type MonitorLogsPort, type MonitorProfile } from '@task-pilot/step-kit';
import { EventBus } from '../src/engine/events.ts';
import { createRedactor } from '../src/lib/redact.ts';
import { createMonitorPort } from '../src/monitor/port.ts';
import { discoverUrl, kqlOf, MonitorService } from '../src/monitor/service.ts';
import { Store } from '../src/store/db.ts';

const PROFILE: MonitorProfile = monitorProfileSchema.parse({
  source: { id: 'es-prod', mcp: 'elasticsearch', kibana: 'https://kibana.example.org' },
  tasksJql: 'status = Monitoring',
  services: [
    {
      id: 'keycloak',
      title: 'Keycloak',
      index: 'cloud-k8s-log-*',
      container: 'gate',
      fields: { message: 'message', level: 'level', logger: 'loggerName.keyword', version: 'container.image.name.keyword', pod: 'kubernetes.pod.name.keyword' },
      dataView: 'dv-cloud',
    },
    {
      id: 'adapter',
      title: 'Адаптер',
      index: 'fluentbit-*',
      container: 'adapter',
      fields: { message: 'messagetext', level: 'level.keyword', logger: 'logger.keyword', version: 'kubernetes.app.version.keyword', pod: 'kubernetes.pod.name.keyword' },
      ids: ['flowState.keyword'],
    },
  ],
});

const RBA = {
  id: 'rba',
  title: 'RBA',
  task: 'TEAM-2609',
  service: 'keycloak',
  panels: [
    { id: 'success', title: 'Успешные проверки', type: 'timeseries', match: ['Проверка антифрода RBA', 'status = success'] },
    { id: 'red', title: 'Красная зона', type: 'stat', match: ['помечена на имитацию'] },
  ],
  alerts: [{ id: 'no-success', panel: 'success', when: 'zero', window: '15m' }],
};

const NOW = Date.UTC(2026, 8, 23, 17, 30, 0);

const ref = (key: string, over: Partial<IssueRef> = {}): IssueRef => ({ key, summary: `Задача ${key}`, status: 'Monitoring', url: `https://jira/browse/${key}`, labels: [], components: [], sprint: null, assignee: null, ...over });

/** Jira по JQL: задачи в статусе мониторинга и названия по списку ключей. */
function jiraOf(monitoring: IssueRef[], known: IssueRef[] = []) {
  const searches: string[] = [];
  let down = false;
  const port = {
    async search(jql: string) {
      searches.push(jql);
      if (down) throw new Error('ECONNRESET');
      if (jql === 'status = Monitoring') return monitoring;
      const keys = /key in \((.+)\)/.exec(jql)?.[1]?.split(',') ?? [];
      return [...monitoring, ...known].filter((t) => keys.includes(t.key));
    },
  } as unknown as JiraPort;
  return { port, searches, fail: () => (down = true) };
}

/** Логи, которые отвечают функцией и запоминают запросы. */
function logsOf(answer: (r: LogRequest) => LogResult): MonitorLogsPort & { requests: LogRequest[] } {
  const requests: LogRequest[] = [];
  return {
    requests,
    async run(rs) {
      requests.push(...rs);
      return rs.map(answer);
    },
    stats: () => ({ windowMs: 300_000, calls: 1, searches: requests.length, cached: 0, errors: 0, avgTookMs: 20, lastError: null }),
  };
}

const flat = (n: number) => (r: LogRequest): LogResult => {
  switch (r.kind) {
    case 'count':
      return { kind: 'count', count: n };
    case 'histogram': {
      const buckets = [];
      for (let t = r.from; t < r.to; t += r.bucketMs) buckets.push({ t, n });
      return { kind: 'histogram', buckets };
    }
    case 'versions':
      return { kind: 'versions', versions: [{ key: 'reg/gate:1.0.272-master', first: r.from, last: NOW - 2 * HOUR, n: 10 }, { key: 'reg/gate:1.0.273-master', first: NOW - 2 * HOUR, last: NOW, n: 10 }] };
    case 'terms':
      return { kind: 'terms', terms: [{ key: 'web', n }], other: 0 };
    default:
      return { kind: 'lines', lines: [] };
  }
};

let dir: string;
let store: Store;
let bus: EventBus;
let events: { type: string; message: string | null; data: unknown }[];

function write(id: string, body: unknown, mtime?: number) {
  mkdirSync(join(dir, id), { recursive: true });
  const file = join(dir, id, 'dashboard.yaml');
  writeFileSync(file, typeof body === 'string' ? body : stringify(body));
  if (mtime) utimesSync(file, mtime / 1000, mtime / 1000);
}

function service(logs: MonitorLogsPort, jira = jiraOf([]).port, now = () => NOW) {
  const port = createMonitorPort({ profile: PROFILE, dir, logs });
  return new MonitorService({ port, profile: PROFILE, jira, jiraBaseUrl: 'https://jira', store, bus, now });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-pilot-dash-'));
  store = new Store(':memory:');
  bus = new EventBus(store, createRedactor([]));
  events = [];
  bus.on('event', (e: { type: string; message: string | null; data: unknown }) => events.push(e));
});

describe('monitor dashboards', () => {
  it('reads valid dashboards, reports broken files and rereads a file after it changes', async () => {
    write('rba', RBA, 1_000_000);
    write('broken', 'id: broken\ntitle: x\n');
    write('other-name', { ...RBA, id: 'rba2' });
    write('mobile', { ...RBA, id: 'mobile', service: 'mobile' });
    const port = createMonitorPort({ profile: PROFILE, dir, logs: logsOf(flat(1)) });
    const first = port.dashboards();
    expect(first.dashboards.map((d) => d.id)).toEqual(['rba']);
    expect(first.errors.map((e) => [e.file, e.message.slice(0, 40)])).toEqual([
      ['dashboards/broken/dashboard.yaml', expect.stringContaining('task')],
      ['dashboards/mobile/dashboard.yaml', 'нет сервисов mobile в monitor.yaml'],
      ['dashboards/other-name/dashboard.yaml', 'id rba2 не совпадает с папкой other-name'],
    ]);
    expect(port.dashboards()).toBe(first);
    write('rba', { ...RBA, title: 'RBA 2' }, 2_000_000);
    expect(port.dashboards().dashboards[0]!.title).toBe('RBA 2');
  });

  it('checks a dashboard text, saves it as written to its folder and refuses one with an unknown service', async () => {
    const port = createMonitorPort({ profile: PROFILE, dir, logs: logsOf(flat(1)) });
    const source = `# комментарий остается\n${stringify(RBA)}`;
    expect(port.validate(source)).toMatchObject({ dashboard: { id: 'rba' }, errors: [] });
    expect(port.validate('id: [').errors[0]).toMatch(/^YAML не разбирается/);
    expect(port.validate(stringify({ ...RBA, service: 'nope' })).errors).toEqual(['нет сервисов nope в monitor.yaml']);
    const saved = await port.save(source);
    expect(saved.file).toBe(join(dir, 'rba', 'dashboard.yaml'));
    expect(readFileSync(saved.file, 'utf8')).toBe(source);
    expect(port.dashboards().dashboards.map((d) => d.id)).toEqual(['rba']);
    await expect(port.save(stringify({ ...RBA, id: 'x', service: 'nope' }))).rejects.toThrow('нет сервисов nope');
    await expect(port.save(stringify({ ...RBA, panels: [] }))).rejects.toThrow('Дашборд не прошел проверку');
  });

  it('answers with the reason when prod logs are not configured', async () => {
    const port = createMonitorPort({ profile: PROFILE, dir, logs: { unavailable: 'нет ES_URL' } });
    expect(await port.run([{ kind: 'count', service: PROFILE.services[0]!, filter: { match: [], anyOf: [], not: [], level: [] }, from: 0, to: 1 }])).toEqual([{ kind: 'error', message: 'нет ES_URL' }]);
    expect(port.stats().lastError).toBe('нет ES_URL');
  });
});

describe('monitor overview and dashboards', () => {
  it('groups task cards by epic, adds tasks in Monitoring without a dashboard and keeps tasks covered by a dashboard once', async () => {
    write('rba', { ...RBA, related: ['TEAM-2534'] });
    write('fraud', { ...RBA, id: 'fraud', title: 'Фрод', task: 'TEAM-2487', epic: 'TEAM-2475', alerts: [] });
    const jira = jiraOf([ref('TEAM-2534', { epic: 'TEAM-2475' }), ref('TEAM-2756', { epic: 'TEAM-1555' }), ref('TEAM-2723', { epic: null })], [
      ref('TEAM-2609', { epic: 'TEAM-2475', status: 'Closed' }),
      ref('TEAM-2487', { status: 'Closed' }),
      ref('TEAM-2475', { summary: 'Борьба с фродом', status: 'Разработка' }),
      ref('TEAM-1555', { summary: 'Mobile ID', status: 'Разработка' }),
    ]);
    const o = await service(logsOf(flat(3)), jira.port).overview();
    expect(o.configured).toBe(true);
    expect(o.groups.map((g) => [g.epic?.key ?? null, g.epic?.summary ?? null, g.cards.map((c) => [c.task.key, c.dashboard?.id ?? null, c.status])])).toEqual([
      ['TEAM-2475', 'Борьба с фродом', [['TEAM-2487', 'fraud', 'ok'], ['TEAM-2609', 'rba', 'ok']]],
      ['TEAM-1555', 'Mobile ID', [['TEAM-2756', null, 'empty']]],
      [null, null, [['TEAM-2723', null, 'empty']]],
    ]);
    const rba = o.groups[0]!.cards[1]!;
    expect(rba.task).toMatchObject({ summary: 'Задача TEAM-2609', status: 'Closed' });
    expect(rba.headlines).toMatchObject([{ panel: 'success', kind: 'count', hour: 3, day: 72 }, { panel: 'red', kind: 'count', hour: 3 }]);
    expect(rba.alerts).toMatchObject([{ id: 'no-success', state: 'pending' }]);
  });

  it('shows dashboards when Jira is down and says why the tasks are missing', async () => {
    write('rba', RBA);
    const jira = jiraOf([]);
    jira.fail();
    const o = await service(logsOf(flat(1)), jira.port).overview();
    expect(o.tasksError).toBe('Jira не ответила: ECONNRESET');
    expect(o.groups.flatMap((g) => g.cards.map((c) => c.task))).toEqual([{ key: 'TEAM-2609', summary: null, status: null, url: 'https://jira/browse/TEAM-2609' }]);
  });

  it('gives panel values, deploys inside the period and a Discover link with the same filter', async () => {
    write('rba', RBA);
    const logs = logsOf(flat(2));
    const data = await service(logs).data('rba', '6h');
    expect(data.bucketMs).toBe(5 * MINUTE);
    expect(data.range.to).toBe(NOW);
    expect(data.panels.map((p) => p.value.type)).toEqual(['timeseries', 'stat']);
    expect(data.panels[1]!.value).toEqual({ type: 'stat', value: 2, previous: 2 });
    expect(data.deploys).toEqual([{ service: 'keycloak', version: '1.0.273-master', at: NOW - 2 * HOUR }]);
    const link = data.panels[0]!.discover!;
    expect(link.startsWith('https://kibana.example.org/app/discover#/?_g=')).toBe(true);
    expect(decodeURIComponent(link)).toContain(`index:'dv-cloud'`);
    expect(decodeURIComponent(link)).toContain('message : "Проверка антифрода RBA" and message : "status = success"');
    // Один пакет запросов на экран: панели и версии сервиса.
    expect(logs.requests.map((r) => r.kind)).toEqual(['histogram', 'count', 'count', 'versions']);
    await expect(service(logs).data('nope', '1h')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service(logs).data('rba', '2d')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps the refresh chosen on the page and pauses alerts when polling is off', () => {
    write('rba', RBA);
    const s = service(logsOf(flat(1)));
    expect(s.setRefresh('rba', 'off')).toEqual({ refresh: 'off' });
    expect(store.monitorRefresh('rba')).toBe('off');
    expect(() => s.setRefresh('rba', '10s')).toThrow('не из списка');
  });
});

describe('monitor alerts', () => {
  it('fires once when a window becomes empty, stays quiet while it is still firing and reports when it is resolved', async () => {
    write('rba', RBA);
    let n = 0;
    let now = NOW;
    const s = service(logsOf((r) => (r.kind === 'count' ? { kind: 'count', count: n } : flat(n)(r))), undefined, () => now);
    await s.tick();
    expect(events.map((e) => e.message)).toEqual(['Алерт: RBA: "Успешные проверки": ни одной строки за 15 мин']);
    expect(events[0]!.data).toMatchObject({ dashboard: 'rba', alert: 'no-success', state: 'firing', value: 0 });
    // До конца интервала опроса (30 с по умолчанию) дашборд не проверяется снова.
    now += 10_000;
    n = 5;
    await s.tick();
    expect(events).toHaveLength(1);
    now += 30_000;
    n = 0;
    await s.tick();
    expect(events).toHaveLength(1);
    now += 30_000;
    n = 5;
    await s.tick();
    expect(events.map((e) => e.message)).toEqual(['Алерт: RBA: "Успешные проверки": ни одной строки за 15 мин', 'Алерт снят: RBA: "Успешные проверки": ни одной строки за 15 мин']);
    expect(store.monitorAlerts('rba')).toMatchObject([{ state: 'ok', value: 5 }]);
  });

  it('does not check alerts of a dashboard whose polling is off and forgets alerts removed from the file', async () => {
    write('rba', RBA);
    const logs = logsOf(flat(0));
    const s = service(logs);
    s.setRefresh('rba', 'off');
    await s.tick();
    expect(logs.requests).toEqual([]);
    expect((await s.data('rba', '1h')).alerts).toMatchObject([{ id: 'no-success', state: 'paused' }]);
    store.saveMonitorAlert({ dashboardId: 'rba', alertId: 'gone', state: 'ok', value: 1, threshold: 0, text: 'x' });
    await s.tick();
    expect(store.monitorAlerts('rba').map((a) => a.alertId)).toEqual([]);
  });
});

describe('monitor drill-down', () => {
  it('breaks a panel down by a field and compares equal spans before and after the last deploy', async () => {
    write('rba', RBA);
    const logs = logsOf((r) => (r.kind === 'count' ? { kind: 'count', count: r.from < NOW - 2 * HOUR ? 10 : 30 } : flat(4)(r)));
    const b = await service(logs).breakdown('rba', 'success', '24h', 'extract:channel = ');
    expect(b.items).toEqual([{ key: 'web', n: 4 }]);
    expect(b.deploy).toEqual({ service: 'keycloak', version: '1.0.273-master', at: NOW - 2 * HOUR, before: 10, after: 30, spanMs: 2 * HOUR });
    await expect(service(logs).breakdown('rba', 'success', '24h', 'host')).rejects.toThrow('Разбивка host не из списка');
  });

  it('pages lines of a panel from the newest and refuses windows longer than a week', async () => {
    write('rba', RBA);
    const page = Array.from({ length: 50 }, (_, i) => ({ service: 'keycloak', t: NOW - i * 1000, level: 'INFO', logger: 'x', message: 'm', pod: 'p', version: 'v' }));
    const logs = logsOf((r) => (r.kind === 'lines' ? { kind: 'lines', lines: page } : flat(1)(r)));
    const s = service(logs);
    const first = await s.lines('rba', 'success', NOW - HOUR, NOW, null);
    expect(first.before).toBe(NOW - 49_000);
    await s.lines('rba', 'success', NOW - HOUR, NOW, first.before);
    expect(logs.requests.at(-1)).toMatchObject({ kind: 'lines', to: NOW - 49_000, size: 50 });
    await expect(s.lines('rba', null, NOW - 8 * 24 * HOUR, NOW, null)).rejects.toThrow('не больше недели');
  });

  it('escapes Discover queries and builds links only for services with a data view', () => {
    const kc = PROFILE.services[0]!;
    expect(kqlOf(kc, { match: ['a "b"'], anyOf: [['c', 'd']], not: ['e'], level: ['WARN'] })).toBe(
      'kubernetes.container.name.keyword : "gate" and message : "a \\"b\\"" and (message : "c" or message : "d") and not message : "e" and level : ("WARN")',
    );
    const url = discoverUrl('https://kibana.example.org/', kc, { match: ["it's!"], anyOf: [], not: [], level: [] }, { from: 0, to: 60_000 })!;
    expect(decodeURIComponent(url)).toContain("query:'kubernetes.container.name.keyword : \"gate\" and message : \"it!'s!!\"'");
    expect(discoverUrl('https://kibana.example.org', PROFILE.services[1]!, { match: [], anyOf: [], not: [], level: [] }, { from: 0, to: 1 })).toBeNull();
  });
});
