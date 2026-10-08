import type { AttemptCandidateDto, AttemptPathDto, AttemptProfileDto, AttemptSearchDto } from '@task-pilot/api-types';
import {
  attemptPath,
  attemptProfileSchema,
  attemptWindow,
  DAY,
  filterOf,
  groupAttempts,
  lineIds,
  MINUTE,
  phoneDigits,
  ruleFilter,
  ruleMatches,
  selectAttempt,
  uniqueLines,
  type AttemptGroup,
  type AttemptOutcome,
  type AttemptProfile,
  type LogFilter,
  type LogLine,
  type LogRequest,
  type MonitorPort,
  type MonitorServiceProfile,
} from '@task-pilot/step-kit';
import { MonitorError } from './service.ts';

/** Окно поиска попыток не длиннее недели и по умолчанию - последние сутки. */
const SEARCH_MAX_MS = 7 * DAY;
const SEARCH_DEFAULT_MS = DAY;
/** Строк первого поиска на сервис и строк признака: признак дает последние попытки, а не все. */
const SEED_SIZE = 300;
const SIGN_SIZE = 100;
/** У скольких первых попыток списка дособираются строки по их ключам, чтобы были итог и провайдер. */
const ENRICH_ATTEMPTS = 30;
const ENRICH_KEYS = 60;
const ENRICH_SIZE = 2000;
const ENRICH_TRACES = 300;
const LIST_LIMIT = 50;
/** Круги пути: по новым идентификаторам и трассам, не больше значений за круг и всего, не больше строк. */
const ROUNDS = 4;
const ROUND_VALUES = 30;
const TOTAL_VALUES = 80;
const ROUND_TRACES = 60;
const ROUND_SIZE = 1000;
const TRACE_SIZE = 3000;
/** Строк трасс для списка попыток: один поиск отдает не больше 10000. */
const TRACE_LIMIT = 10_000;
const LINES_LIMIT = 4000;
const STEPS_LIMIT = 3000;
const CACHE_MS = MINUTE;
const VALUE = /^[A-Za-z0-9_.:@+-]{4,128}$/;

/** Запрос поиска попыток: значения идентификаторов, телефон, признак, провайдер и итог в окне. */
export interface AttemptQuery {
  ids: string[];
  phone?: string;
  /** Признак: event:<ключ события пути> или feature:<фича>:<стадия>. */
  sign?: string;
  provider?: string;
  outcome?: AttemptOutcome;
  from?: number;
  to?: number;
}

/** Путь попытки: значения, с которых начать, и момент попытки. */
export interface AttemptPathQuery {
  ids: string[];
  at?: number;
}

/**
 * Профиль пути по полям сервисов панели, когда attempt.yaml в пакете команды нет: идентификаторы в тексте строк (state,
 * flowState, correlationId) и поля-идентификаторы сервисов, трассы сервисов с полем трассы.
 */
export function defaultAttemptProfile(services: MonitorServiceProfile[]): AttemptProfile {
  return attemptProfileSchema.parse({
    title: 'Одна попытка входа',
    services: services.map((s) => ({ service: s.id, traces: Boolean(s.fields.trace) })),
    ids: [
      {
        key: 'id',
        label: 'идентификатор',
        patterns: ["(?:\\bstate|flowState|correlationId|correlation id)\\s*[=:]?\\s*'?([A-Za-z0-9_-]{16,64})"],
        fields: Object.fromEntries(services.filter((s) => s.ids[0]).map((s) => [s.id, s.ids[0]!])),
      },
    ],
  });
}

/** Отбор значимых строк: фразы событий-этапов, ошибок и итогов профиля. */
function notableFilter(p: AttemptProfile): LogFilter {
  const phrases = [...new Set(p.events.filter((e) => e.milestone || e.kind === 'error' || e.kind === 'outcome').flatMap((e) => e.any))];
  return phrases.length ? { match: [], anyOf: [phrases], not: [], level: [] } : filterOf({});
}

