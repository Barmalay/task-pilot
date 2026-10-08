import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/);
const phrase = z.string().min(1).max(300);
const DURATION = /^(\d+)(s|m|h|d)$/;
const duration = z.string().regex(DURATION, 'длительность вида 30s, 15m, 1h или 7d');

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Длительность вида 30s, 15m, 1h, 7d в миллисекундах. */
export function durationMs(value: string): number {
  const m = DURATION.exec(value);
  if (!m) throw new Error(`Некорректная длительность ${value}`);
  const unit = { s: SECOND, m: MINUTE, h: HOUR, d: DAY }[m[2] as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

/** Поле имени контейнера и поле времени записи в логах прода по умолчанию: так их называет filebeat в Kubernetes. */
export const DEFAULT_CONTAINER_FIELD = 'kubernetes.container.name.keyword';
export const DEFAULT_TIME_FIELD = '@timestamp';

/** Сервис панели мониторинга: где лежат его строки и как называются поля (у разных сервисов они разные). */
export const monitorServiceSchema = z.strictObject({
  id,
  title: z.string().min(1),
  index: z.string().min(1),
  /** Имя контейнера: точный фильтр по полю контейнера (fields.container). */
  container: z.string().min(1),
  fields: z.strictObject({
    /** Текст строки: по нему ищутся фразы. */
    message: z.string().min(1),
    level: z.string().min(1),
    logger: z.string().min(1),
    /** Версия сервиса (тег образа или версия приложения): по ее смене видны деплои. */
    version: z.string().min(1),
    pod: z.string().min(1),
    /** Трасса запроса внутри сервиса. */
    trace: z.string().optional(),
    /** Поле имени контейнера, агрегируемое; без него kubernetes.container.name.keyword. */
    container: z.string().min(1).optional(),
    /** Поле времени записи; без него @timestamp. */
    time: z.string().min(1).optional(),
  }),
  /** Поля с идентификаторами попытки входа помимо текста строки, например flowState. */
  ids: z.array(z.string().min(1)).default([]),
  /** Id data view в Kibana прода: без него ссылок в Discover нет. */
  dataView: z.string().optional(),
});

export type MonitorServiceProfile = z.infer<typeof monitorServiceSchema>;

/** Панель мониторинга: источник логов прода и сервисы, monitor.yaml слоя компании и пакета команды. */
export const monitorProfileSchema = z
  .strictObject({
    source: z.strictObject({
      id,
      /** MCP-сервер из ~/.claude.json, в env которого адрес кластера (ES_URL) и ключ только на чтение (ES_API_KEY). */
      mcp: z.string().min(1),
      /** Kibana прода над тем же кластером: из нее ссылки в Discover. */
      kibana: z.url().optional(),
    }),
    services: z.array(monitorServiceSchema).min(1),
    /** Задачи в статусе мониторинга: попадают на обзор сами, даже без дашборда. */
    tasksJql: z.string().min(1).optional(),
    /** Часовой пояс команды: в нем считаются дни и часы воронок фич. */
    timeZone: z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'неизвестный часовой пояс, нужен вида Europe/Moscow')
      .default('UTC'),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.services.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['services', i, 'id'], message: `сервис ${s.id} описан дважды` });
      seen.add(s.id);
    });
  });

export type MonitorProfile = z.infer<typeof monitorProfileSchema>;

const phraseFilter = {
  /** Все фразы должны быть в тексте строки. */
  match: z.array(phrase).default([]),
  /** Хотя бы одна из фраз. */
  any: z.array(phrase).default([]),
  /** Ни одной из фраз. */
  not: z.array(phrase).default([]),
  /** Уровни строки, например WARN и ERROR. */
  level: z.array(z.string().min(1)).default([]),
};

/** Отбор строк по фразам и уровню. */
export const phraseFilterSchema = z.strictObject(phraseFilter);

export type PhraseFilter = z.infer<typeof phraseFilterSchema>;

