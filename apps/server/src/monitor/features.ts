import type { FeatureStatsDto, FeaturesDto, FeatureSummaryDto } from '@task-pilot/api-types';
import {
  captureOf,
  downstreamKeys,
  downstreamOf,
  downstreamPhrases,
  featureDailyRules,
  featureLinesFilter,
  featureStats,
  filterOf,
  HOUR,
  localDay,
  localStamp,
  loginSessions,
  MINUTE,
  mergeFeatureDays,
  shiftDay,
  tallyFeature,
  zonedDayStart,
  type FeatureDay,
  type FeatureProfile,
  type LogFilter,
  type LogLine,
  type MonitorPort,
  type MonitorServiceProfile,
} from '@task-pilot/step-kit';
import type { Store } from '../store/db.ts';
import { MonitorError } from './service.ts';

/** Сколько дней назад просить дневные итоги: индекс логов прода хранит около двух недель. */
const DAILY_DAYS = 16;
/** Значений в одном отборе хвостов: у кластера предел около 1024 условий в запросе, берется с запасом. */
const KEYS_CHUNK = 400;
/** Мельче окно не дробится: если в получасе строк больше предела поиска, берутся первые. */
const SPLIT_MIN_MS = 30 * MINUTE;
/** Хвосты (исходы после шага и вход) ищутся с запасом вокруг окна: сессия могла начаться до него. */
const TAIL_MS = 6 * HOUR;
/** Сколько живет посчитанная статистика окна: тяжелый сбор не повторяется на каждый заход на экран. */
const STATS_CACHE_MS = 10 * MINUTE;
/** Как часто обновляются дневные итоги из логов. */
const DAILY_EVERY_MS = HOUR;
/** Окно статистики не длиннее: дольше индекс логов все равно не хранит. */
const MAX_WINDOW_DAYS = 16;
/** Строк в одном поиске окна. */
const DOCS_SIZE = 10_000;