function candidateOf(g: AttemptGroup): AttemptCandidateDto {
  const s = g.summary;
  return {
    key: s.ids.find((i) => i.scope === 'attempt')?.values[0] ?? null,
    at: s.start ?? 0,
    end: s.end ?? 0,
    durationMs: s.durationMs,
    outcome: s.outcome,
    outcomeLabel: s.outcomeLabel,
    providers: s.providers,
    errors: [...new Set(s.errors.map((e) => e.label))].slice(0, 5),
    services: s.services.map((x) => x.service),
    ids: s.ids,
    milestones: s.milestones.map((m) => m.label),
  };
}

/**
 * Путь одной попытки входа по логам прода. Поиск дает список попыток по идентификаторам, телефону и признакам в окне,
 * путь - все строки одной попытки во всех сервисах: от значений, с которых начали, круг за кругом по найденным в
 * строках ключам попытки, признакам человека и трассам. Найденное только возвращается на экран: в базу, ленту и
 * журналы сервис ничего не пишет, телефон и код в адрес страницы не попадают (запросы идут телом POST).
 */
export class AttemptService {
  private readonly port: MonitorPort;
  private readonly clock: () => number;

  constructor(d: { port: MonitorPort; now?: () => number }) {
    this.port = d.port;
    this.clock = d.now ?? Date.now;
  }

  private loaded(): { profile: AttemptProfile; configured: boolean; error: string | null } {
    const a = this.port.attempt();
    if (a.profile) return { profile: a.profile, configured: true, error: null };
    return { profile: defaultAttemptProfile(this.port.services()), configured: false, error: a.error };
  }

  private services(p: AttemptProfile): MonitorServiceProfile[] {
    const all = this.port.services();
    return p.services.flatMap((x) => all.filter((s) => s.id === x.service));
  }

  /** Профиль пути для формы поиска. */
  profile(): AttemptProfileDto {
    const { profile: p, configured, error } = this.loaded();
    const features = this.port.features().features;
    return {
      configured,
      title: p.title,
      intro: p.intro ?? null,
      error,
      ids: p.ids.map((id) => ({ key: id.key, label: id.label, scope: id.scope, sensitive: id.sensitive })),
      signs: [
        ...p.events.filter((e) => e.search).map((e) => ({ key: `event:${e.key}`, label: e.label, group: p.title })),
        ...features.flatMap((f) => f.stages.map((s) => ({ key: `feature:${f.id}:${s.key}`, label: `${f.short}: ${s.label}`, group: 'Фичи входа' }))),
      ],
      providers: p.providers.map((x) => ({ key: x.key, label: x.label })),
      windowMs: attemptWindow(p).windowMs,
    };
  }

  /** Поиск строк по значениям в сервисе: поля идентификаторов пути и сервиса, трасса и, если text, фразы в тексте. */
  private match(p: AttemptProfile, s: MonitorServiceProfile, values: string[], o: { text: boolean; traces?: boolean; only?: string[] }, from: number, to: number, size: number): LogRequest {
    const fields = o.only ?? [...new Set([...p.ids.flatMap((id) => (id.fields[s.id] ? [id.fields[s.id]!] : [])), ...s.ids, ...(o.traces && s.fields.trace ? [s.fields.trace] : [])])];
    const extra = p.services.find((x) => x.service === s.id)?.fields.map((f) => f.field) ?? [];
    return { kind: 'match', service: s, filter: filterOf({}), from, to, values, fields, text: o.text, size, ...(extra.length ? { extra } : {}), cacheMs: CACHE_MS };
  }

  /** Строки ответов и ошибки поисков; capped - хоть один поиск уперся в предел строк. */
  private async run(requests: LogRequest[]): Promise<{ lines: LogLine[]; capped: boolean; errors: string[] }> {
    if (!requests.length) return { lines: [], capped: false, errors: [] };
    const results = await this.port.run(requests);
    const lines: LogLine[] = [];
    const errors = new Set<string>();
    let capped = false;
    for (const r of results) {
      if (r.kind === 'error') errors.add(r.message);
      if (r.kind === 'match') {
        lines.push(...r.lines);
        capped ||= r.capped;
      }
      if (r.kind === 'lines') lines.push(...r.lines);
    }
    return { lines, capped, errors: [...errors] };
  }

