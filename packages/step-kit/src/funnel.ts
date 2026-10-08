import { z } from 'zod';
import type { LogFilter, LogLine } from './monitor.ts';

/**
 * Воронки фич входа по логам прода: профиль фичи (что искать в логах и как это называется) и чистый расчет по строкам.
 * Профиль описывает стадии по ролям (вход в воронку, показ шага, успех, ветка обхода), ошибки сервиса, исходы после
 * шага по трассе запроса или по сессии, путь до входа, время шага и порог, с которого сессия считается автоматом.
 * Сессия - значение, которое выражение session профиля находит в тексте строки; метрики по сессиям считаются по
 * уникальным сессиям, строки - отдельно.
 */

const key = z.string().regex(/^[a-z][a-z0-9_]*$/, 'ключ из строчных латинских букв, цифр и подчеркивания');
const phrase = z.string().min(1).max(300);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата вида 2026-09-09');

function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Регулярное выражение с группой: значение берется из первой группы. */
export const captureSchema = z
  .string()
  .min(1)
  .refine((s) => compiles(s) && (new RegExp(`${s}|`).exec('')?.length ?? 0) > 1, 'регулярное выражение с группой в скобках');

const rule = {
  /** Хотя бы одна фраза должна быть в строке. */
  any: z.array(phrase).min(1),
  /** Все фразы должны быть в строке. */
  all: z.array(phrase).default([]),
  /** Ни одной фразы не должно быть. */
  not: z.array(phrase).default([]),
};

/** Правило поиска строк: фразы any, all и not ищутся в тексте строки. */
export const featureRuleSchema = z.strictObject(rule);

export type FeatureRule = z.infer<typeof featureRuleSchema>;

/** Роль стадии: вход в воронку, показ шага, успех и ветка обхода, которая в успех не входит. */
export const FEATURE_ROLES = ['entry', 'shown', 'success', 'skip'] as const;

export type FeatureRole = (typeof FEATURE_ROLES)[number];

const stageSchema = z.strictObject({
  key,
  label: z.string().min(1),
  ...rule,
  role: z.enum(FEATURE_ROLES).optional(),
  /** Распределение значения из строк стадии, например score у желтой зоны. */
  detail: z.strictObject({ regex: captureSchema, label: z.string().min(1) }).optional(),
});

const errorSchema = z.strictObject({ key, label: z.string().min(1), ...rule });

const outcomeSchema = z.strictObject({
  key,
  label: z.string().min(1),
  any: z.array(phrase).min(1),
  /** Разбивка исхода по значению из строк, например по провайдеру кода. */
  detail: captureSchema.optional(),
  tone: z.enum(['good', 'bad', 'neutral']).default('neutral'),
});

/** Профиль фичи: features/<id>.yaml пакета команды. */
export const featureProfileSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    short: z.string().min(1),
    /** День включения фичи на проде: с него начинаются дневные итоги. */
    since: day,
    /** Пометка к первому дню, например "с 11:11". */
    sinceNote: z.string().min(1).optional(),
    /** Сервис панели мониторинга, в логах которого маркеры фичи. */
    service: z.string().min(1),
    /** Что фича делает и кому показывается. */
    intro: z.string().min(1),
    /** Как достать сессию из текста строки. */
    session: captureSchema,
    /** Знаменатель: строки, по одной на вход, от которых считается доля фичи. */
    baseline: z.strictObject({ label: z.string().min(1), ...rule }),
    stages: z.array(stageSchema).min(1),
    /** Ошибки сервиса: считаются по строкам и в воронку не входят. */
    errors: z.array(errorSchema).default([]),
    /** Исходы после стадии from: строки той же трассы запроса или той же сессии, первый совпавший исход. */
    downstream: z
      .strictObject({
        from: key,
        by: z.enum(['trace', 'state']),
        title: z.string().min(1),
        outcomes: z.array(outcomeSchema).min(1),
        otherLabel: z.string().min(1).default('Прочее'),
      })
      .optional(),
    /** Вход после стадии from: строки any, сессия в них - по выражению session. */
    login: z.strictObject({ from: key, label: z.string().min(1), any: z.array(phrase).min(1), session: captureSchema }).optional(),
    /** Время шага: от первой строки from до первой строки to после нее в той же сессии. */
    timing: z.strictObject({ from: key, to: key, label: z.string().min(1) }).optional(),
    /** Сессия - автомат, когда стадия stage (без нее - стадия показа) повторилась threshold раз и больше. */
    automation: z.strictObject({ stage: key.optional(), threshold: z.number().int().min(2).default(6) }).default({ threshold: 6 }),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    const unique = (k: string, path: (string | number)[]) => {
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path, message: `ключ ${k} повторяется` });
      seen.add(k);
    };
    p.stages.forEach((s, i) => unique(s.key, ['stages', i, 'key']));
    p.errors.forEach((e, i) => unique(e.key, ['errors', i, 'key']));
    for (const role of FEATURE_ROLES) {
      const n = p.stages.filter((s) => s.role === role).length;
      if (role === 'entry' ? n !== 1 : n > 1) {
        ctx.addIssue({ code: 'custom', path: ['stages'], message: role === 'entry' ? 'нужна ровно одна стадия с ролью entry' : `стадия с ролью ${role} может быть только одна` });
      }
    }
    const stage = (k: string, path: (string | number)[]) => {
      if (!p.stages.some((s) => s.key === k)) ctx.addIssue({ code: 'custom', path, message: `нет стадии ${k}` });
    };
    if (p.downstream) stage(p.downstream.from, ['downstream', 'from']);
    if (p.login) stage(p.login.from, ['login', 'from']);
    if (p.timing) {
      stage(p.timing.from, ['timing', 'from']);
      stage(p.timing.to, ['timing', 'to']);
    }
    if (p.automation.stage) stage(p.automation.stage, ['automation', 'stage']);
  });

