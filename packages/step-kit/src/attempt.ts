import { z } from 'zod';
import { captureSchema, ruleMatches } from './funnel.ts';
import { durationMs, type LogLine } from './monitor.ts';

/**
 * Путь одной попытки входа по логам прода. Профиль пути (attempt.yaml пакета команды) называет сервисы пути,
 * идентификаторы попытки и что значат строки; чистые функции ниже связывают найденные строки в попытки и раскладывают
 * одну попытку в хронологию с итогом, этапами, ошибками и найденными значениями.
 *
 * Идентификаторы делятся по охвату: ключи попытки (state, correlationId) связывают строки одной попытки во всех
 * сервисах; признаки человека (accountId, userId, телефон) ищут строки рядом по времени, но попытки не склеивают, иначе
 * две попытки одного человека слились бы в одну; подробности (код, устройство, IP) только показываются. Телефон, код и
 * IP помечаются чувствительными: они видны только на экране, в базу, журналы и агентам не уходят.
 */

const key = z.string().regex(/^[a-z][a-z0-9_]*$/, 'ключ из строчных латинских букв, цифр и подчеркивания');
const phrase = z.string().min(1).max(300);
const duration = z.string().refine((v) => {
  try {
    durationMs(v);
    return true;
  } catch {
    return false;
  }
}, 'длительность вида 30s, 15m, 1h или 7d');

/** Поля, которые путь не берет из логов никогда: куки, заголовки, токены и пароли. */
export const FORBIDDEN_FIELD = /cookie|header|authorization|password|secret|token/i;
const field = z
  .string()
  .min(1)
  .refine((f) => !FORBIDDEN_FIELD.test(f), 'куки, заголовки, токены и пароли путь не показывает');

/** Охват идентификатора: ключ попытки, признак человека или подробность. */
export const ID_SCOPES = ['attempt', 'person', 'detail'] as const;

export type AttemptIdScope = (typeof ID_SCOPES)[number];

const idSchema = z.strictObject({
  key,
  label: z.string().min(1),
  /** Выражения с группой: значение в тексте строки любого сервиса. */
  patterns: z.array(captureSchema).default([]),
  /** Поле сервиса с точным значением: сервис - поле, например adapter - flowState.keyword. */
  fields: z.record(z.string(), field).default({}),
  /** Где искать строки по значению; без списка - во всех сервисах пути. */
  services: z.array(z.string().min(1)).optional(),
  scope: z.enum(ID_SCOPES).default('attempt'),
  /** Видно только на экране: телефон, код, IP. */
  sensitive: z.boolean().default(false),
  /** Как привести значение: phone - к 7XXXXXXXXXX. */
  normalize: z.enum(['phone']).optional(),
});

/** Что значит строка: шаг флоу, действие человека, ошибка, итог или служебная строка. */
export const EVENT_KINDS = ['step', 'action', 'error', 'outcome', 'info'] as const;

export type AttemptEventKind = (typeof EVENT_KINDS)[number];

const eventSchema = z
  .strictObject({
    key,
    label: z.string().min(1),
    kind: z.enum(EVENT_KINDS),
    /** Сервисы, строки которых проверяет правило; без списка - все. */
    services: z.array(z.string().min(1)).optional(),
    /** Логгер строки целиком. */
    logger: z.string().min(1).optional(),
    /** Фразы строки; без них правило подходит всем строкам своих сервисов или логгера. */
    any: z.array(phrase).default([]),
    all: z.array(phrase).default([]),
    not: z.array(phrase).default([]),
    /** Подробность из текста строки, например исход шага каскада. */
    detail: captureSchema.optional(),
    /** Провайдер входа из текста строки: значение сводится к провайдеру профиля по его values. */
    provider: captureSchema.optional(),
    /** Итог попытки, о котором говорит строка: последний такой итог - итог попытки. */
    outcome: z.enum(['success', 'failure']).optional(),
    /** Этап попытки: между этапами считается время. */
    milestone: z.boolean().default(false),
    /** Предлагается признаком в поиске попыток. */
    search: z.boolean().default(false),
  })
  .refine((e) => e.any.length > 0 || e.logger !== undefined || e.services !== undefined, 'правилу нужны фразы any, logger или services')
  .refine((e) => !e.search || e.any.length > 0, 'признаку поиска нужны фразы any: по ним ищутся строки');

