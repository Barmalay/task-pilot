import type { LogFilter, LogLine, LogRequest, LogResult, MonitorLogsPort, MonitorProfile, MonitorServiceProfile, MonitorStats } from '@task-pilot/step-kit';
import { DEFAULT_CONTAINER_FIELD, DEFAULT_TIME_FIELD, FORBIDDEN_FIELD } from '@task-pilot/step-kit';

/** Поле имени контейнера сервиса: точный term по нему дешевле match_phrase по текстовому полю. */
const containerField = (s: MonitorServiceProfile) => s.fields.container ?? DEFAULT_CONTAINER_FIELD;
/** Поле времени записи сервиса. */
const timeField = (s: MonitorServiceProfile) => s.fields.time ?? DEFAULT_TIME_FIELD;
/** Сколько символов строки лога отдавать: HTTP-логи Logbook бывают на сотни килобайт. */
const MESSAGE_LIMIT = 4000;
/** За какое окно считается нагрузка на кластер. */
const STATS_WINDOW = 5 * 60_000;
/**
 * Сколько строк разбирать runtime-полем: больше - по случайной выборке такого размера. Разбор читает _source каждой
 * строки, и сутки строк RBA без выборки стоили кластеру 10 с, а по выборке в 2000 строк - полсекунды.
 */
const SAMPLE_TARGET = 2000;
/** Семя выборки: одна и та же выборка у соседних опросов, график не дрожит. */
const SAMPLE_SEED = 42;
/** Статусы, после которых запрос повторяется один раз. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** Больше строк один поиск не отдает: дальше окно дробится тем, кто спрашивает. */
export const DOCS_LIMIT = 10_000;