const panelBase = {
  id,
  title: z.string().min(1),
  hint: z.string().optional(),
  /** Сервис панели, если он не тот, что у дашборда. */
  service: id.optional(),
  ...phraseFilter,
};

/** По какому полю разбивать строки: поле профиля сервиса или слово из текста после префикса. */
export const breakdownSchema = z.union([z.enum(['level', 'logger', 'version', 'pod']), z.strictObject({ extract: phrase })]);

export type Breakdown = z.infer<typeof breakdownSchema>;

/**
 * Панель дашборда. stat - число строк за период с изменением к прошлому периоду, timeseries - строки по времени
 * (одна линия или по линии на срез split), share - доля строк part от строк of по времени, top - самые частые значения
 * поля или слова из текста, numbers - распределение числа из текста строки, lines - свежие строки.
 */
export const panelSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...panelBase, type: z.literal('stat') }),
  z.strictObject({
    ...panelBase,
    type: z.literal('timeseries'),
    split: z.array(z.strictObject({ label: z.string().min(1), ...phraseFilter })).max(8).default([]),
  }),
  z.strictObject({ ...panelBase, type: z.literal('share'), part: phraseFilterSchema, of: phraseFilterSchema }),
  z.strictObject({ ...panelBase, type: z.literal('top'), by: breakdownSchema, size: z.number().int().min(1).max(20).default(10) }),
  z.strictObject({ ...panelBase, type: z.literal('numbers'), extract: phrase, interval: z.number().positive().default(10) }),
  z.strictObject({ ...panelBase, type: z.literal('lines'), size: z.number().int().min(1).max(100).default(30) }),
]);

export type Panel = z.infer<typeof panelSchema>;
export type PanelType = Panel['type'];

/** Панели, у которых есть одно число за окно: по ним работают алерты и цифры обзора. */
const METRIC_PANELS: PanelType[] = ['stat', 'timeseries', 'share'];

const alertBase = {
  id,
  panel: id,
  title: z.string().optional(),
  /** Окно, за которое считается величина. */
  window: duration.default('15m'),
};

/**
 * Алерт по панели. zero - ни одной строки за окно, above - величина выше порога (доля у share, число у остальных),
 * spike - величина за окно выше средней за базовый период в factor раз. min - сколько строк нужно для решения: у доли
 * в знаменателе, у всплеска за окно; у числа строк выше порога он не действует.
 */
export const alertSchema = z.discriminatedUnion('when', [
  z.strictObject({ ...alertBase, when: z.literal('zero') }),
  z.strictObject({ ...alertBase, when: z.literal('above'), value: z.number().nonnegative(), min: z.number().int().nonnegative().default(20) }),
  z.strictObject({
    ...alertBase,
    when: z.literal('spike'),
    baseline: duration.default('7d'),
    factor: z.number().gt(1).default(3),
    min: z.number().int().nonnegative().default(20),
  }),
]);

export type Alert = z.infer<typeof alertSchema>;

/** Интервалы опроса дашборда; off - опрос и алерты выключены. */
export const REFRESH_OPTIONS = ['15s', '30s', '1m', '5m', 'off'] as const;
export type Refresh = (typeof REFRESH_OPTIONS)[number];