export interface FeatureServiceDeps {
  port: MonitorPort;
  store: Store;
  /** Часовой пояс команды: в нем считаются дни и часы. */
  timeZone: string;
  now?: () => number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Воронки фич входа по логам прода, как скилл feature-stats: дневные итоги по правилам профиля копятся в базе
 * дольше срока хранения индекса, статистика окна собирается по строкам окна, исходам после шага по трассам или
 * сессиям и входу по callback. Нагрузку ограничивает порт логов: время всегда в границах, запросы порциями.
 */
export class FeatureService {
  private readonly d: FeatureServiceDeps;
  private readonly cache = new Map<string, { at: number; dto: FeatureStatsDto }>();
  private readonly refreshed = new Map<string, { at: number; error: string | null }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Идущие обновления дневных итогов по фичам: второй запрос ждет первого, а не спрашивает кластер снова. */
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(d: FeatureServiceDeps) {
    this.d = d;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private feature(id: string): FeatureProfile {
    const f = this.d.port.features().features.find((x) => x.id === id);
    if (!f) throw new MonitorError(`Фичи ${id} нет в профилях features/ пакета команды`, 404);
    return f;
  }

  private service(f: FeatureProfile): MonitorServiceProfile {
    const s = this.d.port.services().find((x) => x.id === f.service);
    if (!s) throw new MonitorError(`Сервиса ${f.service} фичи ${f.id} нет в monitor.yaml`);
    return s;
  }

  /** Фичи для обзора и графика по дням: профили и вся история дней из базы, без запросов к логам. */
  list(): FeaturesDto {
    const { features, errors } = this.d.port.features();
    return {
      features: features.map((profile): FeatureSummaryDto => {
        const r = this.refreshed.get(profile.id);
        return { profile, days: this.d.store.featureDays(profile.id), refreshedAt: r?.at ?? null, error: r?.error ?? null };
      }),
      errors,
      timeZone: this.d.timeZone,
    };
  }

  /** Обновляет дневные итоги всех фич или одной; ошибка фичи запоминается для обзора, остальные обновляются. */
  async refresh(id?: string): Promise<void> {
    for (const f of this.d.port.features().features.filter((x) => !id || x.id === id)) {
      let running = this.refreshing.get(f.id);
      if (!running) {
        running = this.refreshOne(f).finally(() => this.refreshing.delete(f.id));
        this.refreshing.set(f.id, running);
      }
      await running;
    }
  }

  private async refreshOne(f: FeatureProfile): Promise<void> {
    try {
      await this.refreshDaily(f);
      this.refreshed.set(f.id, { at: this.now(), error: null });
    } catch (e) {
      console.error(`Мониторинг: дневные итоги фичи ${f.id} не обновились`, e);
      this.refreshed.set(f.id, { at: this.now(), error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Дневные итоги фичи за срок хранения индекса, слитые с историей в базе. */
  private async refreshDaily(f: FeatureProfile): Promise<void> {
    const tz = this.d.timeZone;
    const now = this.now();
    const today = localDay(now, tz);
    const from = zonedDayStart(shiftDay(today, -DAILY_DAYS), tz);
    const to = zonedDayStart(shiftDay(today, 1), tz);
    const [r] = await this.d.port.run([{ kind: 'daily', service: this.service(f), filter: filterOf({}), rules: featureDailyRules(f), timeZone: tz, from, to, cacheMs: 5 * MINUTE }]);
    if (r?.kind === 'error') throw new MonitorError(r.message, 502);
    if (r?.kind !== 'daily') throw new MonitorError('Кластер логов не ответил на дневные итоги', 502);
    const history = new Map(this.d.store.featureDays(f.id).map((x) => [x.day, x]));
    const changed = mergeFeatureDays(f, history, r.days, today, `до ${localStamp(now, tz).slice(6)}`);
    this.d.store.saveFeatureDays(f.id, changed);
  }

  /**
   * Строки окна под отборами filters, от старых к новым: поиски всех отборов уходят одной пачкой (порт логов сам
   * держит не больше двух запросов к кластеру), а окно отбора, строки которого не влезли в один поиск, делится пополам.
   */
  private async docs(service: MonitorServiceProfile, filters: LogFilter[], from: number, to: number, flags: { truncated: boolean }): Promise<LogLine[]> {
    const results = await this.d.port.run(filters.map((filter) => ({ kind: 'docs' as const, service, filter, from, to, size: DOCS_SIZE, cacheMs: STATS_CACHE_MS })));
    const parts = await Promise.all(
      results.map(async (r, i) => {
        if (r?.kind === 'error') throw new MonitorError(r.message, 502);
        if (r?.kind !== 'docs') throw new MonitorError('Кластер логов не ответил на поиск строк', 502);
        if (!r.capped) return r.lines;
        if (to - from <= SPLIT_MIN_MS) {
          flags.truncated = true;
          return r.lines;
        }
        const mid = from + Math.floor((to - from) / 2);
        const [early, late] = await Promise.all([this.docs(service, [filters[i]!], from, mid, flags), this.docs(service, [filters[i]!], mid, to, flags)]);
        return [...early, ...late];
      }),
    );
    return parts.flat();
  }

  /** Строки хвостов по значениям keys: порция значений - свой отбор, все порции одним вызовом. */
  private byKeys(service: MonitorServiceProfile, keys: string[], chunk: (part: string[]) => LogFilter, from: number, to: number, flags: { truncated: boolean }): Promise<LogLine[]> {
    const filters: LogFilter[] = [];
    for (let i = 0; i < keys.length; i += KEYS_CHUNK) filters.push(chunk(keys.slice(i, i + KEYS_CHUNK)));
    return filters.length ? this.docs(service, filters, from, to, flags) : Promise.resolve([]);
  }

  /**
   * Статистика фичи за дни from..to включительно в часовом поясе команды: воронка по сессиям, автоматы, время шага,
   * исходы после шага, вход, по часам и выводы. Посчитанное окно живет 10 минут.
   */
  async stats(id: string, fromDay?: string, toDay?: string): Promise<FeatureStatsDto> {
    return this.statsOf(this.feature(id), fromDay, toDay, true);
  }

  /** Статистика профиля, которого еще нет в файлах (превью правки по запросу): без кэша и без обновления дневных итогов. */
  preview(f: FeatureProfile, fromDay?: string, toDay?: string): Promise<FeatureStatsDto> {
    return this.statsOf(f, fromDay, toDay, false);
  }

  private async statsOf(f: FeatureProfile, fromDay: string | undefined, toDay: string | undefined, saved: boolean): Promise<FeatureStatsDto> {
    const id = f.id;
    const tz = this.d.timeZone;
    const now = this.now();
    const today = localDay(now, tz);
    const to = toDay ?? today;
    const from = fromDay ?? shiftDay(to, -7);
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new MonitorError('Дни окна - вида 2026-09-24');
    if (from > to) throw new MonitorError('Начало окна позже его конца');
    if (zonedDayStart(to, tz) - zonedDayStart(from, tz) > MAX_WINDOW_DAYS * 24 * HOUR) throw new MonitorError(`Окно не длиннее ${MAX_WINDOW_DAYS} дней: дольше индекс логов не хранит`);
    const key = `${id}|${from}|${to}`;
    const hit = saved ? this.cache.get(key) : undefined;
    if (hit && now - hit.at < STATS_CACHE_MS) return { ...hit.dto, days: this.d.store.featureDays(id) };

    // Дневные итоги обновляются вместе с окном: график по дням и цифры окна про одно и то же время.
    const last = this.refreshed.get(id);
    if (saved && (!last || now - last.at > STATS_CACHE_MS)) await this.refresh(id);
    const service = this.service(f);
    const start = zonedDayStart(from, tz);
    const end = Math.min(zonedDayStart(shiftDay(to, 1), tz), now);
    const flags = { truncated: false };
    const tally = tallyFeature(f, await this.docs(service, [featureLinesFilter(f)], start, end, flags), tz);

    // Хвосты ищутся с запасом вокруг окна; исходы после шага и вход не зависят друг от друга и идут вместе.
    const tailFrom = start - TAIL_MS;
    const tailTo = Math.min(end + TAIL_MS, now);
    const ds = downstreamKeys(f, tally);
    const login = f.login;
    const [downstream, logins] = await Promise.all([
      ds && (ds.by === 'state' || service.fields.trace)
        ? this.byKeys(
            service,
            ds.keys,
            (part) =>
              ds.by === 'trace'
                ? { match: [], anyOf: [downstreamPhrases(f)], not: [], level: [], terms: [{ field: service.fields.trace!, values: part }] }
                : { match: [], anyOf: [downstreamPhrases(f), part], not: [], level: [] },
            tailFrom,
            tailTo,
            flags,
          ).then((lines) => {
            const wanted = new Set(ds.keys);
            const messages = new Map<string, string[]>();
            for (const l of lines) {
              const k = ds.by === 'trace' ? l.trace : captureOf(f.session, l.message);
              if (k && wanted.has(k)) messages.set(k, [...(messages.get(k) ?? []), l.message]);
            }
            return downstreamOf(f, ds.keys, messages);
          })
        : null,
      login
        ? (async () => {
            const states = loginSessions(f, tally);
            const wanted = new Set(states);
            const lines = await this.byKeys(service, states, (part) => ({ match: [], anyOf: [login.any, part], not: [], level: [] }), tailFrom, tailTo, flags);
            const out = new Map<string, number[]>();
            for (const l of lines) {
              const s = captureOf(login.session, l.message);
              if (s && wanted.has(s)) out.set(s, [...(out.get(s) ?? []), l.t]);
            }
            return out;
          })()
        : null,
    ]);

    const dto: FeatureStatsDto = {
      profile: f,
      stats: featureStats(f, tally, { from: start, to: end, timeZone: tz, downstream, logins }),
      days: this.d.store.featureDays(id),
      window: { from, to, toPartial: to >= today },
      timeZone: tz,
      truncated: flags.truncated,
      generatedAt: now,
    };
    if (saved) {
      this.cache.set(key, { at: now, dto });
      for (const [k, v] of this.cache) if (now - v.at > STATS_CACHE_MS) this.cache.delete(k);
    }
    return dto;
  }

  /** Записывает дни из истории скилла, которых в базе еще нет: дни из логов в базе свежее. */
  importDays(id: string, days: FeatureDay[]): number {
    this.feature(id);
    const known = new Set(this.d.store.featureDays(id).map((d) => d.day));
    const missing = days.filter((d) => !known.has(d.day));
    this.d.store.saveFeatureDays(id, missing);
    return missing.length;
  }

  /** Запускает обновление дневных итогов сейчас и раз в час. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), DAILY_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