  /** Признак поиска: отбор строк в сервисах и проверка, что строка ему подходит. */
  private sign(p: AttemptProfile, key: string): { services: MonitorServiceProfile[]; filter: LogFilter; test: (l: LogLine) => boolean } {
    const [kind, a, b] = key.split(':');
    if (kind === 'event') {
      const e = p.events.find((x) => x.key === a);
      if (!e) throw new MonitorError(`Признака ${a} нет в профиле пути`);
      const services = this.services(p).filter((s) => !e.services || e.services.includes(s.id));
      return {
        services,
        filter: ruleFilter({ any: e.any, all: e.all, not: e.not }),
        test: (l) => (!e.services || e.services.includes(l.service)) && (!e.logger || l.logger === e.logger) && ruleMatches(e, l.message),
      };
    }
    if (kind === 'feature') {
      const f = this.port.features().features.find((x) => x.id === a);
      const stage = f?.stages.find((x) => x.key === b);
      if (!f || !stage) throw new MonitorError(`Стадии ${b} фичи ${a} нет в профилях features/`);
      const services = this.port.services().filter((s) => s.id === f.service);
      return { services, filter: ruleFilter(stage), test: (l) => l.service === f.service && ruleMatches(stage, l.message) };
    }
    throw new MonitorError('Признак - event:<событие> или feature:<фича>:<стадия>');
  }