/** Дашборд задачи: dashboards/<id>/dashboard.yaml. Главная единица - задача, эпик собирает дашборды его задач. */
export const dashboardSchema = z
  .strictObject({
    id,
    title: z.string().min(1),
    description: z.string().optional(),
    /** Задача, которую мониторит дашборд. */
    task: issueKey,
    /** Эпик задачи; без него берется из Jira. */
    epic: issueKey.optional(),
    /** Задачи, чьи изменения видны на дашборде, например задача реализации рядом с задачей мониторинга. */
    related: z.array(issueKey).default([]),
    /** Сервис панелей по умолчанию. */
    service: id,
    refresh: z.enum(REFRESH_OPTIONS).default('30s'),
    /** Панели, чьи цифры видны на карточке обзора; без списка - первые две панели с числом. */
    headline: z.array(id).max(3).optional(),
    panels: z.array(panelSchema).min(1).max(24),
    alerts: z.array(alertSchema).default([]),
  })
  .superRefine((d, ctx) => {
    const panels = new Map<string, Panel>();
    d.panels.forEach((p, i) => {
      if (panels.has(p.id)) ctx.addIssue({ code: 'custom', path: ['panels', i, 'id'], message: `панель ${p.id} описана дважды` });
      panels.set(p.id, p);
      if (p.type === 'share' && !hasFilter(p.of)) ctx.addIssue({ code: 'custom', path: ['panels', i, 'of'], message: 'у доли нужен отбор строк of' });
    });
    const alerts = new Set<string>();
    d.alerts.forEach((a, i) => {
      if (alerts.has(a.id)) ctx.addIssue({ code: 'custom', path: ['alerts', i, 'id'], message: `алерт ${a.id} описан дважды` });
      alerts.add(a.id);
      const panel = panels.get(a.panel);
      if (!panel) ctx.addIssue({ code: 'custom', path: ['alerts', i, 'panel'], message: `нет панели ${a.panel}` });
      else if (!METRIC_PANELS.includes(panel.type)) ctx.addIssue({ code: 'custom', path: ['alerts', i, 'panel'], message: `алерт считается только по панелям ${METRIC_PANELS.join(', ')}` });
    });
    (d.headline ?? []).forEach((h, i) => {
      const panel = panels.get(h);
      if (!panel || !METRIC_PANELS.includes(panel.type)) ctx.addIssue({ code: 'custom', path: ['headline', i], message: `на обзоре только панели с числом, ${h} не подходит` });
    });
  });

export type Dashboard = z.infer<typeof dashboardSchema>;

function hasFilter(f: PhraseFilter): boolean {
  return f.match.length + f.any.length + f.not.length + f.level.length > 0;
}

/** Отбор строк запроса: фразы в тексте, группы "хотя бы одна из", исключения, уровни и точные значения полей. */
export interface LogFilter {
  match: string[];
  anyOf: string[][];
  not: string[];
  level: string[];
  /** Поле должно иметь одно из значений, например трассу из списка; поле агрегируемое (.keyword). */
  terms?: { field: string; values: string[] }[];
}

/** Отбор из фраз дашборда. */
export function filterOf(f: Partial<PhraseFilter>): LogFilter {
  return { match: [...(f.match ?? [])], anyOf: f.any?.length ? [[...f.any]] : [], not: [...(f.not ?? [])], level: [...(f.level ?? [])] };
}

/** Уровень, которого нет ни у одной строки: так отбор с непересекающимися уровнями не находит ничего. */
const NO_LEVEL = '-';

/** Строки, прошедшие оба отбора; уровни пересекаются, если заданы в обоих. */
export function andFilter(a: LogFilter, b: LogFilter): LogFilter {
  const both = a.level.length > 0 && b.level.length > 0;
  const common = a.level.filter((l) => b.level.includes(l));
  const level = both ? (common.length ? common : [NO_LEVEL]) : [...a.level, ...b.level];
  const terms = [...(a.terms ?? []), ...(b.terms ?? [])];
  return { match: [...a.match, ...b.match], anyOf: [...a.anyOf, ...b.anyOf], not: [...a.not, ...b.not], level, ...(terms.length ? { terms } : {}) };
}

/** Файл мониторинга, который правится по запросу: дашборд, профиль фичи или профиль пути попытки. */
export type MonitorTarget = { kind: 'dashboard'; id: string } | { kind: 'feature'; id: string } | { kind: 'attempt' };

const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Цель правки из строки dashboard:<id>, feature:<id> или attempt; null - строка не такая. */
export function parseMonitorTarget(value: string): MonitorTarget | null {
  if (value === 'attempt') return { kind: 'attempt' };
  const m = /^(dashboard|feature):(.+)$/.exec(value);
  return m && TARGET_ID.test(m[2]!) ? { kind: m[1] as 'dashboard' | 'feature', id: m[2]! } : null;
}