const hideSchema = z
  .strictObject({
    services: z.array(z.string().min(1)).optional(),
    logger: z.string().min(1).optional(),
    any: z.array(phrase).default([]),
    all: z.array(phrase).default([]),
    not: z.array(phrase).default([]),
  })
  .refine((h) => h.logger || h.any.length, 'скрываемым строкам нужен logger или фразы any');

const serviceSchema = z.strictObject({
  /** Сервис панели мониторинга (monitor.yaml). */
  service: z.string().min(1),
  /** Поля строки для экрана: страница, маршрут, статус ответа. */
  fields: z.array(z.strictObject({ field, label: z.string().min(1) })).default([]),
  /** Подтягивать все строки трасс найденных строк: так видны строки без идентификаторов попытки. */
  traces: z.boolean().default(false),
});

/** Профиль пути одной попытки: attempt.yaml пакета команды. */
export const attemptProfileSchema = z
  .strictObject({
    title: z.string().min(1),
    intro: z.string().min(1).optional(),
    /** Окно вокруг момента попытки, в котором ищутся первые строки. */
    window: duration.default('2h'),
    /** Запас вокруг найденных строк, в котором ищутся связанные строки. */
    margin: duration.default('15m'),
    services: z.array(serviceSchema).min(1),
    ids: z.array(idSchema).min(1),
    events: z.array(eventSchema).default([]),
    /** Служебные строки, которых на экране нет совсем. */
    hide: z.array(hideSchema).default([]),
    /** Провайдеры входа: подпись и значения из строк, которые к нему сводятся. */
    providers: z.array(z.strictObject({ key, label: z.string().min(1), values: z.array(z.string().min(1)).min(1) })).default([]),
  })
  .superRefine((p, ctx) => {
    const services = new Set<string>();
    p.services.forEach((s, i) => {
      if (services.has(s.service)) ctx.addIssue({ code: 'custom', path: ['services', i, 'service'], message: `сервис ${s.service} повторяется` });
      services.add(s.service);
    });
    const known = (list: string[] | undefined, path: (string | number)[]) => {
      for (const s of list ?? []) if (!services.has(s)) ctx.addIssue({ code: 'custom', path, message: `сервиса ${s} нет в services пути` });
    };
    const unique = (items: { key: string }[], name: string) => {
      const seen = new Set<string>();
      items.forEach((x, i) => {
        if (seen.has(x.key)) ctx.addIssue({ code: 'custom', path: [name, i, 'key'], message: `ключ ${x.key} повторяется` });
        seen.add(x.key);
      });
    };
    unique(p.ids, 'ids');
    unique(p.events, 'events');
    unique(p.providers, 'providers');
    p.ids.forEach((id, i) => {
      known(id.services, ['ids', i, 'services']);
      known(Object.keys(id.fields), ['ids', i, 'fields']);
      if (!id.patterns.length && !Object.keys(id.fields).length) ctx.addIssue({ code: 'custom', path: ['ids', i], message: 'идентификатору нужны patterns или fields' });
    });
    if (!p.ids.some((id) => id.scope === 'attempt')) ctx.addIssue({ code: 'custom', path: ['ids'], message: 'нужен хотя бы один ключ попытки (scope: attempt)' });
    p.events.forEach((e, i) => known(e.services, ['events', i, 'services']));
    p.hide.forEach((h, i) => known(h.services, ['hide', i, 'services']));
  });

export type AttemptProfile = z.infer<typeof attemptProfileSchema>;
export type AttemptId = AttemptProfile['ids'][number];
export type AttemptEventRule = AttemptProfile['events'][number];

/** Телефон из ввода человека: 11 цифр с 7 в начале; null - на номер не похоже. */
export function phoneDigits(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('9')) return `7${d}`;
  if (d.length === 11 && (d.startsWith('7') || d.startsWith('8'))) return `7${d.slice(1)}`;
  return null;
}