/** Настройки клиента кластера логов прода. */
export interface EsLogsOptions {
  /** Адрес кластера (ES_URL). */
  url: string;
  /** Ключ только на чтение (ES_API_KEY): с ним работают _search и _msearch. */
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Сколько HTTP-запросов к кластеру может идти одновременно. */
  concurrency?: number;
  /** Сколько поисков уходит одним _msearch. */
  batch?: number;
  /** Кэш ответа по умолчанию: одинаковые запросы разных панелей и вкладок в пределах этого времени идут в кластер один раз. */
  cacheMs?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

interface Search {
  index: string;
  body: Record<string, unknown>;
}

// Разбор слова и числа из текста строки runtime-полем: шаблоны фиксированы, из дашборда приходит только префикс.
const FIND_PREFIX = `
  def raw = params._source[params.field];
  if (raw == null) return;
  String s = raw.toString();
  int i = s.indexOf(params.prefix);
  if (i < 0) return;
  int j = i + params.prefix.length();
  while (j < s.length() && s.charAt(j) == (char)' ') j++;`;

const EXTRACT_WORD = `${FIND_PREFIX}
  int k = j;
  while (k < s.length() && k - j < 100) {
    char c = s.charAt(k);
    if (Character.isWhitespace(c) || c == (char)',' || c == (char)';' || c == (char)')' || c == (char)']' || c == (char)'}' || c == (char)'"' || c == (char)"'") break;
    k++;
  }
  if (k > j) emit(s.substring(j, k));`;

const EXTRACT_NUMBER = `${FIND_PREFIX}
  int k = j;
  if (k < s.length() && s.charAt(k) == (char)'-') k++;
  while (k < s.length() && (Character.isDigit(s.charAt(k)) || s.charAt(k) == (char)'.')) k++;
  if (k > j) { try { emit(Double.parseDouble(s.substring(j, k))); } catch (NumberFormatException e) {} }`;

/** Путь поля в _source: у агрегируемого подполя .keyword значение лежит в самом поле. */
export function sourcePath(field: string): string {
  return field.endsWith('.keyword') ? field.slice(0, -'.keyword'.length) : field;
}

/**
 * Значение поля по пути: в Keycloak _source вложенный (kubernetes -> pod -> name), а fluentbit кладет ключ целиком
 * ("kubernetes.pod.name"), поэтому на каждом уровне сначала пробуется самый длинный ключ.
 */
export function fieldAt(source: unknown, path: string): unknown {
  const walk = (cur: unknown, parts: string[]): unknown => {
    if (!parts.length) return cur;
    if (!cur || typeof cur !== 'object') return undefined;
    const obj = cur as Record<string, unknown>;
    for (let n = parts.length; n > 0; n--) {
      const key = parts.slice(0, n).join('.');
      if (key in obj) {
        const found = walk(obj[key], parts.slice(n));
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(source, path.split('.'));
}

const at = fieldAt;

const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** Шаг гистограммы в единицах Elasticsearch. */
export function intervalOf(ms: number): string {
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/** Условия отбора строк без контейнера и времени: фразы в тексте, уровни и точные значения полей. */
function conditionsOf(s: MonitorServiceProfile, f: LogFilter): { filter: unknown[]; must_not?: unknown[] } {
  const phrase = (p: string) => ({ match_phrase: { [s.fields.message]: p } });
  const filter: unknown[] = [...f.match.map(phrase), ...f.anyOf.map((group) => ({ bool: { should: group.map(phrase), minimum_should_match: 1 } }))];
  if (f.level.length) filter.push({ terms: { [s.fields.level]: f.level } });
  for (const t of f.terms ?? []) filter.push({ terms: { [t.field]: t.values } });
  return { filter, ...(f.not.length ? { must_not: f.not.map(phrase) } : {}) };
}

/** Условие отбора строк сервиса за окно: контейнер, время, фразы в тексте, уровни и точные значения полей. */
export function queryOf(s: MonitorServiceProfile, f: LogFilter, from: number, to: number): Record<string, unknown> {
  const c = conditionsOf(s, f);
  const filter: unknown[] = [{ term: { [containerField(s)]: s.container } }, { range: { [timeField(s)]: { gte: from, lt: to, format: 'epoch_millis' } } }, ...c.filter];
  return { bool: { filter, ...(c.must_not ? { must_not: c.must_not } : {}) } };
}

/** Поля, которые запрос может читать сверх полей сервиса: куки, заголовки, токены и пароли не читаются никогда. */
function allowedFields(fields: string[]): string[] {
  return fields.filter((f) => !FORBIDDEN_FIELD.test(f));
}

function sourceFields(s: MonitorServiceProfile): string[] {
  const f = s.fields;
  return [timeField(s), f.message, f.level, f.logger, f.version, f.pod, ...(f.trace ? [f.trace] : []), ...s.ids].map(sourcePath);
}

/** Запрос разбирает текст строк runtime-полем: такой поиск дорог и идет по выборке. */
export function extracts(r: LogRequest): boolean {
  return r.kind === 'numbers' || (r.kind === 'terms' && typeof r.by === 'object');
}

/** Доля выборки для разбора count строк: 1 - все строки; random_sampler принимает только долю меньше 0.5 или ровно 1. */
export function sampleOf(count: number, target = SAMPLE_TARGET): number {
  const p = target / Math.max(count, 1);
  return p >= 0.5 ? 1 : Math.max(p, 0.0001);
}

/** Агрегация в случайной выборке строк: счетчики внутри кластер сам пересчитывает на все строки. */
function sampled(aggs: Record<string, unknown>, sample: number): Record<string, unknown> {
  return sample < 1 ? { s: { random_sampler: { probability: sample, seed: SAMPLE_SEED }, aggs } } : aggs;
}

/** Поиск Elasticsearch для запроса панели; sample - доля выборки для запросов с разбором текста. */
export function searchOf(r: LogRequest, sample = 1): Search {
  const s = r.service;
  const base = { size: 0, track_total_hits: false };
  switch (r.kind) {
    case 'count':
      return { index: s.index, body: { ...base, query: queryOf(s, r.filter, r.from, r.to), aggs: { n: { value_count: { field: timeField(s) } } } } };
    case 'histogram':
      return {
        index: s.index,
        body: {
          ...base,
          query: queryOf(s, r.filter, r.from, r.to),
          aggs: { h: { date_histogram: { field: timeField(s), fixed_interval: intervalOf(r.bucketMs), min_doc_count: 0, extended_bounds: { min: r.from, max: r.to - 1 } } } },
        },
      };
    case 'terms': {
      const field = typeof r.by === 'object' ? 'extracted' : s.fields[r.by];
      return {
        index: s.index,
        body: {
          ...base,
          ...(typeof r.by === 'object'
            ? { runtime_mappings: { extracted: { type: 'keyword', script: { source: EXTRACT_WORD, params: { field: sourcePath(s.fields.message), prefix: r.by.extract } } } } }
            : {}),
          query: queryOf(s, r.filter, r.from, r.to),
          aggs: sampled({ t: { terms: { field, size: r.size } } }, sample),
        },
      };
    }
    case 'numbers':
      return {
        index: s.index,
        body: {
          ...base,
          runtime_mappings: { extracted: { type: 'double', script: { source: EXTRACT_NUMBER, params: { field: sourcePath(s.fields.message), prefix: r.extract } } } },
          query: queryOf(s, r.filter, r.from, r.to),
          aggs: sampled({ h: { histogram: { field: 'extracted', interval: r.interval, min_doc_count: 0 } } }, sample),
        },
      };
    case 'lines':
      return {
        index: s.index,
        body: { size: r.size, track_total_hits: false, sort: [{ [timeField(s)]: 'desc' }], _source: sourceFields(s), query: queryOf(s, r.filter, r.from, r.to) },
      };
    case 'versions':
      return {
        index: s.index,
        body: {
          ...base,
          query: queryOf(s, r.filter, r.from, r.to),
          aggs: { v: { terms: { field: s.fields.version, size: 20 }, aggs: { first: { min: { field: timeField(s) } }, last: { max: { field: timeField(s) } } } } },
        },
      };
    case 'daily':
      return {
        index: s.index,
        body: {
          ...base,
          query: queryOf(s, r.filter, r.from, r.to),
          aggs: {
            f: {
              filters: { filters: Object.fromEntries(Object.entries(r.rules).map(([k, f]) => [k, { bool: conditionsOf(s, f) }])) },
              aggs: { d: { date_histogram: { field: timeField(s), calendar_interval: '1d', time_zone: r.timeZone, format: 'yyyy-MM-dd', min_doc_count: 0 } } },
            },
          },
        },
      };
    case 'docs':
      return {
        index: s.index,
        body: { size: Math.min(r.size, DOCS_LIMIT), track_total_hits: Math.min(r.size, DOCS_LIMIT), sort: [{ [timeField(s)]: 'asc' }], _source: sourceFields(s), query: queryOf(s, r.filter, r.from, r.to) },
      };
    case 'match': {
      const size = Math.min(r.size, DOCS_LIMIT);
      // Агрегируемые поля (.keyword) сверяются списком сразу; у числовых и прочих полей значение другого вида ошибкой
      // всего поиска не становится (lenient).
      const exact = (f: string): unknown[] => (f.endsWith('.keyword') ? [{ terms: { [f]: r.values } }] : r.values.map((v) => ({ match: { [f]: { query: v, lenient: true } } })));
      const should: unknown[] = [...(r.text ? r.values.map((v) => ({ match_phrase: { [s.fields.message]: v } })) : []), ...allowedFields(r.fields).flatMap(exact)];
      const q = queryOf(s, r.filter, r.from, r.to) as { bool: Record<string, unknown> };
      return {
        index: s.index,
        body: {
          size,
          track_total_hits: size,
          sort: [{ [timeField(s)]: 'asc' }],
          _source: [...new Set([...sourceFields(s), ...allowedFields([...r.fields, ...(r.extra ?? [])]).map(sourcePath)])],
          query: { bool: { ...q.bool, should, minimum_should_match: 1 } },
        },
      };
    }
  }
}

interface Hit {
  _source?: unknown;
  sort?: unknown[];
}

function lineOf(s: MonitorServiceProfile, h: Hit, more: { ids?: string[]; extra?: string[] } = {}): LogLine {
  const src = h._source;
  const f = s.fields;
  const sorted = Number(h.sort?.[0]);
  const message = text(at(src, sourcePath(f.message)));
  const values = (list: string[]) => Object.fromEntries([...new Set(list)].map((id) => [id, text(at(src, sourcePath(id)))]).filter(([, v]) => v));
  const ids = values([...s.ids, ...(more.ids ?? [])]);
  const extra = values(more.extra ?? []);
  return {
    service: s.id,
    t: Number.isFinite(sorted) ? sorted : Date.parse(text(at(src, timeField(s)))),
    level: text(at(src, sourcePath(f.level))),
    logger: text(at(src, sourcePath(f.logger))),
    message: message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)} ... (еще ${message.length - MESSAGE_LIMIT} символов)` : message,
    pod: text(at(src, sourcePath(f.pod))),
    version: text(at(src, sourcePath(f.version))).split(':').pop() ?? '',
    ...(f.trace && text(at(src, sourcePath(f.trace))) ? { trace: text(at(src, sourcePath(f.trace))) } : {}),
    ...(Object.keys(ids).length ? { ids } : {}),
    ...(Object.keys(extra).length ? { fields: extra } : {}),
  };
}

interface Bucket {
  key?: unknown;
  doc_count?: number;
  first?: { value?: number | null };
  last?: { value?: number | null };
}

/** Ответ поиска Elasticsearch в ответ панели; у выборки агрегации лежат внутри random_sampler. */
export function resultOf(r: LogRequest, res: Record<string, unknown>, sample = 1): LogResult {
  type Agg = { buckets?: Bucket[]; value?: number | null; sum_other_doc_count?: number };
  const top = (res.aggregations ?? {}) as Record<string, Agg & Record<string, Agg>>;
  const aggs = (sample < 1 ? (top.s ?? {}) : top) as Record<string, Agg>;
  const mark = sample < 1 ? { sample } : {};
  const hits = ((res.hits as { hits?: Hit[] } | undefined)?.hits ?? []) as Hit[];
  switch (r.kind) {
    case 'count':
      return { kind: 'count', count: Number(aggs.n?.value ?? 0) };
    case 'histogram':
      return {
        kind: 'histogram',
        buckets: (aggs.h?.buckets ?? []).map((b) => ({ t: Number(b.key), n: b.doc_count ?? 0 })).filter((b) => b.t >= r.from && b.t < r.to),
      };
    case 'terms':
      return { kind: 'terms', terms: (aggs.t?.buckets ?? []).map((b) => ({ key: String(b.key), n: b.doc_count ?? 0 })), other: aggs.t?.sum_other_doc_count ?? 0, ...mark };
    case 'numbers':
      return { kind: 'numbers', buckets: (aggs.h?.buckets ?? []).map((b) => ({ x: Number(b.key), n: b.doc_count ?? 0 })), ...mark };
    case 'lines':
      return { kind: 'lines', lines: hits.map((h) => lineOf(r.service, h)) };
    case 'versions':
      return {
        kind: 'versions',
        versions: (aggs.v?.buckets ?? []).map((b) => ({ key: String(b.key), first: Number(b.first?.value ?? 0), last: Number(b.last?.value ?? 0), n: b.doc_count ?? 0 })),
      };
    case 'match': {
      const total = (res.hits as { total?: { value?: number } } | undefined)?.total?.value ?? hits.length;
      return { kind: 'match', lines: hits.map((h) => lineOf(r.service, h, { ids: allowedFields(r.fields), extra: allowedFields(r.extra ?? []) })), capped: total >= Math.min(r.size, DOCS_LIMIT) };
    }
    case 'daily': {
      const days: Record<string, Record<string, number>> = {};
      const rules = ((aggs.f as { buckets?: Record<string, { d?: { buckets?: { key_as_string?: string; doc_count?: number }[] } }> } | undefined)?.buckets ?? {}) as Record<
        string,
        { d?: { buckets?: { key_as_string?: string; doc_count?: number }[] } }
      >;
      for (const [rule, bucket] of Object.entries(rules)) {
        for (const b of bucket.d?.buckets ?? []) if (b.key_as_string) (days[b.key_as_string] ??= {})[rule] = b.doc_count ?? 0;
      }
      return { kind: 'daily', days };
    }
    case 'docs': {
      const total = (res.hits as { total?: { value?: number } } | undefined)?.total?.value ?? hits.length;
      return { kind: 'docs', lines: hits.map((h) => lineOf(r.service, h)), capped: total >= Math.min(r.size, DOCS_LIMIT) };
    }
  }
}

/** Причина ошибки поиска из ответа Elasticsearch, без лишнего. */
function reasonOf(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { root_cause?: { type?: string; reason?: string }[]; type?: string; reason?: string };
  const cause = e.root_cause?.[0] ?? e;
  return [cause.type, cause.reason].filter(Boolean).join(': ').slice(0, 300) || 'ошибка поиска';
}

/**
 * Логи прода напрямую из кластера Elasticsearch: поиски панели уходят пачками через _msearch, не больше заданного числа
 * HTTP-запросов одновременно. Одинаковые поиски в пределах кэша (у запроса свой cacheMs, иначе общий) и поиски,
 * которые уже идут, в кластер повторно не уходят. 429 и 5xx повторяются один раз после паузы.
 */
export function createEsLogs(o: EsLogsOptions): MonitorLogsPort {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const url = `${o.url.replace(/\/+$/, '')}/_msearch`;
  const concurrency = o.concurrency ?? 2;
  const batch = o.batch ?? 10;
  const cacheMs = o.cacheMs ?? 15_000;
  const cache = new Map<string, { at: number; result: LogResult }>();
  const inflight = new Map<string, Promise<LogResult>>();
  const calls: { at: number; searches: number; cached: number; error: boolean; took: number | null }[] = [];
  let lastError: string | null = null;
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = async () => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  const record = (entry: (typeof calls)[number]) => {
    calls.push(entry);
    while (calls.length && calls[0]!.at < now() - STATS_WINDOW) calls.shift();
  };

  async function post(searches: Search[]): Promise<Response> {
    const body = searches.map((s) => `${JSON.stringify({ index: s.index })}\n${JSON.stringify(s.body)}\n`).join('');
    const send = () =>
      doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8', authorization: `ApiKey ${o.apiKey}` },
        body,
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    const first = await send();
    if (!RETRY_STATUS.has(first.status)) return first;
    await new Promise((resolve) => setTimeout(resolve, o.retryDelayMs ?? 1500));
    return send();
  }

  async function execute(items: { req: LogRequest; search: Search; sample: number }[]): Promise<LogResult[]> {
    const searches = items.map((x) => x.search);
    await acquire();
    try {
      const r = await post(searches);
      if (!r.ok) {
        const message = `Кластер логов ответил ${r.status}: ${(await r.text()).slice(0, 200)}`;
        lastError = message;
        console.error(`Логи прода: ${message}`);
        record({ at: now(), searches: searches.length, cached: 0, error: true, took: null });
        return items.map(() => ({ kind: 'error', message }));
      }
      const json = (await r.json()) as { took?: number; responses?: Record<string, unknown>[] };
      record({ at: now(), searches: searches.length, cached: 0, error: false, took: typeof json.took === 'number' ? json.took : null });
      return items.map(({ req, sample }, i) => {
        const res = json.responses?.[i];
        if (!res || res.error || Number(res.status ?? 200) >= 400) {
          const message = res ? reasonOf(res.error) : 'кластер не прислал ответ на поиск';
          lastError = message;
          return { kind: 'error', message };
        }
        return resultOf(req, res, sample);
      });
    } catch (e) {
      // Сбой сети или таймаут - не ошибка поиска: пишем со стектрейсом, панели получают понятную причину.
      console.error('Логи прода: запрос к кластеру не прошел', e);
      const message = `Кластер логов недоступен: ${e instanceof Error ? e.message : String(e)}`;
      lastError = message;
      record({ at: now(), searches: searches.length, cached: 0, error: true, took: null });
      return items.map(() => ({ kind: 'error', message }));
    } finally {
      release();
    }
  }

  /** Поиски без подготовки выборки: кэш, склейка одинаковых идущих поисков и пачки _msearch. */
  async function plain(requests: LogRequest[], samples: number[]): Promise<LogResult[]> {
    const results: (LogResult | Promise<LogResult>)[] = [];
    const pending: { i: number; key: string; req: LogRequest; search: Search; sample: number }[] = [];
    let cached = 0;
    for (const [i, req] of requests.entries()) {
      const sample = samples[i] ?? 1;
      const search = searchOf(req, sample);
      const key = `${search.index}\n${JSON.stringify(search.body)}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < (req.cacheMs ?? cacheMs)) {
        results[i] = hit.result;
        cached++;
        continue;
      }
      const running = inflight.get(key);
      if (running) {
        results[i] = running;
        cached++;
        continue;
      }
      pending.push({ i, key, req, search, sample });
    }
    if (cached) record({ at: now(), searches: 0, cached, error: false, took: null });
    for (let start = 0; start < pending.length; start += batch) {
      const chunk = pending.slice(start, start + batch);
      const done = execute(chunk);
      chunk.forEach((p, j) => {
        const one = done.then((all) => all[j]!);
        inflight.set(p.key, one);
        results[p.i] = one.then((result) => {
          inflight.delete(p.key);
          // Ошибки не кэшируются: следующий опрос спросит кластер снова.
          if (result.kind !== 'error') cache.set(p.key, { at: now(), result });
          return result;
        });
      });
    }
    // Старые записи кэша вычищаются, чтобы он не рос без предела.
    for (const [key, entry] of cache) if (now() - entry.at > 60 * 60_000) cache.delete(key);
    return Promise.all(results);
  }

  return {
    async run(requests) {
      // Разбор текста дорог: сначала дешево считаются строки под отбором, и разбор идет по выборке около SAMPLE_TARGET строк.
      const heavy = [...requests.keys()].filter((i) => extracts(requests[i]!));
      const samples = requests.map(() => 1);
      if (heavy.length) {
        const counts = await plain(
          heavy.map((i): LogRequest => {
            const r = requests[i]!;
            return { kind: 'count', service: r.service, filter: r.filter, from: r.from, to: r.to, ...(r.cacheMs ? { cacheMs: r.cacheMs } : {}) };
          }),
          heavy.map(() => 1),
        );
        heavy.forEach((i, j) => {
          const c = counts[j];
          if (c?.kind === 'count') samples[i] = sampleOf(c.count);
        });
      }
      return plain(requests, samples);
    },

    stats(): MonitorStats {
      const recent = calls.filter((c) => c.at >= now() - STATS_WINDOW);
      const took = recent.map((c) => c.took).filter((t): t is number => t !== null);
      return {
        windowMs: STATS_WINDOW,
        calls: recent.filter((c) => c.searches > 0).length,
        searches: recent.reduce((a, c) => a + c.searches, 0),
        cached: recent.reduce((a, c) => a + c.cached, 0),
        errors: recent.filter((c) => c.error).length,
        avgTookMs: took.length ? Math.round(took.reduce((a, t) => a + t, 0) / took.length) : null,
        lastError,
      };
    },
  };
}

/**
 * Клиент логов прода по профилю панели: адрес и ключ берутся из env MCP-сервера источника в ~/.claude.json, как у
 * скилла es-search. Если профиля или ключа нет, панель показывает причину вместо данных.
 */
export function esLogsFor(profile: MonitorProfile | null, servers: Record<string, { env: Record<string, string> }>, doFetch?: typeof fetch): MonitorLogsPort | { unavailable: string } {
  if (!profile) return { unavailable: 'Панель мониторинга не настроена: нет monitor.yaml ни в пакете команды, ни в слое компании' };
  const env = servers[profile.source.mcp]?.env;
  if (!env?.ES_URL || !env.ES_API_KEY) return { unavailable: `У MCP-сервера ${profile.source.mcp} в ~/.claude.json нет ES_URL и ES_API_KEY: логам прода не с чем идти в кластер` };
  return createEsLogs({ url: env.ES_URL, apiKey: env.ES_API_KEY, ...(doFetch ? { fetch: doFetch } : {}) });
}

/** Нагрузка клиента, который еще ни разу не ходил в кластер. */
const IDLE_STATS: MonitorStats = { windowMs: STATS_WINDOW, calls: 0, searches: 0, cached: 0, errors: 0, avgTookMs: null, lastError: null };

/**
 * Логи прода с доступом, который можно сменить на ходу: клиент пересоздается, когда меняется env MCP-сервера
 * источника (ключ, заведенный на экране "Интеграции"). Без ключа запросы отвечают причиной, как у esLogsFor.
 */
export function esLogsLive(profile: MonitorProfile | null, servers: () => Record<string, { env: Record<string, string> }>, doFetch?: typeof fetch): MonitorLogsPort {
  // Клиент держит кэш ответов и нагрузку: он пересоздается, только когда env источника действительно другой.
  const envKey = () => JSON.stringify((profile ? servers()[profile.source.mcp]?.env : undefined) ?? null);
  let key = envKey();
  let current = esLogsFor(profile, servers(), doFetch);
  const resolve = () => {
    const next = envKey();
    if (next !== key) {
      key = next;
      current = esLogsFor(profile, servers(), doFetch);
    }
    return current;
  };
  return {
    async run(requests) {
      const port = resolve();
      if ('run' in port) return port.run(requests);
      return requests.map((): LogResult => ({ kind: 'error', message: port.unavailable }));
    },
    stats() {
      const port = resolve();
      return 'run' in port ? port.stats() : { ...IDLE_STATS, lastError: port.unavailable };
    },
  };
}