/** Строка цели правки: так она хранится в базе и приходит в API. */
export function targetKey(t: MonitorTarget): string {
  return t.kind === 'attempt' ? 'attempt' : `${t.kind}:${t.id}`;
}

/** Строка лога для людей: время, уровень, логгер, текст и откуда она. */
export interface LogLine {
  service: string;
  /** Время строки, мс. */
  t: number;
  level: string;
  logger: string;
  message: string;
  pod: string;
  version: string;
  trace?: string;
  /** Значения полей-идентификаторов профиля сервиса и полей, по которым искали строку. */
  ids?: Record<string, string>;
  /** Значения полей для экрана, которые просил запрос (extra). */
  fields?: Record<string, string>;
}

interface RequestBase {
  service: MonitorServiceProfile;
  filter: LogFilter;
  /** Начало окна включительно и конец не включительно, мс. */
  from: number;
  to: number;
  /** Сколько можно отдавать ответ из кэша, мс; без поля - короткий кэш источника. */
  cacheMs?: number;
}

/** Запрос к логам прода: всегда в границах времени, строки - только небольшой порцией. */
export type LogRequest =
  | (RequestBase & { kind: 'count' })
  | (RequestBase & { kind: 'histogram'; bucketMs: number })
  | (RequestBase & { kind: 'terms'; by: Breakdown; size: number })
  | (RequestBase & { kind: 'numbers'; extract: string; interval: number })
  | (RequestBase & { kind: 'lines'; size: number })
  | (RequestBase & { kind: 'versions' })
  /**
   * Строки, где есть любое из значений values: точным значением в полях fields или, если text, фразой в тексте строки;
   * по времени от старых к новым, не больше size (до 10000), extra - поля строки для экрана; capped - под отбор попало
   * больше.
   */
  | (RequestBase & { kind: 'match'; values: string[]; fields: string[]; text: boolean; size: number; extra?: string[] })
  /** Строк по каждому правилу rules за каждый день окна в часовом поясе timeZone. */
  | (RequestBase & { kind: 'daily'; rules: Record<string, LogFilter>; timeZone: string })
  /** Строки под отбором по времени от старых к новым, не больше size (до 10000): capped - под отбор попало больше. */
  | (RequestBase & { kind: 'docs'; size: number });

/** Ответ на запрос того же вида. */
export type LogResult =
  | { kind: 'count'; count: number }
  | { kind: 'histogram'; buckets: { t: number; n: number }[] }
  | { kind: 'terms'; terms: { key: string; n: number }[]; other: number; sample?: number }
  | { kind: 'numbers'; buckets: { x: number; n: number }[]; sample?: number }
  | { kind: 'lines'; lines: LogLine[] }
  | { kind: 'versions'; versions: { key: string; first: number; last: number; n: number }[] }
  | { kind: 'match'; lines: LogLine[]; capped: boolean }
  | { kind: 'daily'; days: Record<string, Record<string, number>> }
  | { kind: 'docs'; lines: LogLine[]; capped: boolean }
  | { kind: 'error'; message: string };

/** Нагрузка панели на источник логов за последние минуты. */
export interface MonitorStats {
  /** Окно, за которое посчитано, мс. */
  windowMs: number;
  /** HTTP-запросов к кластеру. */
  calls: number;
  /** Поисков в них (в одном _msearch их несколько). */
  searches: number;
  /** Ответов из кэша без запроса к кластеру. */
  cached: number;
  errors: number;
  /** Среднее время поиска на кластере, мс. */
  avgTookMs: number | null;
  lastError: string | null;
}

