import { describe, expect, it } from 'vitest';
import { filterOf, monitorServiceSchema, type LogRequest } from '@task-pilot/step-kit';
import { createEsLogs, esLogsLive, fieldAt, intervalOf, queryOf, sampleOf, searchOf } from '../src/integrations/es-logs.ts';

const KC = monitorServiceSchema.parse({
  id: 'keycloak',
  title: 'Keycloak',
  index: 'cloud-k8s-log-*',
  container: 'gate',
  fields: { message: 'message', level: 'level', logger: 'loggerName.keyword', version: 'container.image.name.keyword', pod: 'kubernetes.pod.name.keyword', trace: 'mdc.traceId.keyword' },
});
const OA = monitorServiceSchema.parse({
  id: 'adapter',
  title: 'Адаптер',
  index: 'fluentbit-*',
  container: 'adapter',
  fields: { message: 'messagetext', level: 'level.keyword', logger: 'logger.keyword', version: 'kubernetes.app.version.keyword', pod: 'kubernetes.pod.name.keyword' },
  ids: ['flowState.keyword'],
});

const FROM = 1_000_000;
const TO = 1_060_000;
const count = (over: Partial<Extract<LogRequest, { kind: 'count' }>> = {}): LogRequest => ({ kind: 'count', service: KC, filter: filterOf({ match: ['RBA'] }), from: FROM, to: TO, ...over });

/** Поддельный кластер: запоминает тела _msearch и отвечает по очереди из ответов. */
function cluster(reply: (searches: { index: string; body: Record<string, unknown> }[]) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string>; searches: { index: string; body: Record<string, unknown> }[] }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const lines = String(init.body).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const searches = [];
    for (let i = 0; i < lines.length; i += 2) searches.push({ index: String(lines[i]!.index), body: lines[i + 1]! });
    calls.push({ url, headers: init.headers as Record<string, string>, searches });
    return reply(searches);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (responses: unknown[], took = 12) => new Response(JSON.stringify({ took, responses }), { status: 200 });
const countOf = (n: number) => ({ status: 200, aggregations: { n: { value: n } } });

