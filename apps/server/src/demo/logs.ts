import { HOUR, MINUTE, type Breakdown, type LogFilter, type LogLine, type LogRequest, type LogResult, type MonitorLogsPort, type MonitorServiceProfile, type MonitorStats } from '@task-pilot/step-kit';
import { STORY_SERVICE, storyLines } from './features.ts';

/** Строк в минуту у сервиса учебной команды целиком: калькулятор пишет больше всех, шлюз и аудит - меньше. */
const RATE: Record<string, number> = { calculator: 600, gateway: 120, audit: 20 };
const LEVELS: [string, number][] = [
  ['DEBUG', 0.3],
  ['INFO', 0.55],
  ['WARN', 0.1],
  ['ERROR', 0.05],
];
const LOGGERS: Record<string, string[]> = {
  calculator: ['demo.calculator.CalculatorService', 'demo.calculator.OperationValidator', 'demo.calculator.events'],
  gateway: ['demo.gateway.RequestHandler', 'demo.gateway.RateLimiter'],
  audit: ['demo.audit.AuditWriter'],
};
const VERSIONS: Record<string, [string, string]> = {
  calculator: ['1.0.272-master', '1.0.273-master'],
  gateway: ['1.0.175-master', '1.0.176-master'],
  audit: ['1.0.23-master', '1.0.24-master'],
};
/** Слова после префикса в тексте строки: по префиксу подбирается правдоподобный набор. */
const WORDS: [RegExp, [string, number][]][] = [
  [/channel/i, [['web', 0.82], ['android', 0.11], ['ios', 0.07]]],
  [/platform/i, [['site', 0.7], ['android', 0.18], ['ios', 0.12]]],
  [/enabled|flag/i, [['false', 0.8], ['true', 0.2]]],
  [/provider|провайдер/i, [['alpha', 0.55], ['beta', 0.3], ['gamma', 0.08], ['delta', 0.07]]],
  [/status/i, [['success', 0.97], ['error', 0.03]]],
];
const OTHER_WORDS: [string, number][] = [['value-a', 0.6], ['value-b', 0.3], ['value-c', 0.1]];
/** Распределение score: пик у нуля и несколько групп, как у настоящих оценок риска. */
const SCORES: [number, number][] = [
  [0, 0.55],
  [10, 0.02],
  [20, 0.14],
  [30, 0.06],
  [40, 0.04],
  [50, 0.01],
  [60, 0.11],
  [70, 0.02],
  [80, 0.01],
  [90, 0.04],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Детерминированное число в [0, 1) по строке: FNV-1a и финальное перемешивание murmur3, без которого соседние минуты
 * дают почти одинаковые значения и шум идет ступенями.
 */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}

const hex = (seed: string, n: number) => Array.from({ length: n }, (_, i) => Math.floor(hash01(`${seed}:${i}`) * 16).toString(16)).join('');
const uuidOf = (seed: string) => `${hex(seed, 8)}-${hex(`${seed}b`, 4)}-${hex(`${seed}c`, 4)}-${hex(`${seed}d`, 4)}-${hex(`${seed}e`, 12)}`;
const stateOf = (seed: string) => Array.from({ length: 32 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(hash01(`${seed}/${i}`) * 62)]).join('');

/** Фразы сбоев, фрода и срабатываний: на проде они редкие, в демо тоже, иначе доли выглядят как авария. */
const RARE = /ошибк|код ответа|помеч|красн|бот|кандидат|сработал|имитац|пропущена|отсутствует|error|fail/i;

/** Доля строк сервиса, которые проходят отбор: каждая фраза встречается в своей доле строк. */
function shareOf(f: LogFilter): number {
  const phrase = (p: string) => (0.01 + 0.4 * hash01(`p:${p}`) ** 2) * (RARE.test(p) ? 0.03 : 1);
  let share = f.match.reduce((a, p) => a * phrase(p), 1);
  for (const group of f.anyOf) share *= Math.min(1, group.reduce((a, p) => a + phrase(p), 0));
  for (const p of f.not) share *= 1 - phrase(p);
  if (f.level.length) share *= Math.min(1, LEVELS.filter(([l]) => f.level.includes(l)).reduce((a, [, w]) => a + w, 0));
  return share;
}