/** Периоды дашборда. */
export const PERIODS = { '15m': 15 * MINUTE, '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '7d': 7 * DAY } as const;
export type Period = keyof typeof PERIODS;

/** Шаг корзин графика за период: около сотни точек, не мельче минуты. */
export function bucketOf(periodMs: number): number {
  if (periodMs <= HOUR) return MINUTE;
  if (periodMs <= 6 * HOUR) return 5 * MINUTE;
  if (periodMs <= DAY) return 15 * MINUTE;
  return 2 * HOUR;
}

/** Окно времени. */
export interface TimeRange {
  from: number;
  to: number;
}

/**
 * Окно периода, которое кончается на ближайшей следующей границе шага endStep (по умолчанию минута), а начало выровнено
 * по корзинам: одинаковые запросы в пределах шага совпадают и берутся из кэша, а прошлые корзины у разных опросов совпадают.
 */
export function rangeOf(now: number, periodMs: number, bucketMs = bucketOf(periodMs), endStep = MINUTE): TimeRange {
  const to = Math.ceil(now / endStep) * endStep;
  return { from: Math.floor((to - periodMs) / bucketMs) * bucketMs, to };
}

/** Сервис по id; ошибка, если его нет в профиле. */
export function serviceOf(services: MonitorServiceProfile[], serviceId: string): MonitorServiceProfile {
  const s = services.find((x) => x.id === serviceId);
  if (!s) throw new Error(`Нет сервиса ${serviceId} в monitor.yaml`);
  return s;
}

/** Сервисы, которых дашборд ждет, а в профиле их нет. */
export function unknownServices(d: Dashboard, services: MonitorServiceProfile[]): string[] {
  const known = new Set(services.map((s) => s.id));
  return [...new Set([d.service, ...d.panels.map((p) => p.service ?? d.service)])].filter((s) => !known.has(s));
}

/** Сервис панели. */
export function panelService(d: Dashboard, p: Panel, services: MonitorServiceProfile[]): MonitorServiceProfile {
  return serviceOf(services, p.service ?? d.service);
}

/**
 * Значение панели для интерфейса. sample у top и numbers - доля строк в случайной выборке, по которой источник оценил
 * значения (разбор текста по всем строкам дорог); без поля посчитано по всем строкам.
 */
export type PanelValue =
  | { type: 'stat'; value: number; previous: number }
  | { type: 'timeseries'; series: { label: string; total: number; points: { t: number; n: number }[] }[] }
  | { type: 'share'; part: number; of: number; ratio: number | null; points: { t: number; part: number; of: number; ratio: number | null }[] }
  | { type: 'top'; items: { key: string; n: number }[]; other: number; sample?: number }
  | { type: 'numbers'; buckets: { x: number; n: number }[]; sample?: number }
  | { type: 'lines'; lines: LogLine[] }
  | { type: 'error'; message: string };

/** Запросы панели и разбор их ответов: оба в одном месте, чтобы порядок не разошелся. */
export interface PanelPlan {
  requests: LogRequest[];
  value(results: LogResult[]): PanelValue;
}

/** Кэш запросов, которые разбирают текст строк runtime-полем: они дороже остальных. */
const EXTRACT_CACHE = 5 * MINUTE;

function failed(results: LogResult[]): string | null {
  const e = results.find((r) => r.kind === 'error');
  return e?.kind === 'error' ? e.message : null;
}

function pick<K extends LogResult['kind']>(r: LogResult | undefined, kind: K): Extract<LogResult, { kind: K }> {
  if (!r || r.kind !== kind) throw new Error(`Источник логов ответил не тем видом: ждали ${kind}, пришел ${r?.kind ?? 'пустой ответ'}`);
  return r as Extract<LogResult, { kind: K }>;
}

const sum = (points: { n: number }[]) => points.reduce((a, p) => a + p.n, 0);

/** Запросы панели за окно и разбор ответов. */
export function planPanel(d: Dashboard, p: Panel, services: MonitorServiceProfile[], range: TimeRange, bucketMs = bucketOf(range.to - range.from)): PanelPlan {
  const service = panelService(d, p, services);
  const base = { service, from: range.from, to: range.to };
  // У share отбор самой панели - общая часть для part и of.
  const filter = filterOf(p);
  const guard =
    (read: (results: LogResult[]) => PanelValue) =>
    (results: LogResult[]): PanelValue => {
      const message = failed(results);
      return message ? { type: 'error', message } : read(results);
    };
  switch (p.type) {
    case 'stat': {
      const span = range.to - range.from;
      return {
        requests: [
          { ...base, kind: 'count', filter },
          { ...base, kind: 'count', filter, from: range.from - span, to: range.from },
        ],
        value: guard((r) => ({ type: 'stat', value: pick(r[0], 'count').count, previous: pick(r[1], 'count').count })),
      };
    }
    case 'timeseries': {
      const series = p.split.length ? p.split.map((s) => ({ label: s.label, filter: andFilter(filter, filterOf(s)) })) : [{ label: p.title, filter }];
      return {
        requests: series.map((s) => ({ ...base, kind: 'histogram', filter: s.filter, bucketMs })),
        value: guard((r) => ({
          type: 'timeseries',
          series: series.map((s, i) => {
            const points = pick(r[i], 'histogram').buckets;
            return { label: s.label, total: sum(points), points };
          }),
        })),
      };
    }
    case 'share':
      return {
        requests: [
          { ...base, kind: 'histogram', filter: andFilter(filter, filterOf(p.part)), bucketMs },
          { ...base, kind: 'histogram', filter: andFilter(filter, filterOf(p.of)), bucketMs },
        ],
        value: guard((r) => {
          const part = pick(r[0], 'histogram').buckets;
          const of = pick(r[1], 'histogram').buckets;
          const ofAt = new Map(of.map((b) => [b.t, b.n]));
          const points = part.map((b) => {
            const total = ofAt.get(b.t) ?? 0;
            return { t: b.t, part: b.n, of: total, ratio: total ? b.n / total : null };
          });
          const partSum = sum(part);
          const ofSum = sum(of);
          return { type: 'share', part: partSum, of: ofSum, ratio: ofSum ? partSum / ofSum : null, points };
        }),
      };
    case 'top':
      return {
        requests: [{ ...base, kind: 'terms', filter, by: p.by, size: p.size, ...(typeof p.by === 'object' ? { cacheMs: EXTRACT_CACHE } : {}) }],
        value: guard((r) => {
          const t = pick(r[0], 'terms');
          return { type: 'top', items: t.terms, other: t.other, ...(t.sample !== undefined ? { sample: t.sample } : {}) };
        }),
      };
    case 'numbers':
      return {
        requests: [{ ...base, kind: 'numbers', filter, extract: p.extract, interval: p.interval, cacheMs: EXTRACT_CACHE }],
        value: guard((r) => {
          const n = pick(r[0], 'numbers');
          return { type: 'numbers', buckets: n.buckets, ...(n.sample !== undefined ? { sample: n.sample } : {}) };
        }),
      };
    case 'lines':
      return {
        requests: [{ ...base, kind: 'lines', filter, size: p.size, cacheMs: MINUTE }],
        value: guard((r) => ({ type: 'lines', lines: pick(r[0], 'lines').lines })),
      };
  }
}

/** Отборы величины панели: у share доля part от of, у остальных число строк отбора панели. */
export function metricFilters(p: Panel): { part: LogFilter; of: LogFilter | null } {
  const filter = filterOf(p);
  if (p.type === 'share') return { part: andFilter(filter, filterOf(p.part)), of: andFilter(filter, filterOf(p.of)) };
  return { part: filter, of: null };
}

/** Панели на карточке обзора: заданные в headline или первые две панели с числом. */
export function headlinePanels(d: Dashboard): Panel[] {
  const metric = d.panels.filter((p) => METRIC_PANELS.includes(p.type));
  if (d.headline?.length) return d.headline.map((h) => metric.find((p) => p.id === h)).filter((p): p is Panel => !!p);
  return metric.slice(0, 2);
}

/** Шаг, с которым обновляются сутки на карточке обзора. */
const DAY_STEP = 5 * MINUTE;

/** Цифры панели на обзоре: за час, за сутки и почасовой мини-график за сутки. */
export interface Headline {
  panel: string;
  title: string;
  /** Доля у share, число строк у остальных. */
  kind: 'count' | 'ratio';
  hour: number | null;
  day: number | null;
  spark: (number | null)[];
  error?: string;
}

/** Запросы цифр панели для обзора и их разбор. */
export function planHeadline(d: Dashboard, p: Panel, services: MonitorServiceProfile[], now: number): { requests: LogRequest[]; value(results: LogResult[]): Headline } {
  const service = panelService(d, p, services);
  const { part, of } = metricFilters(p);
  const hour = rangeOf(now, HOUR, MINUTE);
  // Сутки для мини-графика обновляются раз в пять минут: чаще карточке обзора не нужно, а запрос за сутки дороже.
  const day = { ...rangeOf(now, DAY, HOUR, DAY_STEP), cacheMs: DAY_STEP };
  const requests: LogRequest[] = [
    { service, filter: part, ...hour, kind: 'count' },
    { service, filter: part, ...day, kind: 'histogram', bucketMs: HOUR },
  ];
  if (of) requests.push({ service, filter: of, ...hour, kind: 'count' }, { service, filter: of, ...day, kind: 'histogram', bucketMs: HOUR });
  return {
    requests,
    value(results) {
      const kind = of ? 'ratio' : 'count';
      const message = failed(results);
      if (message) return { panel: p.id, title: p.title, kind, hour: null, day: null, spark: [], error: message };
      // Начало окна выровнено по часу, поэтому первая корзина может начинаться раньше суток назад: она не считается.
      const lastDay = (buckets: { t: number; n: number }[]) => buckets.filter((b) => b.t >= day.to - DAY);
      const partHour = pick(results[0], 'count').count;
      const partDay = lastDay(pick(results[1], 'histogram').buckets);
      if (!of) return { panel: p.id, title: p.title, kind, hour: partHour, day: sum(partDay), spark: partDay.map((b) => b.n) };
      const ofHour = pick(results[2], 'count').count;
      const ofDay = lastDay(pick(results[3], 'histogram').buckets);
      const ofAt = new Map(ofDay.map((b) => [b.t, b.n]));
      const ratio = (a: number, b: number) => (b ? a / b : null);
      return {
        panel: p.id,
        title: p.title,
        kind,
        hour: ratio(partHour, ofHour),
        day: ratio(sum(partDay), sum(ofDay)),
        spark: partDay.map((b) => ratio(b.n, ofAt.get(b.t) ?? 0)),
      };
    },
  };
}

/** Состояние алерта: сработал, в норме или данных мало для решения. */
export type AlertState = 'firing' | 'ok' | 'nodata';

/** Итог проверки алерта. */
export interface AlertOutcome {
  state: AlertState;
  /** Величина за окно: доля у share, число строк у остальных. */
  value: number | null;
  /** Порог, с которым сравнивали. */
  threshold: number | null;
  /** Что проверено, для людей. */
  text: string;
}

/** Длительность для людей: 30 с, 15 мин, 1 ч, 7 дн. */
export function durationText(value: string): string {
  const m = DURATION.exec(value);
  return m ? `${m[1]} ${{ s: 'с', m: 'мин', h: 'ч', d: 'дн' }[m[2] as 's' | 'm' | 'h' | 'd']}` : value;
}

/** Доля в процентах с запятой и без лишних нулей: 5%, 0,5%. */
const pct = (x: number) => `${String(Number((x * 100).toFixed(2))).replace('.', ',')}%`;

/** Описание алерта для людей. */
export function alertText(a: Alert, p: Panel): string {
  if (a.title) return a.title;
  const what = `"${p.title}"`;
  const window = durationText(a.window);
  if (a.when === 'zero') return `${what}: ни одной строки за ${window}`;
  if (a.when === 'above') return p.type === 'share' ? `${what} за ${window} выше ${pct(a.value)}` : `${what} за ${window} больше ${a.value}`;
  return `${what} за ${window} в ${String(a.factor).replace('.', ',')} раза выше средней за ${durationText(a.baseline)}`;
}

/**
 * Запросы проверки алерта и решение по ним. Базовая линия spike - гистограмма за baseline с корзиной в окно алерта,
 * она кэшируется на час: неделя по общему кластеру стоит дорого.
 */
export function planAlert(d: Dashboard, a: Alert, services: MonitorServiceProfile[], now: number): { requests: LogRequest[]; outcome(results: LogResult[]): AlertOutcome } {
  const panel = d.panels.find((p) => p.id === a.panel);
  if (!panel) throw new Error(`Алерт ${a.id}: нет панели ${a.panel}`);
  const service = panelService(d, panel, services);
  const { part, of } = metricFilters(panel);
  const windowMs = durationMs(a.window);
  const win = { from: Math.ceil(now / MINUTE) * MINUTE - windowMs, to: Math.ceil(now / MINUTE) * MINUTE };
  const requests: LogRequest[] = [{ service, filter: part, ...win, kind: 'count' }];
  if (of) requests.push({ service, filter: of, ...win, kind: 'count' });
  const baseline = a.when === 'spike' ? rangeOf(win.from, durationMs(a.baseline), windowMs) : null;
  if (baseline) {
    requests.push({ service, filter: part, ...baseline, kind: 'histogram', bucketMs: windowMs, cacheMs: HOUR });
    if (of) requests.push({ service, filter: of, ...baseline, kind: 'histogram', bucketMs: windowMs, cacheMs: HOUR });
  }
  const text = alertText(a, panel);
  return {
    requests,
    outcome(results) {
      const message = failed(results);
      if (message) return { state: 'nodata', value: null, threshold: null, text: `${text}: ${message}` };
      const count = pick(results[0], 'count').count;
      const total = of ? pick(results[1], 'count').count : null;
      const value = total === null ? count : total ? count / total : null;
      if (a.when === 'zero') return { state: count === 0 ? 'firing' : 'ok', value: count, threshold: 0, text };
      // Доля по горстке строк скачет, поэтому решение по доле и по всплеску принимается только при достаточном числе
      // строк. У числа строк выше порога минимума нет: оно само величина, и "больше 0" значит "хотя бы одна строка".
      const enough = (total ?? count) >= a.min;
      if (a.when === 'above') {
        if (value === null || (total !== null && !enough)) return { state: 'nodata', value, threshold: a.value, text };
        return { state: value > a.value ? 'firing' : 'ok', value, threshold: a.value, text };
      }
      const partBuckets = pick(results[of ? 2 : 1], 'histogram').buckets;
      const ofBuckets = of ? pick(results[3], 'histogram').buckets : null;
      const mean = ofBuckets ? (sum(ofBuckets) ? sum(partBuckets) / sum(ofBuckets) : null) : partBuckets.length ? sum(partBuckets) / partBuckets.length : null;
      if (value === null || mean === null || !enough) return { state: 'nodata', value, threshold: mean === null ? null : mean * a.factor, text };
      const threshold = mean * a.factor;
      return { state: value > threshold ? 'firing' : 'ok', value, threshold, text };
    },
  };
}

/** Отметка деплоя: версия сервиса и когда появилась ее первая строка. */
export interface DeployMark {
  service: string;
  version: string;
  at: number;
}

/**
 * Деплои за окно по смене версии: версия, чья первая строка позже начала окна, появилась в окне. Самая старая версия
 * окна деплоем не считается: она уже работала до его начала.
 */
export function deploysOf(service: string, versions: { key: string; first: number }[], range: TimeRange): DeployMark[] {
  const sorted = [...versions].sort((a, b) => a.first - b.first);
  return sorted
    .slice(1)
    .filter((v) => v.first >= range.from && v.first < range.to)
    .map((v) => ({ service, version: v.key.split(':').pop() ?? v.key, at: v.first }));
}