export type FeatureProfile = z.infer<typeof featureProfileSchema>;

/** Строка подходит под правило: есть хотя бы одна фраза any, все фразы all и ни одной not. */
export function ruleMatches(r: { any: string[]; all?: string[]; not?: string[] }, message: string): boolean {
  if (r.any.length && !r.any.some((p) => message.includes(p))) return false;
  if ((r.all ?? []).some((p) => !message.includes(p))) return false;
  return !(r.not ?? []).some((p) => message.includes(p));
}

/** Правило как отбор строк в логах прода. */
export function ruleFilter(r: FeatureRule): LogFilter {
  return { match: [...r.all], anyOf: [[...r.any]], not: [...r.not], level: [] };
}

/** Стадии и ошибки по порядку: строка относится к первому подходящему правилу. */
function rulesOf(p: FeatureProfile): (FeatureRule & { key: string })[] {
  return [...p.stages, ...p.errors];
}

/** Стадия или ошибка, к которой относится строка; null - ни одно правило не подошло. */
export function classifyFeatureLine(p: FeatureProfile, message: string): string | null {
  return rulesOf(p).find((r) => ruleMatches(r, message))?.key ?? null;
}

/** Отбор строк всех стадий и ошибок фичи: по нему берутся строки окна. */
export function featureLinesFilter(p: FeatureProfile): LogFilter {
  return { match: [], anyOf: [[...new Set(rulesOf(p).flatMap((r) => r.any))]], not: [], level: [] };
}

/** Правила дневных итогов: знаменатель baseline, все стадии и ошибки. */
export function featureDailyRules(p: FeatureProfile): Record<string, LogFilter> {
  return Object.fromEntries([['baseline', ruleFilter(p.baseline)], ...rulesOf(p).map((r) => [r.key, ruleFilter(r)] as const)]);
}

/** Значение первой группы выражения в тексте; null - не нашлось. */
export function captureOf(source: string, text: string): string | null {
  return new RegExp(source).exec(text)?.[1] ?? null;
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();

/** Части момента в часовом поясе: год, месяц, день, час и минута, по две цифры. */
function partsOf(t: number, timeZone: string): Record<string, string> {
  let f = FORMATS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    FORMATS.set(timeZone, f);
  }
  return Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
}