/** Телефон для экрана: +7 916 123-45-67. */
export function formatPhone(digits: string): string {
  const d = phoneDigits(digits);
  if (!d) return digits;
  return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

/** Телефон для агента и чата: +7 9** ***-**-67. */
export function maskPhone(digits: string): string {
  const d = phoneDigits(digits);
  return d ? `+7 ${d[1]}** ***-**-${d.slice(9)}` : '***';
}

/** Телефон в тексте: +7 или 8 и 10 цифр, с пробелами, скобками и дефисами или без них. */
const PHONE_IN_TEXT = /(?<![\d+])(?:\+7|8|7)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g;

/** Текст с телефонами маской, как их видит агент и как они ложатся в базу: +7 9** ***-**-67. */
export function maskPhones(text: string): string {
  return text.replace(PHONE_IN_TEXT, (m) => maskPhone(m));
}

/** Значение идентификатора как его ищут в логах; null - для этого идентификатора значение не годится. */
export function normalizeIdValue(id: Pick<AttemptId, 'normalize'>, value: string): string | null {
  const v = value.trim();
  if (id.normalize === 'phone') return phoneDigits(v);
  return v.length >= 4 && v.length <= 128 ? v : null;
}

const REGEXES = new Map<string, RegExp>();
function globalRe(source: string): RegExp {
  let re = REGEXES.get(source);
  if (!re) {
    re = new RegExp(source, 'g');
    REGEXES.set(source, re);
  }
  re.lastIndex = 0;
  return re;
}

/** Значение идентификатора, найденное в строке. */
export interface AttemptIdValue {
  key: string;
  value: string;
}

/** Значения идентификаторов строки: по выражениям в ее тексте и по полям ее сервиса, без повторов. */
export function lineIds(p: AttemptProfile, line: LogLine): AttemptIdValue[] {
  const out = new Map<string, AttemptIdValue>();
  const add = (id: AttemptId, raw: string | undefined) => {
    if (!raw) return;
    const value = normalizeIdValue(id, raw);
    if (value) out.set(`${id.key}\u0000${value}`, { key: id.key, value });
  };
  for (const id of p.ids) {
    for (const source of id.patterns) for (const m of line.message.matchAll(globalRe(source))) add(id, m[1]);
    const f = id.fields[line.service];
    if (f) add(id, line.ids?.[f] ?? line.fields?.[f]);
  }
  return [...out.values()];
}

const LOGBOOK = /^(?:Incoming Request|Outgoing Response|Outgoing Request|Incoming Response): /;
const HTTP_LINE = /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+|HTTP\/\d)/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]*: /;
const KEEP = /^(?:Duration|Request|RequestAuthType): /;

/**
 * Текст строки для экрана: у HTTP-строк Logbook убираются заголовки (в них куки, ключи и адреса клиента), остаются
 * первая строка, строка запроса или ответа, длительность и тело.
 */
export function cleanMessage(message: string): string {
  if (!LOGBOOK.test(message)) return message;
  const lines = message.split('\n');
  const out: string[] = [];
  let body = false;
  lines.forEach((l, i) => {
    if (i === 0 || body || KEEP.test(l) || HTTP_LINE.test(l)) out.push(l);
    else if (!l.trim()) {
      body = true;
      out.push(l);
    } else if (!HEADER.test(l)) out.push(l);
  });
  return out.join('\n').trimEnd();
}

/** Что значит строка по правилу профиля. */
export interface AttemptEventMatch {
  key: string;
  kind: AttemptEventKind;
  label: string;
  detail: string | null;
  provider: string | null;
  outcome: 'success' | 'failure' | null;
  milestone: boolean;
}

const applies = (services: string[] | undefined, logger: string | undefined, line: LogLine) => (!services || services.includes(line.service)) && (!logger || line.logger === logger);

/** Строка скрыта правилом hide профиля. */
export function hiddenLine(p: AttemptProfile, line: LogLine): boolean {
  return p.hide.some((h) => applies(h.services, h.logger, line) && (!h.any.length || ruleMatches(h, line.message)));
}

const PLAIN = new Map<string, RegExp>();
const captured = (source: string | undefined, text: string) => {
  if (!source) return null;
  let re = PLAIN.get(source);
  if (!re) PLAIN.set(source, (re = new RegExp(source)));
  return re.exec(text)?.[1] ?? null;
};

