import { describe, expect, it } from 'vitest';
import {
  alertText,
  andFilter,
  bucketOf,
  dashboardSchema,
  DAY,
  deploysOf,
  durationMs,
  durationText,
  filterOf,
  headlinePanels,
  HOUR,
  MINUTE,
  monitorProfileSchema,
  planAlert,
  planHeadline,
  planPanel,
  rangeOf,
  unknownServices,
  type Dashboard,
  type LogResult,
  type MonitorServiceProfile,
} from '../src/index.ts';

const KC: MonitorServiceProfile = monitorProfileSchema.parse({
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
}).services[0]!;

const dashboard = (over: Record<string, unknown> = {}): Dashboard =>
  dashboardSchema.parse({
    id: 'rba',
    title: 'RBA',
    task: 'TEAM-2609',
    service: 'keycloak',
    panels: [
      { id: 'success', title: 'Успешные проверки', type: 'timeseries', match: ['Проверка антифрода RBA', 'status = success'] },
      { id: 'failopen', title: 'Fail-open', type: 'share', part: { any: ['RBA: код ответа', 'RBA: ошибка вызова'] }, of: { any: ['Проверка антифрода RBA', 'RBA: код ответа', 'RBA: ошибка вызова'] } },
      { id: 'channel', title: 'Каналы', type: 'top', match: ['status = success'], by: { extract: 'channel = ' } },
      { id: 'score', title: 'Score', type: 'numbers', match: ['status = success'], extract: 'score = ', interval: 10 },
    ],
    alerts: [
      { id: 'no-success', panel: 'success', when: 'zero', window: '15m' },
      { id: 'failopen-high', panel: 'failopen', when: 'above', value: 0.05 },
      { id: 'success-spike', panel: 'success', when: 'spike', window: '1h', baseline: '1d', factor: 2, min: 10 },
    ],
    ...over,
  });

const NOW = Date.UTC(2026, 8, 23, 17, 30, 20);

