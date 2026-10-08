import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { HOUR, localDay, MINUTE, monitorProfileSchema, type LogFilter, type LogLine, type LogRequest, type LogResult, type MonitorLogsPort, type MonitorProfile } from '@task-pilot/step-kit';
import { FeatureService } from '../src/monitor/features.ts';
import { createMonitorPort } from '../src/monitor/port.ts';
import { Store } from '../src/store/db.ts';

const TZ = 'Europe/Moscow';
const PROFILE: MonitorProfile = monitorProfileSchema.parse({
  source: { id: 'es-prod', mcp: 'elasticsearch' },
  timeZone: TZ,
  services: [
    {
      id: 'keycloak',
      title: 'Keycloak',
      index: 'cloud-k8s-log-*',
      container: 'gate',
      fields: { message: 'message', level: 'level', logger: 'loggerName.keyword', version: 'container.image.name.keyword', pod: 'kubernetes.pod.name.keyword', trace: 'mdc.traceId.keyword' },
    },
  ],
});

/** Профиль фичи в виде файла пакета команды: капча с тестовой веткой, исходами по трассе и входом по callback. */
const CAPTCHA = {
  id: 'captcha',
  title: 'Капча на входе по телефону',
  short: 'Капча',
  since: '2026-09-09',
  sinceNote: 'с 11:11',
  service: 'keycloak',
  intro: 'Капча для желтой зоны.',
  session: 'state ?= ?([A-Za-z0-9_\\-]{6,})',
  baseline: { label: 'Риск-проверок', any: ['Проверка антифрода RBA для state'] },
  stages: [
    { key: 'entered', label: 'Попали в желтую зону', any: ['желтая зона'], role: 'entry' },
    { key: 'shown', label: 'Увидели форму капчи', any: ['показана форма капчи'], role: 'shown' },
    { key: 'passed', label: 'Прошли капчу', any: ['Капча для state'], all: ['пройдена'], role: 'success' },
    { key: 'test', label: 'Тестовый номер', any: ['тестовый номер реалма'], role: 'skip' },
  ],
  errors: [{ key: 'rejected', label: 'Токен отвергнут', any: ['токен отвергнут сервисом'] }],
  downstream: {
    from: 'passed',
    by: 'trace',
    title: 'Что дальше',
    outcomes: [
      { key: 'code_sent', label: 'Код ушел', any: ['Код отправлен провайдером'], tone: 'good' },
      { key: 'brute_block', label: 'Слишком много попыток', any: ['Блокировка по числу попыток'], tone: 'bad' },
    ],
  },
  login: { from: 'passed', label: 'Дошли до входа', any: ['www.example.com/auth/event'], session: '"state":"([^"]+)"' },
  timing: { from: 'shown', to: 'passed', label: 'От показа до токена' },
  automation: { stage: 'shown', threshold: 3 },
};

const NOW = Date.UTC(2026, 8, 30, 9, 30); // 30.09 12:30 по Москве
const T0 = Date.UTC(2026, 8, 30, 7, 0); // 30.09 10:00 по Москве
const at = (min: number, sec = 0) => T0 + min * MINUTE + sec * 1000;
const kc = (t: number, message: string, trace = 'tr-a'): LogLine => ({ service: 'keycloak', t, level: 'INFO', logger: 'l', message, pod: 'p', version: '1.0.1', trace });

/**
 * Строки окна: s1 прошел капчу, получил код и вошел; s2 бросил форму; бот s3 показал форму трижды и упал в блокировку;
 * s4 - тестовый номер. Риск-проверки идут и за два дня до окна, чтобы у дневных итогов было прошлое.
 */