/** Провайдер профиля по значению из строки: подпись провайдера, а незнакомое значение - как есть. */
export function providerLabel(p: AttemptProfile, raw: string): string {
  const v = raw.toLowerCase();
  return p.providers.find((x) => x.values.some((y) => y.toLowerCase() === v))?.label ?? raw;
}

/** Первое правило событий профиля, под которое подходит строка; null - строка без разбора. */
export function classifyAttemptLine(p: AttemptProfile, line: LogLine): AttemptEventMatch | null {
  const e = p.events.find((x) => applies(x.services, x.logger, line) && ruleMatches(x, line.message));
  if (!e) return null;
  const provider = captured(e.provider, line.message);
  return {
    key: e.key,
    kind: e.kind,
    label: e.label,
    detail: captured(e.detail, line.message),
    provider: provider ? providerLabel(p, provider) : null,
    outcome: e.outcome ?? null,
    milestone: e.milestone,
  };
}

/** Уровни строк, которые считаются ошибкой и без правила профиля. */
const ERROR_LEVEL = /^(?:ERROR|FATAL|SEVERE|CRITICAL)$/i;

const lineKey = (l: LogLine) => `${l.service}\u0000${l.t}\u0000${l.message}`;

/** Строки без повторов, по времени. */
export function uniqueLines(lines: LogLine[]): LogLine[] {
  const seen = new Set<string>();
  return lines
    .filter((l) => {
      const k = lineKey(l);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.t - b.t);
}

/** Связность строк: номер компоненты каждой строки (-1 - строка ни с чем не связана) и есть ли в компоненте ключ попытки. */
export interface LineLinks {
  group: number[];
  keyed: boolean[];
}

/**
 * Связность строк: строки одной попытки связаны общим ключом попытки или общей трассой своего сервиса. Признаки
 * человека и подробности попытки строки не связывают. Компонента без ключа попытки - строки одного запроса без
 * идентификаторов попытки, например клиентские события по accountId.
 */
export function linkLines(p: AttemptProfile, lines: LogLine[]): LineLinks {
  const attemptKeys = new Set(p.ids.filter((id) => id.scope === 'attempt').map((id) => id.key));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const nodesOf = lines.map((l) => {
    const nodes = lineIds(p, l)
      .filter((v) => attemptKeys.has(v.key))
      .map((v) => `${v.key}:${v.value}`);
    if (l.trace) nodes.push(`trace:${l.service}:${l.trace}`);
    for (const n of nodes) if (!parent.has(n)) parent.set(n, n);
    for (let i = 1; i < nodes.length; i++) {
      const a = find(nodes[0]!);
      const b = find(nodes[i]!);
      if (a !== b) parent.set(b, a);
    }
    return nodes;
  });
  const index = new Map<string, number>();
  const keyed: boolean[] = [];
  const group = nodesOf.map((nodes) => {
    if (!nodes.length) return -1;
    const root = find(nodes[0]!);
    if (!index.has(root)) {
      index.set(root, index.size);
      keyed.push(false);
    }
    const g = index.get(root)!;
    if (nodes.some((n) => !n.startsWith('trace:'))) keyed[g] = true;
    return g;
  });
  return { group, keyed };
}

/** Строка хронологии попытки. */
export interface AttemptStep {
  t: number;
  service: string;
  level: string;
  logger: string;
  /** Текст для экрана: у HTTP-строк без заголовков. */
  message: string;
  trace?: string;
  /** Поля строки для экрана по подписям профиля. */
  fields: { label: string; value: string }[];
  event: AttemptEventMatch | null;
  /** Ошибка по правилу профиля или по уровню строки. */
  error: boolean;
  ids: AttemptIdValue[];
  /** От первой строки попытки и от предыдущей строки, мс. */
  sinceStart: number;
  sincePrev: number;
}

/** Этап попытки и время от предыдущего этапа. */
export interface AttemptMilestone {
  label: string;
  service: string;
  t: number;
  sincePrev: number | null;
}

/** Итог попытки: успех, отказ или итог в строках не найден. */
export type AttemptOutcome = 'success' | 'failure' | 'unknown';

/** Сводка попытки. */
export interface AttemptSummary {
  start: number | null;
  end: number | null;
  durationMs: number;
  outcome: AttemptOutcome;
  /** Строка, которая дала итог. */
  outcomeLabel: string | null;
  providers: string[];
  errors: { label: string; service: string; t: number }[];
  services: { service: string; lines: number; first: number; last: number }[];
  ids: { key: string; label: string; sensitive: boolean; scope: AttemptIdScope; values: string[] }[];
  milestones: AttemptMilestone[];
  /** Скрытых служебных строк. */
  hidden: number;
}

/** Хронология и сводка одной попытки по ее строкам. */
export interface AttemptPath {
  steps: AttemptStep[];
  summary: AttemptSummary;
}

/** Хронология попытки: строки по времени с разбором, временем от начала и от предыдущей строки, и сводка. */
export function attemptPath(p: AttemptProfile, lines: LogLine[]): AttemptPath {
  const labels = new Map(p.services.map((s) => [s.service, s.fields]));
  const visible: LogLine[] = [];
  let hidden = 0;
  for (const l of uniqueLines(lines)) {
    if (hiddenLine(p, l)) hidden++;
    else visible.push(l);
  }
  const start = visible[0]?.t ?? null;
  const steps: AttemptStep[] = visible.map((l, i) => {
    const event = classifyAttemptLine(p, l);
    return {
      t: l.t,
      service: l.service,
      level: l.level,
      logger: l.logger,
      message: cleanMessage(l.message),
      ...(l.trace ? { trace: l.trace } : {}),
      fields: (labels.get(l.service) ?? []).flatMap((f) => {
        const value = l.fields?.[f.field] ?? l.ids?.[f.field];
        return value ? [{ label: f.label, value }] : [];
      }),
      event,
      // Строка уровня ERROR без своего правила ошибки (без разбора или служебная) - тоже ошибка.
      error: event?.kind === 'error' || ((!event || event.kind === 'info') && ERROR_LEVEL.test(l.level)),
      ids: lineIds(p, l),
      sinceStart: l.t - start!,
      sincePrev: i ? l.t - visible[i - 1]!.t : 0,
    };
  });
  return { steps, summary: summaryOf(p, steps, hidden) };
}

function summaryOf(p: AttemptProfile, steps: AttemptStep[], hidden: number): AttemptSummary {
  const start = steps[0]?.t ?? null;
  const end = steps.at(-1)?.t ?? null;
  let outcome: AttemptOutcome = 'unknown';
  let outcomeLabel: string | null = null;
  const providers: string[] = [];
  const milestones: AttemptMilestone[] = [];
  const services = new Map<string, { service: string; lines: number; first: number; last: number }>();
  const values = new Map<string, string[]>();
  for (const s of steps) {
    const e = s.event;
    if (e?.outcome) {
      outcome = e.outcome;
      outcomeLabel = e.label;
    }
    if (e?.provider && !providers.includes(e.provider)) providers.push(e.provider);
    if (e?.milestone) milestones.push({ label: e.label, service: s.service, t: s.t, sincePrev: milestones.length ? s.t - milestones.at(-1)!.t : null });
    const svc = services.get(s.service) ?? { service: s.service, lines: 0, first: s.t, last: s.t };
    svc.lines++;
    svc.last = s.t;
    services.set(s.service, svc);
    for (const v of s.ids) {
      const list = values.get(v.key) ?? [];
      if (!list.includes(v.value)) list.push(v.value);
      values.set(v.key, list);
    }
  }
  return {
    start,
    end,
    durationMs: start !== null && end !== null ? end - start : 0,
    outcome,
    outcomeLabel,
    providers,
    errors: steps.filter((s) => s.error).map((s) => ({ label: s.event?.kind === 'error' ? s.event.label : s.message.split('\n')[0]!.slice(0, 160), service: s.service, t: s.t })),
    services: p.services.flatMap((x) => services.get(x.service) ?? []),
    ids: p.ids.flatMap((id) => (values.get(id.key) ? [{ key: id.key, label: id.label, sensitive: id.sensitive, scope: id.scope, values: values.get(id.key)! }] : [])),
    milestones,
    hidden,
  };
}

/** Попытка в списке поиска: ее строки и сводка. */
export interface AttemptGroup {
  lines: LogLine[];
  summary: AttemptSummary;
}

/** Компоненты с ключом попытки и строки без ключа (одиночные и строки одного запроса). */
function splitLinks(p: AttemptProfile, all: LogLine[]): { groups: Map<number, LogLine[]>; loose: LogLine[] } {
  const { group, keyed } = linkLines(p, all);
  const groups = new Map<number, LogLine[]>();
  const loose: LogLine[] = [];
  all.forEach((l, i) => {
    const g = group[i]!;
    if (g >= 0 && keyed[g]) groups.set(g, [...(groups.get(g) ?? []), l]);
    else loose.push(l);
  });
  return { groups, loose };
}

/** Ближайшая по времени компонента для строки без ключа: 0 - строка внутри ее отрезка; null - дальше margin. */
function nearest(groups: Map<number, LogLine[]>, l: LogLine, marginMs: number): number | null {
  let best: number | null = null;
  let gap = marginMs;
  for (const [g, lines] of groups) {
    const d = l.t < lines[0]!.t ? lines[0]!.t - l.t : l.t > lines.at(-1)!.t ? l.t - lines.at(-1)!.t : 0;
    if (d <= gap) {
      best = g;
      gap = d;
    }
  }
  return best;
}

/**
 * Попытки из найденных строк: компоненты связности с ключом попытки. Строки без ключа попытки (одиночные и строки
 * одного запроса) достаются ближайшей по времени попытке в пределах margin, остальные отбрасываются; если попыток с
 * ключом нет совсем, каждая такая строка - своя попытка. Новые попытки первыми.
 */
export function groupAttempts(p: AttemptProfile, lines: LogLine[], marginMs: number): AttemptGroup[] {
  const { groups, loose } = splitLinks(p, uniqueLines(lines));
  const newest = (a: AttemptGroup, b: AttemptGroup) => (b.summary.start ?? 0) - (a.summary.start ?? 0);
  if (!groups.size) return loose.map((l) => ({ lines: [l], summary: attemptPath(p, [l]).summary })).sort(newest);
  for (const l of loose) {
    const g = nearest(groups, l, marginMs);
    if (g !== null) groups.get(g)!.push(l);
  }
  return [...groups.values()].map((g) => ({ lines: uniqueLines(g), summary: attemptPath(p, g).summary })).sort(newest);
}

/**
 * Строки одной попытки среди строк, найденных по ее ключам и признакам человека: попытка - компоненты, в которых есть
 * значения seeds (ключ попытки или трасса), и строки без ключа попытки, ближайшая попытка к которым - эта; компоненты с
 * другими ключами - другие попытки того же человека, они возвращаются отдельно. Если ни одной строки с seeds нет,
 * попытка - все строки.
 */
export function selectAttempt(p: AttemptProfile, lines: LogLine[], seeds: Iterable<string>, marginMs: number): { lines: LogLine[]; others: AttemptGroup[] } {
  const all = uniqueLines(lines);
  const { groups, loose } = splitLinks(p, all);
  const wanted = new Set(seeds);
  const mine = new Set<number>();
  for (const [g, list] of groups) if (list.some((l) => (l.trace && wanted.has(l.trace)) || lineIds(p, l).some((v) => wanted.has(v.value)))) mine.add(g);
  if (!mine.size) return { lines: all, others: [] };
  const picked = [...mine].flatMap((g) => groups.get(g)!);
  for (const l of loose) {
    const g = nearest(groups, l, marginMs);
    if (g !== null && mine.has(g)) picked.push(l);
  }
  const rest = [...groups].filter(([g]) => !mine.has(g)).flatMap(([, list]) => list);
  return { lines: uniqueLines(picked), others: groupAttempts(p, rest, marginMs) };
}

/** Окно поиска вокруг момента попытки по профилю, мс. */
export function attemptWindow(p: AttemptProfile): { windowMs: number; marginMs: number } {
  return { windowMs: durationMs(p.window), marginMs: durationMs(p.margin) };
}