  /**
   * Попытки по идентификаторам, телефону и признаку в окне, новые первыми. Все условия сразу: попытка в списке, если в
   * ее строках есть каждое значение, телефон и признак, а провайдер и итог совпали. У первых попыток строки
   * дособираются по их ключам, иначе у попытки, найденной по телефону, не было бы итога.
   */
  async search(q: AttemptQuery): Promise<AttemptSearchDto> {
    const { profile: p } = this.loaded();
    const { marginMs } = attemptWindow(p);
    const services = this.services(p);
    const now = this.clock();
    const values = [...new Set(q.ids.map((v) => v.trim()).filter(Boolean))];
    if (values.some((v) => !VALUE.test(v))) throw new MonitorError('Идентификатор - 4-128 символов из букв, цифр и знаков _ . : @ + -');
    const phone = q.phone?.trim() ? phoneDigits(q.phone) : null;
    if (q.phone?.trim() && !phone) throw new MonitorError('Телефон - 10 или 11 цифр, например +7 916 123-45-67');
    if (!values.length && !phone && !q.sign) throw new MonitorError('Нужен идентификатор, телефон или признак попытки');
    const to = Math.min(q.to ?? now, now);
    const from = q.from ?? to - SEARCH_DEFAULT_MS;
    if (!(from < to)) throw new MonitorError('Начало окна позже его конца');
    if (to - from > SEARCH_MAX_MS) throw new MonitorError('Попытки ищутся в окне не длиннее недели');
    const sign = q.sign ? this.sign(p, q.sign) : null;
    const providerLabel = q.provider ? (p.providers.find((x) => x.key === q.provider)?.label ?? q.provider) : null;

    const phoneId = p.ids.find((id) => id.normalize === 'phone');
    const requests: LogRequest[] = [
      ...(values.length ? services.map((s) => this.match(p, s, values, { text: true, traces: true }, from, to, SEED_SIZE)) : []),
      ...(phone ? services.filter((s) => !phoneId?.services || phoneId.services.includes(s.id)).map((s) => this.match(p, s, [phone], { text: true, only: [] }, from, to, SEED_SIZE)) : []),
      ...(sign ? sign.services.map((s): LogRequest => ({ kind: 'lines', service: s, filter: sign.filter, from, to, size: SIGN_SIZE, cacheMs: CACHE_MS })) : []),
    ];
    const seed = await this.run(requests);
    const errors = new Set(seed.errors);
    let capped = seed.capped;
    const add = (r: { lines: LogLine[]; capped: boolean; errors: string[] }) => {
      capped ||= r.capped;
      for (const e of r.errors) errors.add(e);
      return r.lines;
    };
    // Строка с телефоном или признаком часто без ключа попытки: ключ находится в других строках ее трассы. Трассы
    // берутся только у первых попыток списка, иначе их строки не влезли бы в один поиск.
    const newest = groupAttempts(p, seed.lines, marginMs).slice(0, ENRICH_ATTEMPTS).flatMap((g) => g.lines);
    let lines = uniqueLines([...seed.lines, ...add(await this.traces(p, services, newest, from - marginMs, to))]);

    // У первых попыток списка строки дособираются по их ключам и трассам: так у попытки есть итог и провайдер.
    const top = groupAttempts(p, lines, marginMs).slice(0, ENRICH_ATTEMPTS);
    const keys = [...new Set(top.flatMap((g) => g.summary.ids.filter((i) => i.scope === 'attempt').flatMap((i) => i.values)))].slice(0, ENRICH_KEYS);
    if (keys.length) {
      const lo = Math.min(...top.map((g) => g.summary.start ?? to)) - marginMs;
      const hi = Math.min(Math.max(...top.map((g) => g.summary.end ?? from)) + marginMs, now);
      const more = add(await this.run(services.map((s) => this.match(p, s, keys, { text: true }, lo, hi, ENRICH_SIZE))));
      // Из трасс для списка нужны только этапы, ошибки и итоги: служебные строки трасс не берутся.
      lines = uniqueLines([...lines, ...more, ...add(await this.traces(p, services, more, lo, hi, notableFilter(p)))]);
    }

    const has = (g: AttemptGroup, v: string) => g.lines.some((l) => l.trace === v || l.message.includes(v) || Object.values(l.ids ?? {}).includes(v) || lineIds(p, l).some((x) => x.value === v));
    const found = groupAttempts(p, lines, marginMs).filter(
      (g) =>
        values.every((v) => has(g, v)) &&
        (!phone || has(g, phone)) &&
        (!sign || g.lines.some(sign.test)) &&
        (!providerLabel || g.summary.providers.includes(providerLabel)) &&
        (!q.outcome || g.summary.outcome === q.outcome),
    );
    return { attempts: found.slice(0, LIST_LIMIT).map(candidateOf), range: { from, to }, truncated: capped || found.length > LIST_LIMIT, errors: [...errors] };
  }

  /** Строки трасс строк lines (под отбором filter) в сервисах пути с traces, не больше ENRICH_TRACES трасс на сервис. */
  private traces(p: AttemptProfile, services: MonitorServiceProfile[], lines: LogLine[], from: number, to: number, filter?: LogFilter) {
    const traced = new Set(p.services.filter((x) => x.traces).map((x) => x.service));
    const traces = new Map<string, Set<string>>();
    for (const l of lines) if (l.trace && traced.has(l.service)) traces.set(l.service, (traces.get(l.service) ?? new Set()).add(l.trace));
    return this.run(
      services.flatMap((s) => {
        if (!traces.get(s.id)?.size || !s.fields.trace) return [];
        const r = this.match(p, s, [...traces.get(s.id)!].slice(0, ENRICH_TRACES), { text: false, only: [s.fields.trace] }, from, to, TRACE_LIMIT);
        return [filter ? { ...r, filter } : r];
      }),
    );
  }