describe('es-prod logs', () => {
  it('filters by the exact container, the time range in epoch millis, phrases, "any" groups, exclusions and levels', () => {
    const q = queryOf(OA, { match: ['a'], anyOf: [['b', 'c']], not: ['d'], level: ['WARN'] }, FROM, TO);
    expect(q).toEqual({
      bool: {
        filter: [
          { term: { 'kubernetes.container.name.keyword': 'adapter' } },
          { range: { '@timestamp': { gte: FROM, lt: TO, format: 'epoch_millis' } } },
          { match_phrase: { messagetext: 'a' } },
          { bool: { should: [{ match_phrase: { messagetext: 'b' } }, { match_phrase: { messagetext: 'c' } }], minimum_should_match: 1 } },
          { terms: { 'level.keyword': ['WARN'] } },
        ],
        must_not: [{ match_phrase: { messagetext: 'd' } }],
      },
    });
  });

  it('filters by the container and time fields the service names, and by the filebeat ones without them', () => {
    const own = monitorServiceSchema.parse({ ...OA, fields: { ...OA.fields, container: 'app.keyword', time: 'ts' } });
    expect((queryOf(own, filterOf({}), FROM, TO) as { bool: { filter: unknown[] } }).bool.filter).toEqual([{ term: { 'app.keyword': 'adapter' } }, { range: { ts: { gte: FROM, lt: TO, format: 'epoch_millis' } } }]);
    const lines = searchOf({ kind: 'lines', service: own, filter: filterOf({}), from: FROM, to: TO, size: 5 }).body;
    expect(lines).toMatchObject({ sort: [{ ts: 'desc' }] });
    expect((lines._source as string[])[0]).toBe('ts');
  });

  it('builds aggregations without documents, extraction by a fixed script with only the prefix from the dashboard, and small line portions', () => {
    expect(intervalOf(60_000)).toBe('1m');
    expect(intervalOf(2 * 3_600_000)).toBe('2h');
    expect(intervalOf(1500)).toBe('1500ms');
    const hist = searchOf({ kind: 'histogram', service: KC, filter: filterOf({}), from: FROM, to: TO, bucketMs: 60_000 }).body;
    expect(hist).toMatchObject({ size: 0, track_total_hits: false, aggs: { h: { date_histogram: { fixed_interval: '1m', min_doc_count: 0, extended_bounds: { min: FROM, max: TO - 1 } } } } });
    const terms = searchOf({ kind: 'terms', service: KC, filter: filterOf({}), from: FROM, to: TO, by: { extract: 'channel = ' }, size: 5 }).body as { runtime_mappings: { extracted: { type: string; script: { params: unknown } } }; aggs: unknown };
    expect(terms.runtime_mappings.extracted.type).toBe('keyword');
    expect(terms.runtime_mappings.extracted.script.params).toEqual({ field: 'message', prefix: 'channel = ' });
    expect(terms.aggs).toEqual({ t: { terms: { field: 'extracted', size: 5 } } });
    expect(searchOf({ kind: 'terms', service: KC, filter: filterOf({}), from: FROM, to: TO, by: 'version', size: 3 }).body).toMatchObject({ aggs: { t: { terms: { field: 'container.image.name.keyword' } } } });
    const lines = searchOf({ kind: 'lines', service: OA, filter: filterOf({}), from: FROM, to: TO, size: 20 }).body;
    expect(lines).toMatchObject({ size: 20, sort: [{ '@timestamp': 'desc' }] });
    expect(lines._source).toEqual(['@timestamp', 'messagetext', 'level', 'logger', 'kubernetes.app.version', 'kubernetes.pod.name', 'flowState']);
    const match = searchOf({
      kind: 'match',
      service: OA,
      filter: filterOf({}),
      from: FROM,
      to: TO,
      values: ['abc', 'def'],
      fields: ['flowState.keyword', 'user_id', 'http_req_cookies'],
      text: true,
      size: 50,
      extra: ['extra.referer', 'context.headers_str'],
    }).body as { size: number; sort: unknown; _source: string[]; query: { bool: { should: unknown[]; minimum_should_match: number } } };
    // Точное значение: списком у полей .keyword и по одному с lenient у прочих (числовых); куки и заголовки не читаются.
    expect(match.query.bool.should).toEqual([
      { match_phrase: { messagetext: 'abc' } },
      { match_phrase: { messagetext: 'def' } },
      { terms: { 'flowState.keyword': ['abc', 'def'] } },
      { match: { user_id: { query: 'abc', lenient: true } } },
      { match: { user_id: { query: 'def', lenient: true } } },
    ]);
    expect(match.query.bool.minimum_should_match).toBe(1);
    expect([match.size, match.sort]).toEqual([50, [{ '@timestamp': 'asc' }]]);
    expect(match._source).toEqual(['@timestamp', 'messagetext', 'level', 'logger', 'kubernetes.app.version', 'kubernetes.pod.name', 'flowState', 'user_id', 'extra.referer']);
    const traces = searchOf({ kind: 'match', service: KC, filter: filterOf({}), from: FROM, to: TO, values: ['t1'], fields: ['mdc.traceId.keyword'], text: false, size: 10 }).body as { query: { bool: { should: unknown[] } } };
    expect(traces.query.bool.should).toEqual([{ terms: { 'mdc.traceId.keyword': ['t1'] } }]);
  });

  it('counts daily totals of every rule in the team time zone and returns window lines from old to new, marked when the search is full', async () => {
    const rules = { baseline: filterOf({ any: ['RBA'] }), passed: filterOf({ any: ['Капча для state'], match: ['пройдена'], not: ['непройденной'] }) };
    const daily = searchOf({ kind: 'daily', service: KC, filter: filterOf({}), rules, timeZone: 'Europe/Moscow', from: FROM, to: TO }).body as { size: number; aggs: { f: Record<string, unknown> } };
    expect(daily.size).toBe(0);
    expect(daily.aggs.f).toEqual({
      filters: {
        filters: {
          baseline: { bool: { filter: [{ bool: { should: [{ match_phrase: { message: 'RBA' } }], minimum_should_match: 1 } }] } },
          passed: {
            bool: {
              filter: [{ match_phrase: { message: 'пройдена' } }, { bool: { should: [{ match_phrase: { message: 'Капча для state' } }], minimum_should_match: 1 } }],
              must_not: [{ match_phrase: { message: 'непройденной' } }],
            },
          },
        },
      },
      aggs: { d: { date_histogram: { field: '@timestamp', calendar_interval: '1d', time_zone: 'Europe/Moscow', format: 'yyyy-MM-dd', min_doc_count: 0 } } },
    });
    const traces = { ...filterOf({ any: ['Код отправлен'] }), terms: [{ field: 'mdc.traceId.keyword', values: ['t1', 't2'] }] };
    const docs = searchOf({ kind: 'docs', service: KC, filter: traces, from: FROM, to: TO, size: 50_000 }).body as { size: number; track_total_hits: number; sort: unknown; query: { bool: { filter: unknown[] } } };
    expect([docs.size, docs.track_total_hits, docs.sort]).toEqual([10_000, 10_000, [{ '@timestamp': 'asc' }]]);
    expect(docs.query.bool.filter.at(-1)).toEqual({ terms: { 'mdc.traceId.keyword': ['t1', 't2'] } });

    const c = cluster(() =>
      ok([
        { status: 200, aggregations: { f: { buckets: { baseline: { d: { buckets: [{ key_as_string: '2026-09-30', doc_count: 12 }] } }, passed: { d: { buckets: [{ key_as_string: '2026-09-30', doc_count: 3 }] } } } } } },
        { status: 200, hits: { total: { value: 2 }, hits: [{ sort: [FROM + 1], _source: { message: 'Код отправлен', mdc: { traceId: 't1' } } }, { sort: [FROM + 2], _source: { message: 'Код отправлен', mdc: { traceId: 't2' } } }] } },
        { status: 200, hits: { total: { value: 2 }, hits: [{ sort: [FROM + 1], _source: { message: 'a' } }, { sort: [FROM + 2], _source: { message: 'b' } }] } },
      ]),
    );
    const logs = createEsLogs({ url: 'http://es', apiKey: 'k', fetch: c.fetch });
    const [d, all, full] = await logs.run([
      { kind: 'daily', service: KC, filter: filterOf({}), rules, timeZone: 'Europe/Moscow', from: FROM, to: TO },
      { kind: 'docs', service: KC, filter: traces, from: FROM, to: TO, size: 10 },
      { kind: 'docs', service: KC, filter: filterOf({}), from: FROM, to: TO, size: 2 },
    ]);
    expect(d).toEqual({ kind: 'daily', days: { '2026-09-30': { baseline: 12, passed: 3 } } });
    expect(all).toMatchObject({ kind: 'docs', capped: false, lines: [{ t: FROM + 1, trace: 't1' }, { t: FROM + 2, trace: 't2' }] });
    expect(full).toMatchObject({ kind: 'docs', capped: true });
  });

  it('reads fields from nested and from dotted source keys', () => {
    expect(fieldAt({ kubernetes: { pod: { name: 'p1' } } }, 'kubernetes.pod.name')).toBe('p1');
    expect(fieldAt({ 'kubernetes.pod.name': 'p2' }, 'kubernetes.pod.name')).toBe('p2');
    expect(fieldAt({ mdc: { traceId: 't' } }, 'mdc.traceId')).toBe('t');
    expect(fieldAt({ a: 1 }, 'b.c')).toBeUndefined();
  });

  it('sends one _msearch with the read-only key and parses every kind of answer', async () => {
    const c = cluster(() =>
      ok([
        countOf(214),
        { status: 200, aggregations: { h: { buckets: [{ key: FROM - 60_000, doc_count: 9 }, { key: FROM, doc_count: 3 }] } } },
        { status: 200, aggregations: { v: { buckets: [{ key: 'reg/gate:1.0.273-master', doc_count: 5, first: { value: FROM + 1 }, last: { value: TO - 1 } }] } } },
        { status: 200, hits: { hits: [{ sort: [FROM + 5], _source: { messagetext: 'x'.repeat(5000), level: 'INFO', 'kubernetes.pod.name': 'oa-1', 'kubernetes.app.version': '1.0.24-master', flowState: 'f-1' } }] } },
      ]),
    );
    const logs = createEsLogs({ url: 'http://es:9200/', apiKey: 'secret-key', fetch: c.fetch });
    const [n, h, v, l] = await logs.run([
      count(),
      { kind: 'histogram', service: KC, filter: filterOf({}), from: FROM, to: TO, bucketMs: 60_000 },
      { kind: 'versions', service: KC, filter: filterOf({}), from: FROM, to: TO },
      { kind: 'lines', service: OA, filter: filterOf({}), from: FROM, to: TO, size: 1 },
    ]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.url).toBe('http://es:9200/_msearch');
    expect(c.calls[0]!.headers.authorization).toBe('ApiKey secret-key');
    expect(c.calls[0]!.searches.map((s) => s.index)).toEqual(['cloud-k8s-log-*', 'cloud-k8s-log-*', 'cloud-k8s-log-*', 'fluentbit-*']);
    expect(n).toEqual({ kind: 'count', count: 214 });
    // Корзина до начала окна отбрасывается: Elasticsearch выравнивает корзины по своей сетке.
    expect(h).toEqual({ kind: 'histogram', buckets: [{ t: FROM, n: 3 }] });
    expect(v).toEqual({ kind: 'versions', versions: [{ key: 'reg/gate:1.0.273-master', first: FROM + 1, last: TO - 1, n: 5 }] });
    expect(l).toMatchObject({ kind: 'lines', lines: [{ service: 'adapter', t: FROM + 5, pod: 'oa-1', version: '1.0.24-master', ids: { 'flowState.keyword': 'f-1' } }] });
    if (l?.kind !== 'lines') throw new Error('lines');
    expect(l.lines[0]!.message).toMatch(/\.\.\. \(еще 1000 символов\)$/);
  });

  it('answers the same search from the cache until it expires and joins a search that is already running', async () => {
    let t = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = cluster(async (searches) => {
      await gate;
      return ok(searches.map(() => countOf(7)));
    });
    const logs = createEsLogs({ url: 'http://es', apiKey: 'k', fetch: c.fetch, now: () => t, cacheMs: 15_000 });
    const first = logs.run([count()]);
    const second = logs.run([count()]);
    release();
    expect(await Promise.all([first, second])).toEqual([[{ kind: 'count', count: 7 }], [{ kind: 'count', count: 7 }]]);
    expect(c.calls).toHaveLength(1);
    t = 10_000;
    await logs.run([count()]);
    expect(c.calls).toHaveLength(1);
    t = 16_000;
    await logs.run([count()]);
    expect(c.calls).toHaveLength(2);
    // Свой срок у запроса: базовая линия живет в кэше час.
    await logs.run([count({ cacheMs: 3_600_000, from: FROM - 1 })]);
    expect(logs.stats()).toMatchObject({ calls: 3, searches: 3, cached: 2, errors: 0, avgTookMs: 12 });
    t = 16_000 + 30 * 60_000;
    await logs.run([count({ cacheMs: 3_600_000, from: FROM - 1 })]);
    expect(c.calls).toHaveLength(3);
    // Нагрузка считается за последние пять минут: старые запросы из нее ушли, остался ответ из кэша.
    expect(logs.stats()).toMatchObject({ calls: 0, searches: 0, cached: 1, avgTookMs: null });
  });

  it('turns a failed search into its own error, retries 429 once and does not cache errors', async () => {
    const statuses = [429, 200, 500, 200];
    const c = cluster((searches) => {
      const status = statuses.shift()!;
      if (status !== 200) return new Response('busy', { status });
      return ok([{ status: 400, error: { root_cause: [{ type: 'script_exception', reason: 'compile error' }] } }, ...searches.slice(1).map(() => countOf(1))]);
    });
    const logs = createEsLogs({ url: 'http://es', apiKey: 'k', fetch: c.fetch, retryDelayMs: 1 });
    expect(await logs.run([count(), count({ from: FROM + 60_000 })])).toEqual([
      { kind: 'error', message: 'script_exception: compile error' },
      { kind: 'count', count: 1 },
    ]);
    expect(c.calls).toHaveLength(2);
    const failed = await logs.run([count({ from: FROM - 60_000 })]);
    expect(failed[0]).toMatchObject({ kind: 'error', message: expect.stringContaining('Кластер логов ответил 500') });
    expect(await logs.run([count({ from: FROM - 60_000 })])).toEqual([{ kind: 'error', message: 'script_exception: compile error' }]);
    expect(logs.stats()).toMatchObject({ errors: 1, lastError: 'script_exception: compile error' });
  });

  it('extracts text over a stable random sample of about 2000 lines once the filter matches many, and over all lines otherwise', async () => {
    expect([sampleOf(20_000), sampleOf(3000), sampleOf(0)]).toEqual([0.1, 1, 1]);
    const numbers = (from: number): LogRequest => ({ kind: 'numbers', service: KC, filter: filterOf({ match: ['RBA'] }), from, to: TO, extract: 'score = ', interval: 10 });
    const c = cluster((searches) =>
      ok(
        searches.map((x) => {
          if ((x.body.aggs as Record<string, unknown>).n) return countOf(x.body.query && JSON.stringify(x.body.query).includes(String(FROM - 1)) ? 500 : 20_000);
          const aggs = x.body.aggs as { s?: unknown; h?: unknown };
          const buckets = [{ key: 0, doc_count: 10_000 }, { key: 30, doc_count: 1_000 }];
          return { status: 200, aggregations: aggs.s ? { s: { h: { buckets } } } : { h: { buckets } } };
        }),
      ),
    );
    const logs = createEsLogs({ url: 'http://es', apiKey: 'k', fetch: c.fetch });
    const [big] = await logs.run([numbers(FROM)]);
    expect(big).toEqual({ kind: 'numbers', buckets: [{ x: 0, n: 10_000 }, { x: 30, n: 1_000 }], sample: 0.1 });
    expect(c.calls[1]!.searches[0]!.body.aggs).toMatchObject({ s: { random_sampler: { probability: 0.1, seed: 42 } } });
    const [small] = await logs.run([numbers(FROM - 1)]);
    expect(small).toEqual({ kind: 'numbers', buckets: [{ x: 0, n: 10_000 }, { x: 30, n: 1_000 }] });
    expect(c.calls[3]!.searches[0]!.body.aggs).toMatchObject({ h: { histogram: { field: 'extracted' } } });
  });

  it('reports an unreachable cluster as an error of every search and splits many searches into batches', async () => {
    const down = createEsLogs({
      url: 'http://es',
      apiKey: 'k',
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      expect(await down.run([count()])).toEqual([{ kind: 'error', message: 'Кластер логов недоступен: connect ECONNREFUSED' }]);
    } finally {
      console.error = originalError;
    }
    const c = cluster((searches) => ok(searches.map((_, i) => countOf(i))));
    const logs = createEsLogs({ url: 'http://es', apiKey: 'k', fetch: c.fetch, batch: 10 });
    const results = await logs.run(Array.from({ length: 12 }, (_, i) => count({ from: FROM + i })));
    expect(c.calls.map((x) => x.searches.length)).toEqual([10, 2]);
    expect(results.map((r) => (r.kind === 'count' ? r.count : -1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
  });

  it('recreates the client when the key of the prod logs source changes on the integrations screen', async () => {
    const c = cluster(() => ok([countOf(5)]));
    const profile = { source: { id: 'es-prod', mcp: 'elasticsearch' }, services: [KC], timeZone: 'UTC' };
    let servers: Record<string, { env: Record<string, string> }> = {};
    const logs = esLogsLive(profile, () => servers, c.fetch);
    expect(await logs.run([count()])).toEqual([{ kind: 'error', message: expect.stringContaining('нет ES_URL и ES_API_KEY') }]);
    expect(logs.stats().lastError).toContain('нет ES_URL и ES_API_KEY');
    servers = { elasticsearch: { env: { ES_URL: 'http://es.example.org:9200', ES_API_KEY: 'first-key' } } };
    expect(await logs.run([count()])).toEqual([{ kind: 'count', count: 5 }]);
    // Тот же доступ новым объектом: клиент прежний, ответ из его кэша.
    servers = { elasticsearch: { env: { ES_URL: 'http://es.example.org:9200', ES_API_KEY: 'first-key' } } };
    await logs.run([count()]);
    servers = { elasticsearch: { env: { ES_URL: 'http://es.example.org:9200', ES_API_KEY: 'second-key' } } };
    await logs.run([count()]);
    expect(c.calls.map((call) => call.headers.authorization)).toEqual(['ApiKey first-key', 'ApiKey second-key']);
  });
});