const LINES: LogLine[] = [
  kc(at(-2 * 24 * 60), 'Проверка антифрода RBA для state = old001'),
  kc(at(0), 'Проверка антифрода RBA для state = sess01'),
  kc(at(0, 1), 'state = sess01: желтая зона, score=90'),
  kc(at(0, 2), 'state = sess01: показана форма капчи'),
  kc(at(0, 9), 'Капча для state = sess01: пройдена', 'tr-1'),
  kc(at(0, 10), "Код отправлен провайдером 'mobile-id'", 'tr-1'),
  kc(at(0, 30), 'POST https://www.example.com/auth/event {"state":"sess01"}', 'tr-9'),
  kc(at(10), 'state = sess02: желтая зона, score=100'),
  kc(at(10, 2), 'state = sess02: показана форма капчи'),
  kc(at(20), 'state = sess03: желтая зона, score=90'),
  ...[2, 4, 6].map((s) => kc(at(20, s), 'state = sess03: показана форма капчи')),
  kc(at(20, 8), 'Капча для state = sess03: пройдена', 'tr-3'),
  kc(at(20, 9), 'Блокировка по числу попыток', 'tr-3'),
  kc(at(30), 'state = sess04: желтая зона, score=90'),
  kc(at(30, 1), 'state = sess04: тестовый номер реалма, капча пропущена'),
  kc(at(40), 'Капча для state = sess05: токен отвергнут сервисом'),
];

const has = (l: LogLine, p: string) => l.message.includes(p);
const passes = (l: LogLine, f: LogFilter) =>
  f.match.every((p) => has(l, p)) && f.anyOf.every((g) => g.some((p) => has(l, p))) && !f.not.some((p) => has(l, p)) && (f.terms ?? []).every((t) => t.values.includes(l.trace ?? ''));

/** Кластер по строкам LINES: поиск окна отвечает "не влезло", пока окно длиннее maxMs. */
function clusterOf(o: { maxMs?: number; lines?: LogLine[]; fail?: string } = {}): MonitorLogsPort & { requests: LogRequest[] } {
  const requests: LogRequest[] = [];
  const lines = o.lines ?? LINES;
  const answer = (r: LogRequest): LogResult => {
    if (o.fail) return { kind: 'error', message: o.fail };
    const inWindow = lines.filter((l) => l.t >= r.from && l.t < r.to && passes(l, r.filter));
    if (r.kind === 'daily') {
      const days: Record<string, Record<string, number>> = {};
      for (const l of inWindow) {
        const d = (days[localDay(l.t, r.timeZone)] ??= Object.fromEntries(Object.keys(r.rules).map((k) => [k, 0])));
        for (const [k, f] of Object.entries(r.rules)) if (passes(l, f)) d[k]!++;
      }
      return { kind: 'daily', days };
    }
    if (r.kind === 'docs') {
      const capped = r.to - r.from > (o.maxMs ?? Infinity) && inWindow.length > 0;
      return { kind: 'docs', lines: capped ? inWindow.slice(0, 1) : inWindow, capped };
    }
    throw new Error(`неожиданный запрос ${r.kind}`);
  };
  return {
    requests,
    async run(rs) {
      requests.push(...rs);
      return rs.map(answer);
    },
    stats: () => ({ windowMs: 300_000, calls: 1, searches: requests.length, cached: 0, errors: 0, avgTookMs: 20, lastError: null }),
  };
}