describe('monitor model', () => {
  it('parses durations and picks about a hundred buckets per period, not finer than a minute', () => {
    expect([durationMs('30s'), durationMs('15m'), durationMs('1h'), durationMs('7d')]).toEqual([30_000, 15 * MINUTE, HOUR, 7 * DAY]);
    expect(() => durationMs('15 min')).toThrow('Некорректная длительность');
    expect([bucketOf(15 * MINUTE), bucketOf(HOUR), bucketOf(6 * HOUR), bucketOf(DAY), bucketOf(7 * DAY)]).toEqual([MINUTE, MINUTE, 5 * MINUTE, 15 * MINUTE, 2 * HOUR]);
  });

  it('ends a range on the next minute and aligns its start to buckets, so polls within a minute send the same request', () => {
    const a = rangeOf(NOW, DAY);
    const b = rangeOf(NOW + 25_000, DAY);
    expect(a).toEqual(b);
    expect(a.to).toBe(Date.UTC(2026, 8, 23, 17, 31));
    expect(a.from % (15 * MINUTE)).toBe(0);
    expect(a.to - a.from).toBeGreaterThanOrEqual(DAY);
  });

  it('rejects duplicate panels, alerts on panels without a number, an empty share base and a wrong headline', () => {
    expect(() => dashboard({ panels: [dashboard().panels[0], dashboard().panels[0]], alerts: [] })).toThrow('описана дважды');
    expect(() => dashboard({ alerts: [{ id: 'x', panel: 'score', when: 'zero' }] })).toThrow('только по панелям');
    expect(() => dashboard({ alerts: [{ id: 'x', panel: 'nope', when: 'zero' }] })).toThrow('нет панели nope');
    expect(() => dashboard({ panels: [{ id: 's', title: 'S', type: 'share', part: { match: ['a'] }, of: {} }], alerts: [] })).toThrow('нужен отбор строк of');
    expect(() => dashboard({ headline: ['channel'] })).toThrow('на обзоре только панели с числом');
    expect(unknownServices(dashboard({ panels: [{ id: 'm', title: 'M', type: 'stat', service: 'mobile' }], alerts: [] }), [KC])).toEqual(['mobile']);
  });

  it('joins filters: phrases add up, "any" groups stay separate and levels intersect', () => {
    const f = andFilter(filterOf({ match: ['a'], any: ['b', 'c'], level: ['WARN', 'ERROR'] }), filterOf({ any: ['d'], not: ['e'], level: ['ERROR'] }));
    expect(f).toEqual({ match: ['a'], anyOf: [['b', 'c'], ['d']], not: ['e'], level: ['ERROR'] });
    expect(andFilter(filterOf({ level: ['INFO'] }), filterOf({ level: ['WARN'] })).level).toEqual(['-']);
  });

  it('plans a series per split and reads totals from the buckets', () => {
    const d = dashboard({
      panels: [{ id: 'checks', title: 'Проверки', type: 'timeseries', match: ['Фрод-проверка'], split: [{ label: 'без clientData', match: ['noClientData=true'] }, { label: 'с clientData', match: ['noClientData=false'] }] }],
      alerts: [],
    });
    const plan = planPanel(d, d.panels[0]!, [KC], rangeOf(NOW, HOUR));
    expect(plan.requests.map((r) => r.kind === 'histogram' && [r.filter.match, r.bucketMs])).toEqual([
      [['Фрод-проверка', 'noClientData=true'], MINUTE],
      [['Фрод-проверка', 'noClientData=false'], MINUTE],
    ]);
    const v = plan.value([
      { kind: 'histogram', buckets: [{ t: 1, n: 2 }, { t: 2, n: 3 }] },
      { kind: 'histogram', buckets: [{ t: 1, n: 0 }, { t: 2, n: 1 }] },
    ]);
    expect(v).toEqual({
      type: 'timeseries',
      series: [
        { label: 'без clientData', total: 5, points: [{ t: 1, n: 2 }, { t: 2, n: 3 }] },
        { label: 'с clientData', total: 1, points: [{ t: 1, n: 0 }, { t: 2, n: 1 }] },
      ],
    });
  });

  it('counts a stat against the previous period of the same length', () => {
    const d = dashboard({ panels: [{ id: 'marked', title: 'Помечено', type: 'stat', match: ['помечен как фрод'] }], alerts: [] });
    const range = rangeOf(NOW, DAY);
    const plan = planPanel(d, d.panels[0]!, [KC], range);
    const [now, before] = plan.requests;
    expect([now!.from, now!.to, before!.from, before!.to]).toEqual([range.from, range.to, range.from - (range.to - range.from), range.from]);
    expect(plan.value([{ kind: 'count', count: 31 }, { kind: 'count', count: 20 }])).toEqual({ type: 'stat', value: 31, previous: 20 });
  });

  it('computes a share per bucket and in total, without dividing by an empty base', () => {
    const d = dashboard();
    const plan = planPanel(d, d.panels[1]!, [KC], rangeOf(NOW, HOUR));
    expect(plan.requests.map((r) => r.filter.anyOf)).toEqual([[['RBA: код ответа', 'RBA: ошибка вызова']], [['Проверка антифрода RBA', 'RBA: код ответа', 'RBA: ошибка вызова']]]);
    const v = plan.value([
      { kind: 'histogram', buckets: [{ t: 1, n: 1 }, { t: 2, n: 0 }] },
      { kind: 'histogram', buckets: [{ t: 1, n: 4 }, { t: 2, n: 0 }] },
    ]);
    expect(v).toEqual({ type: 'share', part: 1, of: 4, ratio: 0.25, points: [{ t: 1, part: 1, of: 4, ratio: 0.25 }, { t: 2, part: 0, of: 0, ratio: null }] });
  });

  it('caches text extraction longer and turns a source error into a panel error', () => {
    const d = dashboard();
    const top = planPanel(d, d.panels[2]!, [KC], rangeOf(NOW, HOUR));
    const numbers = planPanel(d, d.panels[3]!, [KC], rangeOf(NOW, HOUR));
    expect([top.requests[0]!.cacheMs, numbers.requests[0]!.cacheMs]).toEqual([5 * MINUTE, 5 * MINUTE]);
    expect(top.value([{ kind: 'terms', terms: [{ key: 'web', n: 10 }], other: 2 }])).toEqual({ type: 'top', items: [{ key: 'web', n: 10 }], other: 2 });
    expect(numbers.value([{ kind: 'error', message: 'HTTP 429' }])).toEqual({ type: 'error', message: 'HTTP 429' });
  });

  it('shows the first two panels with a number on the overview, a share as a ratio for the hour and the day', () => {
    const d = dashboard();
    expect(headlinePanels(d).map((p) => p.id)).toEqual(['success', 'failopen']);
    const h = planHeadline(d, d.panels[1]!, [KC], NOW);
    expect(h.requests.map((r) => r.kind)).toEqual(['count', 'histogram', 'count', 'histogram']);
    const day = h.requests[1]!;
    // Первая корзина начинается раньше суток назад (начало выровнено по часу) и в цифры за сутки не входит.
    const [old, t1, t2] = [day.from, day.to - 2 * HOUR, day.to - HOUR];
    const results: LogResult[] = [
      { kind: 'count', count: 1 },
      { kind: 'histogram', buckets: [{ t: old, n: 50 }, { t: t1, n: 2 }, { t: t2, n: 1 }] },
      { kind: 'count', count: 50 },
      { kind: 'histogram', buckets: [{ t: old, n: 50 }, { t: t1, n: 100 }, { t: t2, n: 0 }] },
    ];
    expect(day.to - day.from).toBeGreaterThan(DAY);
    expect(h.value(results)).toMatchObject({ kind: 'ratio', hour: 0.02, day: 0.03, spark: [0.02, null] });
  });

  it('fires "zero" on an empty window and decides "above" only with enough lines', () => {
    const d = dashboard();
    const zero = planAlert(d, d.alerts[0]!, [KC], NOW);
    expect(zero.outcome([{ kind: 'count', count: 0 }])).toMatchObject({ state: 'firing', value: 0 });
    expect(zero.outcome([{ kind: 'count', count: 3 }])).toMatchObject({ state: 'ok' });
    const above = planAlert(d, d.alerts[1]!, [KC], NOW);
    expect(above.outcome([{ kind: 'count', count: 2 }, { kind: 'count', count: 10 }])).toMatchObject({ state: 'nodata', value: 0.2 });
    expect(above.outcome([{ kind: 'count', count: 2 }, { kind: 'count', count: 100 }])).toMatchObject({ state: 'ok', value: 0.02 });
    expect(above.outcome([{ kind: 'count', count: 9 }, { kind: 'count', count: 100 }])).toMatchObject({ state: 'firing', value: 0.09, threshold: 0.05 });
    expect(above.outcome([{ kind: 'error', message: 'timeout' }])).toMatchObject({ state: 'nodata', text: expect.stringContaining('timeout') });
    // У числа строк минимума нет: "больше 0" срабатывает на первой же строке.
    const any = planAlert(d, { id: 'any', panel: 'success', when: 'above', value: 0, window: '15m', min: 20 }, [KC], NOW);
    expect(any.outcome([{ kind: 'count', count: 1 }])).toMatchObject({ state: 'firing', value: 1, threshold: 0 });
    expect(any.outcome([{ kind: 'count', count: 0 }])).toMatchObject({ state: 'ok' });
  });

  it('compares a spike with the mean of the baseline in windows of the alert and caches the baseline for an hour', () => {
    const d = dashboard();
    const spike = planAlert(d, d.alerts[2]!, [KC], NOW);
    const [win, baseline] = spike.requests;
    expect(win!.to - win!.from).toBe(HOUR);
    expect(baseline).toMatchObject({ kind: 'histogram', bucketMs: HOUR, cacheMs: HOUR });
    expect(baseline!.to).toBeLessThanOrEqual(win!.from);
    const buckets = [{ t: 1, n: 10 }, { t: 2, n: 30 }];
    expect(spike.outcome([{ kind: 'count', count: 41 }, { kind: 'histogram', buckets }])).toMatchObject({ state: 'firing', threshold: 40 });
    expect(spike.outcome([{ kind: 'count', count: 39 }, { kind: 'histogram', buckets }])).toMatchObject({ state: 'ok' });
    expect(spike.outcome([{ kind: 'count', count: 5 }, { kind: 'histogram', buckets: [{ t: 1, n: 1 }] }])).toMatchObject({ state: 'nodata' });
  });

  it('describes alerts in words: durations, a share with a comma, the factor and the baseline', () => {
    const d = dashboard();
    expect(alertText(d.alerts[0]!, d.panels[0]!)).toBe('"Успешные проверки": ни одной строки за 15 мин');
    expect(alertText(d.alerts[1]!, d.panels[1]!)).toBe('"Fail-open" за 15 мин выше 5%');
    expect(alertText({ ...d.alerts[1]!, when: 'above', value: 0.005, min: 20 }, d.panels[1]!)).toBe('"Fail-open" за 15 мин выше 0,5%');
    expect(alertText(d.alerts[2]!, d.panels[0]!)).toBe('"Успешные проверки" за 1 ч в 2 раза выше средней за 1 дн');
    expect([durationText('30s'), durationText('7d'), durationText('soon')]).toEqual(['30 с', '7 дн', 'soon']);
  });

  it('marks as deploys only versions whose first line falls into the window, not the one that was already running', () => {
    const range = { from: 1000, to: 5000 };
    const marks = deploysOf('keycloak', [{ key: 'reg/gate:1.0.273-master', first: 3000 }, { key: 'reg/gate:1.0.269-master', first: 500 }], range);
    expect(marks).toEqual([{ service: 'keycloak', version: '1.0.273-master', at: 3000 }]);
  });
});