  /**
   * Путь одной попытки: строки всех сервисов с ее значениями в окне вокруг момента, затем круги по новым ключам
   * попытки и признакам человека из строк этой попытки (в запасе margin вокруг найденного) и по трассам сервисов с
   * traces. Строки других попыток того же человека не смешиваются с путем, а возвращаются списком рядом.
   */
  async path(q: AttemptPathQuery): Promise<AttemptPathDto> {
    const { profile: p } = this.loaded();
    const { windowMs, marginMs } = attemptWindow(p);
    const services = this.services(p);
    const now = this.clock();
    const seeds = [...new Set(q.ids.map((v) => v.trim()).filter(Boolean))];
    if (!seeds.length || seeds.some((v) => !VALUE.test(v))) throw new MonitorError('Нужен идентификатор попытки: 4-128 символов из букв, цифр и знаков _ . : @ + -');
    const range = q.at ? { from: q.at - windowMs, to: Math.min(now, q.at + windowMs) } : { from: now - SEARCH_DEFAULT_MS, to: now };
    const errors = new Set<string>();
    const first = await this.run(services.map((s) => this.match(p, s, seeds, { text: true, traces: true }, range.from, range.to, ROUND_SIZE)));
    for (const e of first.errors) errors.add(e);
    let lines = uniqueLines(first.lines);
    let truncated = first.capped;
    let rounds = 0;

    const byKey = new Map(p.ids.map((id) => [id.key, id]));
    const traced = new Set(p.services.filter((x) => x.traces).map((x) => x.service));
    const searched = new Set(seeds);
    const fetched = new Set<string>();
    for (let round = 1; round <= ROUNDS && lines.length && lines.length < LINES_LIMIT; round++) {
      const mine = selectAttempt(p, lines, seeds, marginMs).lines;
      const lo = Math.max(range.from, mine[0]!.t - marginMs);
      const hi = Math.min(range.to, mine.at(-1)!.t + marginMs);
      const fresh = new Map<string, Set<string>>();
      let added = 0;
      for (const v of mine.flatMap((l) => lineIds(p, l))) {
        const id = byKey.get(v.key)!;
        if (id.scope === 'detail' || searched.has(v.value) || added >= ROUND_VALUES || searched.size >= TOTAL_VALUES) continue;
        searched.add(v.value);
        added++;
        for (const s of services) if (!id.services || id.services.includes(s.id)) fresh.set(s.id, (fresh.get(s.id) ?? new Set()).add(v.value));
      }
      const traces = new Map<string, string[]>();
      for (const l of mine) {
        const k = `${l.service}\u0000${l.trace}`;
        if (!l.trace || !traced.has(l.service) || fetched.has(k) || (traces.get(l.service)?.length ?? 0) >= ROUND_TRACES) continue;
        fetched.add(k);
        traces.set(l.service, [...(traces.get(l.service) ?? []), l.trace]);
      }
      const requests: LogRequest[] = [
        ...services.flatMap((s) => (fresh.get(s.id)?.size ? [this.match(p, s, [...fresh.get(s.id)!], { text: true }, lo, hi, ROUND_SIZE)] : [])),
        ...services.flatMap((s) => (traces.get(s.id)?.length && s.fields.trace ? [this.match(p, s, traces.get(s.id)!, { text: false, only: [s.fields.trace] }, lo, hi, TRACE_SIZE)] : [])),
      ];
      if (!requests.length) break;
      rounds = round;
      const more = await this.run(requests);
      for (const e of more.errors) errors.add(e);
      truncated ||= more.capped;
      lines = uniqueLines([...lines, ...more.lines]);
    }
    if (lines.length >= LINES_LIMIT) truncated = true;

    const picked = selectAttempt(p, lines, seeds, marginMs);
    const path = attemptPath(p, picked.lines);
    return {
      title: p.title,
      range,
      seeds,
      steps: path.steps.slice(0, STEPS_LIMIT),
      summary: path.summary,
      others: picked.others.slice(0, LIST_LIMIT).map(candidateOf),
      services: services.map((s) => ({ id: s.id, title: s.title })),
      rounds,
      truncated: truncated || path.steps.length > STEPS_LIMIT,
      errors: [...errors],
    };
  }
}