function setup(o: { logs?: ReturnType<typeof clusterOf>; profiles?: Record<string, unknown>; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-features-'));
  const features = join(dir, 'features');
  mkdirSync(features);
  for (const [name, p] of Object.entries(o.profiles ?? { 'captcha.yaml': CAPTCHA })) writeFileSync(join(features, name), typeof p === 'string' ? p : stringify(p));
  const logs = o.logs ?? clusterOf();
  const port = createMonitorPort({ profile: PROFILE, dir: join(dir, 'dashboards'), features, logs });
  const store = new Store(':memory:');
  let now = NOW;
  const service = new FeatureService({ port, store, timeZone: TZ, now: o.now ?? (() => now) });
  return { dir, features, port, store, service, logs, setNow: (t: number) => (now = t) };
}

describe('feature profiles of the team pack', () => {
  it('are read from features/<id>.yaml, and a broken file, an unknown service or an id other than the file name is named', () => {
    const { port, features } = setup({
      profiles: {
        'captcha.yaml': CAPTCHA,
        'broken.yaml': 'id: [',
        'other.yaml': { ...CAPTCHA, id: 'other', service: 'mobile' },
        'renamed.yaml': { ...CAPTCHA, id: 'not-renamed' },
        '_draft.yaml': { ...CAPTCHA, id: '_draft' },
      },
    });
    const r = port.features();
    expect(r.features.map((f) => f.id)).toEqual(['captcha']);
    expect(r.errors.map((e) => e.file)).toEqual(['features/broken.yaml', 'features/other.yaml', 'features/renamed.yaml']);
    expect(r.errors[1]?.message).toBe('нет сервиса mobile в monitor.yaml');
    expect(r.errors[2]?.message).toBe('id not-renamed не совпадает с именем файла renamed');

    // Правка файла видна без перезапуска: подпись папки - имена и время изменения файлов.
    writeFileSync(join(features, 'captcha.yaml'), stringify({ ...CAPTCHA, title: 'Капча, новая' }));
    utimesSync(join(features, 'captcha.yaml'), new Date(), new Date(Date.now() + 5000));
    expect(port.features().features[0]?.title).toBe('Капча, новая');
  });

  it('are checked before saving and saved as written into features/<id>.yaml', async () => {
    const { port, features } = setup({ profiles: {} });
    expect(port.validateFeature('id: x').errors[0]).toMatch(/title/);
    const source = `# Капча\n${stringify(CAPTCHA)}`;
    const { file } = await port.saveFeature(source);
    expect(file).toBe(join(features, 'captcha.yaml'));
    expect(readFileSync(file, 'utf8')).toBe(source);
    await expect(port.saveFeature(stringify({ ...CAPTCHA, service: 'nope' }))).rejects.toThrow('нет сервиса nope в monitor.yaml');
  });
});

describe('feature funnels', () => {
  it('keep the daily totals in the base: 16 days by the rules of the profile in the team time zone, today marked, older days kept', async () => {
    const { service, store, logs, setNow } = setup();
    await service.refresh();
    const [r] = logs.requests;
    expect(r).toMatchObject({ kind: 'daily', timeZone: TZ, from: Date.UTC(2026, 8, 13, 21), to: Date.UTC(2026, 8, 30, 21) });
    if (r?.kind !== 'daily') throw new Error('daily');
    expect(Object.keys(r.rules)).toEqual(['baseline', 'entered', 'shown', 'passed', 'test', 'rejected']);
    expect(store.featureDays('captcha')).toEqual([
      { day: '2026-09-28', counts: { baseline: 1, entered: 0, shown: 0, passed: 0, test: 0, rejected: 0 }, note: null },
      { day: '2026-09-30', counts: { baseline: 1, entered: 4, shown: 5, passed: 2, test: 1, rejected: 1 }, note: 'до 12:30' },
    ]);
    expect(service.list().features[0]).toMatchObject({ refreshedAt: NOW, error: null, days: [{ day: '2026-09-28' }, { day: '2026-09-30' }] });

    // Через три недели индекс дней сентября уже не хранит, а база их помнит; у прошедшего дня пометка снимается.
    const next = setup({ logs: clusterOf({ lines: [kc(Date.UTC(2026, 9, 20, 9), 'Проверка антифрода RBA для state = new001')] }) });
    next.store.saveFeatureDays('captcha', store.featureDays('captcha'));
    next.setNow(Date.UTC(2026, 9, 20, 10));
    await next.service.refresh('captcha');
    expect(next.store.featureDays('captcha').map((d) => [d.day, d.note])).toEqual([
      ['2026-09-28', null],
      ['2026-09-30', 'до 12:30'],
      ['2026-10-20', 'до 13:00'],
    ]);
    setNow(NOW + HOUR);
    await service.refresh();
    expect(store.featureDays('captcha').at(-1)?.note).toBe('до 13:30');
  });

  it('count the window by sessions from its lines, follow the step by traces and the login by sessions', async () => {
    const { service, logs } = setup();
    const dto = await service.stats('captcha', '2026-09-30', '2026-09-30');
    expect(dto.window).toEqual({ from: '2026-09-30', to: '2026-09-30', toPartial: true });
    expect(dto.truncated).toBe(false);
    const s = dto.stats;
    expect(s.funnel.map((f) => [f.key, f.sessions, f.sessionsNormal])).toEqual([
      ['entered', 4, 3],
      ['shown', 3, 2],
      ['passed', 2, 1],
      ['test', 1, 1],
    ]);
    expect(s.automation).toMatchObject({ count: 1, shownLines: 3, successLines: 1 });
    expect(s.errors).toEqual({ rejected: 1 });
    expect(s.downstream).toMatchObject({ total: 2, counts: { code_sent: 1, brute_block: 1 } });
    expect(s.login).toMatchObject({ fromSessions: 2, reached: 1, reachedNormal: 1, reachedAutomation: 0 });
    expect(s.timing).toMatchObject({ n: 1, median: 7 });

    const docs = logs.requests.filter((r) => r.kind === 'docs');
    // Окно - сутки по Москве; хвосты - с запасом в 6 часов назад и до текущего момента.
    expect(docs[0]).toMatchObject({ from: Date.UTC(2026, 8, 29, 21), to: Date.UTC(2026, 8, 30, 9, 30) });
    expect(docs[1]?.filter.terms).toEqual([{ field: 'mdc.traceId.keyword', values: ['tr-1', 'tr-3'] }]);
    expect(docs[1]).toMatchObject({ from: Date.UTC(2026, 8, 29, 15), to: NOW });
    expect(docs[2]?.filter.anyOf).toEqual([['www.example.com/auth/event'], ['sess01', 'sess03']]);
  });

  it('split a window the search cannot return at once and mark it truncated when even half an hour does not fit', async () => {
    const split = setup({ logs: clusterOf({ maxMs: 4 * HOUR }) });
    const dto = await split.service.stats('captcha', '2026-09-30', '2026-09-30');
    expect(dto.truncated).toBe(false);
    expect(dto.stats.funnel[0]?.sessions).toBe(4);
    const windows = split.logs.requests.filter((r) => r.kind === 'docs' && !r.filter.terms && r.filter.anyOf.length === 1);
    expect(windows.length).toBeGreaterThan(1);

    const tiny = setup({ logs: clusterOf({ maxMs: 0 }) });
    expect((await tiny.service.stats('captcha', '2026-09-30', '2026-09-30')).truncated).toBe(true);
  });

  it('remember a counted window for 10 minutes and refuse windows that are not days, go backwards or outlast the index', async () => {
    const { service, logs, setNow } = setup();
    await service.stats('captcha', '2026-09-30', '2026-09-30');
    const asked = logs.requests.length;
    await service.stats('captcha', '2026-09-30', '2026-09-30');
    expect(logs.requests.length).toBe(asked);
    setNow(NOW + 11 * MINUTE);
    await service.stats('captcha', '2026-09-30', '2026-09-30');
    expect(logs.requests.length).toBeGreaterThan(asked);

    await expect(service.stats('captcha', '30.09.2026')).rejects.toThrow('Дни окна - вида 2026-09-24');
    await expect(service.stats('captcha', '2026-09-30', '2026-09-20')).rejects.toThrow('Начало окна позже его конца');
    await expect(service.stats('captcha', '2026-08-01', '2026-09-30')).rejects.toThrow('Окно не длиннее 16 дней');
    await expect(service.stats('nope')).rejects.toThrow('Фичи nope нет');
  });

  it('show a failed refresh on the overview and keep the days of the base', async () => {
    const { service, store } = setup({ logs: clusterOf({ fail: 'search_phase_execution_exception' }) });
    store.saveFeatureDays('captcha', [{ day: '2026-09-29', counts: { baseline: 5 }, note: null }]);
    await service.refresh();
    expect(service.list().features[0]).toMatchObject({ error: 'search_phase_execution_exception', days: [{ day: '2026-09-29' }] });
  });

  it('import only the days of the skill history that the base does not have yet', () => {
    const { service, store } = setup();
    store.saveFeatureDays('captcha', [{ day: '2026-09-30', counts: { baseline: 7 }, note: 'до 12:30' }]);
    const added = service.importDays('captcha', [
      { day: '2026-09-09', counts: { baseline: 3, entered: 1 }, note: 'с 11:11' },
      { day: '2026-09-30', counts: { baseline: 1 }, note: 'до 10:00' },
    ]);
    expect(added).toBe(1);
    expect(store.featureDays('captcha')).toEqual([
      { day: '2026-09-09', counts: { baseline: 3, entered: 1 }, note: 'с 11:11' },
      { day: '2026-09-30', counts: { baseline: 7 }, note: 'до 12:30' },
    ]);
    expect(() => service.importDays('nope', [])).toThrow('Фичи nope нет');
  });
});