/** День момента в часовом поясе: 2026-09-30. */
export function localDay(t: number, timeZone: string): string {
  const p = partsOf(t, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Час момента в часовом поясе: 2026-09-30T14. */
export function localHour(t: number, timeZone: string): string {
  return `${localDay(t, timeZone)}T${partsOf(t, timeZone).hour}`;
}

/** День, сдвинутый на n дней: 2026-09-30 и 1 - 2026-10-01. */
export function shiftDay(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
}

/** Начало дня в часовом поясе, мс: 00:00 по местному времени. */
export function zonedDayStart(d: string, timeZone: string): number {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, dd);
  const offset = (t: number) => {
    const p = partsOf(t, timeZone);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - t;
  };
  const first = guess - offset(guess);
  // Если в эти сутки сдвигалось время, смещение на полночь другое: второй проход берет его.
  return guess - offset(first);
}

/** Момент для людей в часовом поясе: 30.09 14:05. */
export function localStamp(t: number, timeZone: string): string {
  const p = partsOf(t, timeZone);
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

/** Строка лога для воронки: время, текст, трасса и версия сервиса. */
export type FeatureLine = Pick<LogLine, 't' | 'message'> & Partial<Pick<LogLine, 'trace' | 'version'>>;

/** Строки окна, разложенные по сессиям и стадиям. */
export interface FeatureTally {
  /** Сессия - стадия - времена ее строк по порядку. */
  sessions: Map<string, Map<string, number[]>>;
  /** Трассы строк каждой стадии: по ним ищутся исходы после шага. */
  traces: Map<string, Set<string>>;
  /** Строк по стадиям и ошибкам. */
  lines: Record<string, number>;
  /** Распределения значений detail по стадиям. */
  details: Record<string, Record<string, number>>;
  /** Версия сервиса - первая и последняя строка с ней. */
  versions: Record<string, [number, number]>;
  /** Час в часовом поясе - строк по стадиям и ошибкам. */
  hourly: Record<string, Record<string, number>>;
  /** Строки, которые не подошли ни под одно правило или в которых нет сессии. */
  unparsed: number;
}

const bump = (o: Record<string, number>, k: string, n = 1) => {
  o[k] = (o[k] ?? 0) + n;
};

/**
 * Раскладывает строки окна по сессиям: стадия строки, ее время в сессии, трасса и версия сервиса, разбивка по часам.
 * Строка без подходящего правила или без сессии считается неразобранной; строка без сессии в итогах по строкам есть.
 */
export function tallyFeature(p: FeatureProfile, lines: FeatureLine[], timeZone: string): FeatureTally {
  const t: FeatureTally = { sessions: new Map(), traces: new Map(), lines: {}, details: {}, versions: {}, hourly: {}, unparsed: 0 };
  const detailOf = new Map(p.stages.filter((s) => s.detail).map((s) => [s.key, s.detail!]));
  for (const line of [...lines].sort((a, b) => a.t - b.t)) {
    const k = classifyFeatureLine(p, line.message);
    if (k === null) {
      t.unparsed++;
      continue;
    }
    bump(t.lines, k);
    const version = line.version?.split(':').pop();
    if (version) {
      const v = t.versions[version];
      t.versions[version] = v ? [v[0], line.t] : [line.t, line.t];
    }
    bump((t.hourly[localHour(line.t, timeZone)] ??= {}), k);
    const detail = detailOf.get(k);
    if (detail) bump((t.details[k] ??= {}), captureOf(detail.regex, line.message) ?? '?');
    const session = captureOf(p.session, line.message);
    if (session === null) {
      t.unparsed++;
      continue;
    }
    let stages = t.sessions.get(session);
    if (!stages) t.sessions.set(session, (stages = new Map()));
    stages.set(k, [...(stages.get(k) ?? []), line.t]);
    if (line.trace) {
      let traces = t.traces.get(k);
      if (!traces) t.traces.set(k, (traces = new Set()));
      traces.add(line.trace);
    }
  }
  return t;
}

/** Ключ стадии с ролью; null - такой стадии в профиле нет. */
export function roleKey(p: FeatureProfile, role: FeatureRole): string | null {
  return p.stages.find((s) => s.role === role)?.key ?? null;
}

/** Сессии, где есть стадия. */
function withStage(t: FeatureTally, k: string | null): string[] {
  return k ? [...t.sessions].filter(([, v]) => v.get(k)?.length).map(([s]) => s) : [];
}

/** Что искать после шага: трассы или сессии строк стадии from; null - исходов в профиле нет. */
export function downstreamKeys(p: FeatureProfile, t: FeatureTally): { by: 'trace' | 'state'; from: string; keys: string[] } | null {
  const ds = p.downstream;
  if (!ds) return null;
  return { by: ds.by, from: ds.from, keys: ds.by === 'trace' ? [...(t.traces.get(ds.from) ?? [])].sort() : withStage(t, ds.from).sort() };
}

/** Строки, по которым ищутся исходы: исходы и сама стадия from, чтобы связать трассу или сессию. */
export function downstreamPhrases(p: FeatureProfile): string[] {
  const ds = p.downstream;
  if (!ds) return [];
  const from = p.stages.find((s) => s.key === ds.from);
  return [...new Set([...ds.outcomes.flatMap((o) => o.any), ...(from?.any ?? [])])];
}

/** Исходы после шага: сколько трасс или сессий пришли к каждому исходу и разбивка по detail. */
export interface DownstreamTally {
  total: number;
  counts: Record<string, number>;
  details: Record<string, Record<string, number>>;
}

/**
 * Исходы после шага: строки каждой трассы или сессии склеиваются, исход - первый из профиля, чьи фразы есть в склейке,
 * остальное - "Прочее" (ключ __other__).
 */
export function downstreamOf(p: FeatureProfile, keys: string[], messages: Map<string, string[]>): DownstreamTally {
  const out: DownstreamTally = { total: keys.length, counts: {}, details: {} };
  const outcomes = p.downstream?.outcomes ?? [];
  for (const k of keys) {
    const joined = (messages.get(k) ?? []).join(' | ');
    const hit = outcomes.find((o) => o.any.some((ph) => joined.includes(ph)));
    if (!hit) {
      bump(out.counts, '__other__');
      continue;
    }
    bump(out.counts, hit.key);
    if (hit.detail) bump((out.details[hit.key] ??= {}), captureOf(hit.detail, joined) ?? '?');
  }
  return out;
}

/** Сессии, для которых ищется вход: со стадией login.from. */
export function loginSessions(p: FeatureProfile, t: FeatureTally): string[] {
  return p.login ? withStage(t, p.login.from).sort() : [];
}

/** Распределение по процентилю: значение на позиции floor(p * n), как в скилле. */
export function percentile(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null;
}

/** Корзина времени шага для гистограммы. */
export function secondsBucket(x: number): string {
  if (x < 5) return 'до 5 с';
  if (x < 10) return '5-10 с';
  if (x < 60) return '10-60 с';
  if (x < 300) return '1-5 мин';
  return 'дольше 5 мин';
}

/** Корзины времени шага по порядку. */
export const SECONDS_BUCKETS = ['до 5 с', '5-10 с', '10-60 с', '1-5 мин', 'дольше 5 мин'];

/** Стадия воронки за окно: сессий всего и без автоматов, строк. */
export interface FeatureFunnelStep {
  key: string;
  label: string;
  role: FeatureRole | null;
  sessions: number;
  sessionsNormal: number;
  lines: number;
}

/** Вывод для команды по цифрам окна. */
export interface FeatureFinding {
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  title: string;
  text: string;
}

/** Статистика фичи за окно: воронка, время шага, автоматы, исходы, вход, по часам и выводы. */
export interface FeatureStats {
  window: { from: number; to: number };
  sessions: number;
  funnel: FeatureFunnelStep[];
  lines: Record<string, number>;
  unparsed: number;
  details: Record<string, Record<string, number>>;
  versions: { version: string; first: number; last: number }[];
  /** Сессий и с веткой обхода, и с успехом. */
  overlapSkipSuccess: number;
  /** Сколько раз сессии видели шаг: число показов - сессий. */
  showsDistribution: Record<string, number>;
  automation: {
    stage: string | null;
    threshold: number;
    count: number;
    shownLines: number;
    successLines: number;
    rows: { session: string; shows: number; success: number; first: number; last: number; login: boolean }[];
  };
  timing: { label: string; n: number; median: number | null; p75: number | null; p90: number | null; p95: number | null; buckets: Record<string, number> } | null;
  downstream: (DownstreamTally & { by: 'trace' | 'state'; from: string; title: string }) | null;
  login: {
    label: string;
    from: string;
    fromSessions: number;
    fromSessionsNormal: number;
    reached: number;
    reachedNormal: number;
    reachedAutomation: number;
    median: number | null;
    p75: number | null;
    p90: number | null;
  } | null;
  hourly: Record<string, Record<string, number>>;
  /** День - обычных сессий, которые увидели шаг и не завершили его. */
  abandonedByDay: Record<string, number>;
  errors: Record<string, number>;
  findings: FeatureFinding[];
}

/** Первое время после момента a; null - таких нет. */
function firstAfter(times: number[], a: number): number | null {
  const later = times.filter((x) => x >= a);
  return later.length ? Math.min(...later) : null;
}

/**
 * Статистика фичи за окно по разложенным строкам и найденным хвостам: исходам после шага (downstream) и входам по
 * сессиям (logins). Автоматы исключаются из времени шага и доли дошедших до входа.
 */
export function featureStats(
  p: FeatureProfile,
  t: FeatureTally,
  o: { from: number; to: number; timeZone: string; downstream?: DownstreamTally | null; logins?: Map<string, number[]> | null },
): FeatureStats {
  const shownKey = roleKey(p, 'shown');
  const successKey = roleKey(p, 'success');
  const skipKey = roleKey(p, 'skip');
  const autoStage = p.automation.stage ?? shownKey;
  const threshold = p.automation.threshold;
  const count = (session: string, k: string | null) => (k ? (t.sessions.get(session)?.get(k)?.length ?? 0) : 0);
  const automation = autoStage ? [...t.sessions.keys()].filter((s) => count(s, autoStage) >= threshold).sort((a, b) => count(b, autoStage) - count(a, autoStage)) : [];
  const auto = new Set(automation);
  const normal = (s: string) => !auto.has(s);

  const funnel = p.stages.map((s) => {
    const all = withStage(t, s.key);
    return { key: s.key, label: s.label, role: s.role ?? null, sessions: all.length, sessionsNormal: all.filter(normal).length, lines: t.lines[s.key] ?? 0 };
  });

  let timing: FeatureStats['timing'] = null;
  if (p.timing) {
    const { from, to, label } = p.timing;
    const vals: number[] = [];
    for (const [s, v] of t.sessions) {
      const a = v.get(from)?.[0];
      const b = a === undefined || !normal(s) ? null : firstAfter(v.get(to) ?? [], a);
      if (a !== undefined && b !== null) vals.push((b - a) / 1000);
    }
    vals.sort((x, y) => x - y);
    const buckets: Record<string, number> = {};
    for (const x of vals) bump(buckets, secondsBucket(x));
    timing = { label, n: vals.length, median: percentile(vals, 0.5), p75: percentile(vals, 0.75), p90: percentile(vals, 0.9), p95: percentile(vals, 0.95), buckets };
  }

  const showsDistribution: Record<string, number> = {};
  for (const s of withStage(t, shownKey)) bump(showsDistribution, String(count(s, shownKey)));

  let login: FeatureStats['login'] = null;
  const logins = o.logins ?? null;
  if (p.login && logins) {
    const fromStates = loginSessions(p, t);
    const norm = fromStates.filter(normal);
    const deltas: number[] = [];
    for (const s of norm) {
      const a = t.sessions.get(s)?.get(p.login.from)?.[0];
      const b = a === undefined ? null : firstAfter(logins.get(s) ?? [], a);
      if (a !== undefined && b !== null) deltas.push((b - a) / 1000);
    }
    deltas.sort((x, y) => x - y);
    login = {
      label: p.login.label,
      from: p.login.from,
      fromSessions: fromStates.length,
      fromSessionsNormal: norm.length,
      reached: fromStates.filter((s) => logins.has(s)).length,
      reachedNormal: norm.filter((s) => logins.has(s)).length,
      reachedAutomation: automation.filter((s) => logins.has(s)).length,
      median: percentile(deltas, 0.5),
      p75: percentile(deltas, 0.75),
      p90: percentile(deltas, 0.9),
    };
  }

  const rows = automation.slice(0, 12).map((s) => {
    const all = [...(t.sessions.get(s)?.values() ?? [])].flat();
    return { session: s, shows: count(s, autoStage), success: count(s, successKey), first: Math.min(...all), last: Math.max(...all), login: logins?.has(s) ?? false };
  });

  const abandonedByDay: Record<string, number> = {};
  if (shownKey && successKey) {
    for (const [s, v] of t.sessions) {
      const shown = v.get(shownKey);
      if (shown?.length && !v.get(successKey)?.length && normal(s)) bump(abandonedByDay, localDay(shown[0]!, o.timeZone));
    }
  }

  const ds = p.downstream;
  const stats: FeatureStats = {
    window: { from: o.from, to: o.to },
    sessions: t.sessions.size,
    funnel,
    lines: t.lines,
    unparsed: t.unparsed,
    details: t.details,
    versions: Object.entries(t.versions)
      .map(([version, [first, last]]) => ({ version, first, last }))
      .sort((a, b) => a.version.localeCompare(b.version)),
    overlapSkipSuccess: skipKey && successKey ? [...t.sessions.values()].filter((v) => v.get(skipKey)?.length && v.get(successKey)?.length).length : 0,
    showsDistribution,
    automation: {
      stage: autoStage,
      threshold,
      count: automation.length,
      shownLines: automation.reduce((n, s) => n + count(s, autoStage), 0),
      successLines: automation.reduce((n, s) => n + count(s, successKey), 0),
      rows,
    },
    timing,
    downstream: ds && o.downstream ? { ...o.downstream, by: ds.by, from: ds.from, title: ds.title } : null,
    login,
    hourly: t.hourly,
    abandonedByDay,
    errors: Object.fromEntries(p.errors.map((e) => [e.key, t.lines[e.key] ?? 0])),
    findings: [],
  };
  stats.findings = featureFindings(p, stats, o.timeZone);
  return stats;
}

/** Число для людей: группы по три цифры через пробел. */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Секунды для людей: 4.2 с, 35 с, 3 мин. */
export function fmtSeconds(x: number | null | undefined): string {
  if (x === null || x === undefined) return '-';
  if (x < 90) return x < 10 ? `${x.toFixed(1)} с` : `${Math.round(x)} с`;
  return `${Math.round(x / 60)} мин`;
}

/** Медиана значений; 0 - значений нет. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Выводы для команды по цифрам окна, как в скилле: ошибки сервиса, время шага, брошенные шаги и всплеск по дням,
 * автоматы, плохие исходы после шага, ветка обхода, неразобранные строки.
 */
export function featureFindings(p: FeatureProfile, s: FeatureStats, timeZone: string): FeatureFinding[] {
  const out: FeatureFinding[] = [];
  const step = (role: FeatureRole) => s.funnel.find((f) => f.role === role);
  const shown = step('shown');
  const success = step('success');
  const skip = step('skip');
  if (p.errors.length) {
    const total = Object.values(s.errors).reduce((a, b) => a + b, 0);
    if (total === 0) {
      out.push({ tone: 'good', title: 'Ошибок сервиса нет.', text: `За окно ни одной строки с ошибками: ${p.errors.map((e) => e.label.toLowerCase()).join(', ')}.` });
    } else {
      const parts = p.errors.filter((e) => s.errors[e.key]).map((e) => `${e.label.toLowerCase()}: ${fmtCount(s.errors[e.key])}`);
      out.push({ tone: 'warn', title: `Ошибки сервиса за окно: ${fmtCount(total)}.`, text: `${parts.join('; ')}.` });
    }
  }
  const t = s.timing;
  if (t?.n) {
    out.push({
      tone: (t.p90 ?? 0) < 30 ? 'good' : 'warn',
      title: `Время шага: медиана ${fmtSeconds(t.median)}, p90 ${fmtSeconds(t.p90)}.`,
      text: `${t.label}, обычные сессии без автоматов, измерений: ${fmtCount(t.n)}.`,
    });
  }
  if (shown && success && shown.sessionsNormal) {
    const lost = shown.sessionsNormal - success.sessionsNormal;
    const days = Object.entries(s.abandonedByDay).sort(([a], [b]) => a.localeCompare(b));
    let spike: [string, number] | null = null;
    const med = median(days.map(([, v]) => v));
    if (days.length >= 3) for (const [d, v] of days) if (v > Math.max(3 * med, 50)) spike = [d, v];
    let text = `${fmtCount(lost)} из ${fmtCount(shown.sessionsNormal)} обычных сессий увидели шаг и не завершили его (${((lost / shown.sessionsNormal) * 100).toFixed(1)}%).`;
    if (spike) text += ` Из них ${fmtCount(spike[1])} пришлись на ${spike[0].slice(8, 10)}.${spike[0].slice(5, 7)}, это всплеск относительно остальных дней (медиана ${fmtCount(med)} в день).`;
    out.push({ tone: lost / shown.sessionsNormal > 0.1 || spike ? 'warn' : 'good', title: `Не завершили шаг: ${fmtCount(lost)}.`, text });
  }
  const a = s.automation;
  const top = a.rows[0];
  if (a.count && top) {
    const label = p.stages.find((st) => st.key === a.stage)?.label ?? a.stage ?? '';
    let text =
      `Сессий с ${a.threshold} и более повторами шага "${label}": ${fmtCount(a.count)}, повторов в них ${fmtCount(a.shownLines)}, успехов ${fmtCount(a.successLines)}. ` +
      `Самая активная: повторов ${fmtCount(top.shows)}, успехов ${fmtCount(top.success)}, ${localStamp(top.first, timeZone)} - ${localStamp(top.last, timeZone)}.`;
    if (s.login) text += ` Из них дошли до входа: ${fmtCount(s.login.reachedAutomation)}.`;
    out.push({ tone: 'bad', title: `Автоматы: ${fmtCount(a.count)}.`, text });
  }
  const ds = s.downstream;
  if (ds?.total && p.downstream) {
    for (const o of p.downstream.outcomes) {
      const n = ds.counts[o.key];
      if (o.tone !== 'bad' || !n) continue;
      out.push({
        tone: 'warn',
        title: `${o.label}: ${fmtCount(n)} из ${fmtCount(ds.total)}.`,
        text: `Запросы, где шаг "${p.stages.find((st) => st.key === ds.from)?.label ?? ds.from}" завершен успешно, а следом пришел этот исход (${((n / ds.total) * 100).toFixed(1)}%).`,
      });
    }
  }
  if (skip?.sessions) {
    let text = `Сессии ветки "${skip.label.toLowerCase()}" в успешные не попадают.`;
    if (s.overlapSkipSuccess) text += ` Сессий и с этой веткой, и с успехом: ${fmtCount(s.overlapSkipSuccess)}.`;
    out.push({ tone: 'neutral', title: `${skip.label}: ${fmtCount(skip.sessions)}.`, text });
  }
  if (s.unparsed) {
    out.push({
      tone: 'neutral',
      title: `Строк не разобрано: ${fmtCount(s.unparsed)}.`,
      text: 'Строки лога с битой кодировкой или без сессии в подсчет по сессиям не вошли, в дневных итогах они есть.',
    });
  }
  return out;
}

/** Итоги дня фичи: строк по baseline, стадиям и ошибкам и пометка ("с 11:11", "до 14:05"). */
export interface FeatureDay {
  day: string;
  counts: Record<string, number>;
  note: string | null;
}

/**
 * Сливает дневные итоги из логов с историей, как скилл: дни раньше since не берутся; день без строк baseline, который
 * уже есть в истории, не трогается - индекс его больше не хранит; у сегодняшнего дня пометка "до ЧЧ:ММ", у прошедших
 * она снимается; у since - пометка профиля. Возвращает дни, которые надо записать.
 */
export function mergeFeatureDays(
  p: FeatureProfile,
  history: Map<string, FeatureDay>,
  daily: Record<string, Record<string, number>>,
  today: string,
  nowLabel: string,
): FeatureDay[] {
  const changed = new Map<string, FeatureDay>();
  for (const [d, counts] of Object.entries(daily)) {
    if (d < p.since) continue;
    const old = history.get(d);
    if (!counts.baseline && old) continue;
    let note = old?.note ?? null;
    if (d === today) note = nowLabel;
    else if (note?.startsWith('до ') && d !== p.since) note = null;
    changed.set(d, { day: d, counts: { ...counts }, note });
  }
  if (p.sinceNote) {
    const base = changed.get(p.since) ?? history.get(p.since);
    if (base && base.note !== p.sinceNote) changed.set(p.since, { ...base, note: p.sinceNote });
  }
  return [...changed.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** История скилла feature-stats (history/<id>.json): дни с итогами и пометки. */
export const skillHistorySchema = z.object({ days: z.record(z.string(), z.record(z.string(), z.number())), notes: z.record(z.string(), z.string()).default({}) });

/** Дни истории скилла как итоги дней Task Pilot. */
export function daysFromSkillHistory(source: unknown): FeatureDay[] {
  const h = skillHistorySchema.parse(source);
  return Object.entries(h.days)
    .filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .map(([d, counts]) => ({ day: d, counts, note: h.notes[d] ?? null }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