const keyOf = (s: MonitorServiceProfile, f: LogFilter) => `${s.id}|${JSON.stringify(f)}`;

/** Момент учебного деплоя сервиса: несколько часов назад, свой у каждого сервиса. */
function deployAt(s: Pick<MonitorServiceProfile, 'id'>, now: number): number {
  return Math.floor(now / HOUR) * HOUR - (2 + Math.floor(hash01(`deploy:${s.id}`) * 14)) * HOUR - Math.floor(hash01(`deploy-m:${s.id}`) * 50) * MINUTE;
}

/** Подменные логи прода для демо: у любого отбора свой устойчивый поток строк с суточным ходом, шумом и всплеском. */
export function demoLogs(now: () => number = Date.now): MonitorLogsPort {
  let calls: { at: number; searches: number }[] = [];
  // Учебная фича калькулятора: связные сессии для воронок, а не доля строк под отбором.
  const stories = storyLines(now, () => deployAt({ id: STORY_SERVICE }, now()));

  /** Строк отбора в минуту: одинаковый шум всех отборов сервиса держит долю part/of в разумных пределах. */
  const perMinute = (s: MonitorServiceProfile, f: LogFilter, minute: number): number => {
    const key = keyOf(s, f);
    const hourMsk = ((minute / 60 + 3) % 24 + 24) % 24;
    const daily = 0.35 + 0.65 * (1 + Math.sin((2 * Math.PI * (hourMsk - 9)) / 24)) / 2;
    const noise = 0.75 + 0.5 * hash01(`${s.id}#${minute}`);
    const burstHour = Math.floor(hash01(`burst:${key}`) * 24);
    const burst = hash01(`b?:${key}`) < 0.3 && Math.floor(hourMsk) === burstHour ? 3 : 1;
    const x = (RATE[s.id] ?? 30) * shareOf(f) * daily * noise * burst;
    return Math.floor(x + hash01(`${key}@${minute}`));
  };
  const minutes = (from: number, to: number) => {
    const out: number[] = [];
    for (let m = Math.floor(from / MINUTE); m * MINUTE < Math.min(to, now()); m++) out.push(m);
    return out;
  };
  const countOf = (s: MonitorServiceProfile, f: LogFilter, from: number, to: number) => minutes(from, to).reduce((a, m) => a + perMinute(s, f, m), 0);
  const versionAt = (s: MonitorServiceProfile, t: number) => (VERSIONS[s.id] ?? ['1.0.1-master', '1.0.2-master'])[t < deployAt(s, now()) ? 0 : 1]!;
  const podAt = (s: MonitorServiceProfile, t: number, i: number) => `${s.container}-deployment-${hex(`${s.id}${versionAt(s, t)}`, 9)}-${['a1b2c', 'd3e4f'][i % 2]}`;
  const spread = (total: number, parts: [string, number][]) => {
    const sum = parts.reduce((a, [, w]) => a + w, 0);
    return parts.map(([key, w]) => ({ key, n: Math.round((total * w) / sum) })).filter((x) => x.n > 0);
  };

  const line = (s: MonitorServiceProfile, f: LogFilter, t: number, i: number): LogLine => {
    const seed = `${s.id}${t}${i}`;
    const words = [...f.match, ...f.anyOf.map((g) => g[Math.floor(hash01(`${seed}g`) * g.length)]!)];
    const text = words.length ? words.join(', ') : 'Обработан запрос';
    return {
      service: s.id,
      t,
      level: f.level[0] ?? (hash01(`${seed}l`) < 0.9 ? 'INFO' : 'WARN'),
      logger: LOGGERS[s.id]?.[0] ?? `${s.container}.Service`,
      message: `${text}: state = ${stateOf(seed)}, channel = web, correlationId=${uuidOf(seed)}`,
      pod: podAt(s, t, i),
      version: versionAt(s, t),
    };
  };

  const lines = (s: MonitorServiceProfile, f: LogFilter, from: number, to: number, size: number): LogLine[] => {
    const out: LogLine[] = [];
    const stop = Math.max(from, to - 7 * 24 * HOUR);
    for (let m = Math.floor((Math.min(to, now()) - 1) / MINUTE); m * MINUTE >= stop && out.length < size; m--) {
      const n = perMinute(s, f, m);
      for (let k = n - 1; k >= 0 && out.length < size; k--) {
        const t = m * MINUTE + Math.floor(((k + 0.5) * MINUTE) / n);
        if (t >= from && t < to) out.push(line(s, f, t, k));
      }
    }
    return out;
  };

  /**
   * Цепочка одной операции для state из сочиненных строк дашбордов: по state находится калькулятор, а в его строках -
   * UUID, по которым находятся шлюз и аудит.
   */
  const chain = (s: MonitorServiceProfile, value: string, from: number, to: number): LogLine[] => {
    // Все строки цепочки отсчитываются от одного момента окна: и по state, и по UUID второго прохода порядок один.
    const t0 = Math.max(from, Math.min(to, now()) - 10 * MINUTE);
    const at = (k: number) => t0 + k * 1700;
    const base = { service: s.id, pod: podAt(s, t0, 0), version: versionAt(s, t0), logger: LOGGERS[s.id]?.[0] ?? s.container };
    const uuid = UUID.test(value);
    if (s.id === 'calculator') {
      if (uuid) return [{ ...base, t: at(2), level: 'TRACE', logger: 'demo.calculator.http', message: `Outgoing Request: POST https://gateway.demo.invalid/api/operations {"correlationId":"${value}"}` }];
      const corr = uuidOf(`corr${value}`);
      const flow = uuidOf(`flow${value}`);
      return [
        { ...base, t: at(0), level: 'INFO', message: `Операция принята: state=${value}, channel=web` },
        { ...base, t: at(1), level: 'INFO', message: `Calculator subtract: a=3, b=5, state = ${value}` },
        { ...base, t: at(3), level: 'INFO', message: `Операция передана в шлюз, state = ${value}, correlationId=${corr}` },
        { ...base, t: at(6), level: 'INFO', logger: 'demo.calculator.access-log', message: `GET /api/operations/result?state=${flow}` },
        { ...base, t: at(8), level: 'INFO', logger: 'demo.calculator.events', message: `type="RESULT", clientId="demo-web", state = ${value}` },
      ];
    }
    if (!uuid) return [];
    if (s.id === 'audit') {
      return [
        { ...base, t: at(4), level: 'INFO', message: 'Операция записана в журнал', ids: { 'flowState.keyword': value } },
        { ...base, t: at(7), level: 'INFO', message: 'Результат операции записан в журнал', ids: { 'flowState.keyword': value } },
      ];
    }
    if (s.id === 'gateway') return [{ ...base, t: at(3) + 400, level: 'INFO', message: `Операция передана дальше, correlation id '${value}'` }];
    return [];
  };

  const terms = (s: MonitorServiceProfile, f: LogFilter, from: number, to: number, by: Breakdown, size: number): { key: string; n: number }[] => {
    const total = countOf(s, f, from, to);
    if (by === 'level') return spread(total, f.level.length ? LEVELS.filter(([l]) => f.level.includes(l)) : LEVELS);
    if (by === 'logger') return spread(total, (LOGGERS[s.id] ?? ['service']).map((l, i) => [l, 1 / (i + 1)]));
    if (by === 'version' || by === 'pod') {
      const cut = deployAt(s, now());
      const before = cut > from ? countOf(s, f, from, Math.min(cut, to)) : 0;
      const after = total - before;
      const [old, fresh] = VERSIONS[s.id] ?? ['1.0.1-master', '1.0.2-master'];
      if (by === 'version') return [{ key: fresh!, n: after }, { key: old!, n: before }].filter((x) => x.n > 0);
      return [
        { key: podAt(s, to - 1, 0), n: Math.ceil(after / 2) },
        { key: podAt(s, to - 1, 1), n: Math.floor(after / 2) },
        { key: podAt(s, from, 0), n: Math.ceil(before / 2) },
        { key: podAt(s, from, 1), n: Math.floor(before / 2) },
      ].filter((x) => x.n > 0);
    }
    const words = WORDS.find(([re]) => re.test(by.extract))?.[1] ?? OTHER_WORDS;
    return spread(total, words).slice(0, size);
  };

  const answer = (r: LogRequest): LogResult => {
    const s = r.service;
    switch (r.kind) {
      case 'count':
        return { kind: 'count', count: countOf(s, r.filter, r.from, r.to) };
      case 'histogram': {
        const buckets = [];
        for (let t = r.from; t < r.to; t += r.bucketMs) buckets.push({ t, n: countOf(s, r.filter, t, Math.min(t + r.bucketMs, r.to)) });
        return { kind: 'histogram', buckets };
      }
      case 'terms': {
        const all = terms(s, r.filter, r.from, r.to, r.by, r.size).sort((a, b) => b.n - a.n);
        return { kind: 'terms', terms: all.slice(0, r.size), other: all.slice(r.size).reduce((a, x) => a + x.n, 0) };
      }
      case 'numbers': {
        const total = countOf(s, r.filter, r.from, r.to);
        const dist: [number, number][] = /score/i.test(r.extract) ? SCORES : Array.from({ length: 10 }, (_, i) => [50 + i * 10, Math.exp(-(((i - 4.5) / 2.2) ** 2))]);
        const buckets = new Map<number, number>();
        for (const [x, w] of dist) {
          const key = Math.floor(x / r.interval) * r.interval;
          buckets.set(key, (buckets.get(key) ?? 0) + Math.round((total * w) / dist.reduce((a, [, v]) => a + v, 0)));
        }
        return { kind: 'numbers', buckets: [...buckets].sort((a, b) => a[0] - b[0]).map(([x, n]) => ({ x, n })) };
      }
      case 'lines': {
        // Отбор по фразам учебной фичи (признак поиска попыток) отвечает ее строками, остальные - сочиненным потоком.
        const story = stories.between(s, r.filter, r.from, r.to);
        return { kind: 'lines', lines: story.length ? story.reverse().slice(0, r.size) : lines(s, r.filter, r.from, r.to, r.size) };
      }
      case 'versions': {
        const cut = deployAt(s, now());
        const [old, fresh] = VERSIONS[s.id] ?? ['1.0.1-master', '1.0.2-master'];
        const versions = [];
        if (cut > r.from) versions.push({ key: old!, first: r.from, last: Math.min(cut, r.to) - 1, n: 1 });
        if (cut < r.to) versions.push({ key: fresh!, first: Math.max(cut, r.from), last: Math.min(r.to, now()) - 1, n: 1 });
        return { kind: 'versions', versions };
      }
      case 'match': {
        // Значения учебной фичи находятся в ее строках; state из сочиненных строк дашбордов - цепочкой операции.
        let found = stories.match(s, r.filter, r.values, r.fields, r.text, r.from, r.to);
        if (!found.length && r.text) found = r.values.flatMap((v) => chain(s, v, r.from, r.to)).filter((l) => l.t >= r.from && l.t < r.to);
        return { kind: 'match', lines: found.slice(0, r.size), capped: found.length > r.size };
      }
      case 'daily':
        return { kind: 'daily', days: stories.daily(s, r.filter, r.rules, r.from, r.to, r.timeZone) };
      case 'docs': {
        const all = stories.between(s, r.filter, r.from, r.to);
        return { kind: 'docs', lines: all.slice(0, r.size), capped: all.length >= r.size };
      }
    }
  };

  return {
    async run(requests) {
      const at = now();
      calls = [...calls.filter((c) => c.at > at - 5 * MINUTE), { at, searches: requests.length }];
      return requests.map(answer);
    },
    stats(): MonitorStats {
      const recent = calls.filter((c) => c.at > now() - 5 * MINUTE);
      return { windowMs: 5 * MINUTE, calls: recent.length, searches: recent.reduce((a, c) => a + c.searches, 0), cached: 0, errors: 0, avgTookMs: recent.length ? 35 : null, lastError: null };
    },
  };
}
