import { SECONDS_BUCKETS, shiftDay, type FeatureDay, type FeatureProfile, type FeatureRole, type FeatureStats } from '@task-pilot/step-kit';
import type { FeatureStatsDto } from '@task-pilot/api-types';
import { formatCount, formatRatio } from './monitor.ts';

/** Стадия профиля с ролью; null - такой стадии в профиле нет. */
export function stageOf(p: FeatureProfile, role: FeatureRole): FeatureProfile['stages'][number] | null {
  return p.stages.find((s) => s.role === role) ?? null;
}

/** День как "24.09". */
export const dayLabel = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/** Доля a от b; без знаменателя - прочерк. */
export function share(a: number, b: number): string {
  return b ? formatRatio(a / b) : '-';
}

/** Плитка цифр окна: значение, что это и пояснение. */
export interface FeatureTile {
  value: string;
  label: string;
  note: string;
}

/**
 * Плитки окна, как в отчете скилла: сессии входа в воронку и доля от знаменателя, показ, успех, не завершившие шаг,
 * ветка обхода и доля дошедших до входа среди обычных сессий.
 */
export function featureTiles(dto: Pick<FeatureStatsDto, 'profile' | 'stats' | 'days' | 'window'>): FeatureTile[] {
  const { profile: p, stats: s, window: w } = dto;
  const step = (role: FeatureRole) => s.funnel.find((f) => f.role === role);
  const entry = step('entry');
  const shown = step('shown');
  const success = step('success');
  const skip = step('skip');
  const baseline = dto.days.filter((d) => d.day >= w.from && d.day <= w.to).reduce((a, d) => a + (d.counts.baseline ?? 0), 0);
  const tiles: FeatureTile[] = [
    {
      value: formatCount(s.sessions),
      label: (entry?.label ?? 'Сессий').toLowerCase(),
      note: baseline ? `${share(s.sessions, baseline)} от ${formatCount(baseline)}: ${p.baseline.label.toLowerCase()}` : '',
    },
  ];
  if (shown) tiles.push({ value: formatCount(shown.sessions), label: shown.label.toLowerCase(), note: `${share(shown.sessions, s.sessions)} сессий` });
  if (success) {
    tiles.push({
      value: formatCount(success.sessions),
      label: success.label.toLowerCase(),
      note: shown ? `${share(success.sessions, shown.sessions)} от показов` : `${share(success.sessions, s.sessions)} сессий`,
    });
  }
  if (shown && success) {
    tiles.push({
      value: formatCount(shown.sessions - success.sessions),
      label: 'не завершили шаг',
      note: s.automation.count ? `без автоматов: ${formatCount(shown.sessionsNormal - success.sessionsNormal)}` : '',
    });
  }
  if (skip) tiles.push({ value: formatCount(skip.sessions), label: skip.label.toLowerCase(), note: 'в успешные не входят' });
  if (s.login?.fromSessionsNormal) {
    tiles.push({
      value: share(s.login.reachedNormal, s.login.fromSessionsNormal),
      label: s.login.label.toLowerCase(),
      note: `${formatCount(s.login.reachedNormal)} из ${formatCount(s.login.fromSessionsNormal)} обычных сессий`,
    });
  }
  return tiles;
}

/** Столбец дня: успешные и незавершенные показы, ветка обхода рядом и итоги дня для подсказки. */
export interface DayBar {
  day: string;
  success: number;
  fail: number;
  skip: number;
  shows: number;
  entry: number;
  baseline: number;
  note: string | null;
}

/** Столбцы по дням с начала фичи: показ шага (без него - вход в воронку) делится на успешные и незавершенные. */
export function dayBars(p: FeatureProfile, days: FeatureDay[]): DayBar[] {
  const entry = stageOf(p, 'entry')!.key;
  const shows = stageOf(p, 'shown')?.key ?? entry;
  const success = stageOf(p, 'success')?.key;
  const skip = stageOf(p, 'skip')?.key;
  return days
    .filter((d) => d.day >= p.since)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => {
      const n = (k: string | undefined) => (k ? (d.counts[k] ?? 0) : 0);
      const ok = n(success);
      return { day: d.day, success: ok, fail: Math.max(0, n(shows) - ok), skip: n(skip), shows: n(shows), entry: n(entry), baseline: n('baseline'), note: d.note };
    });
}

/** Ступень воронки окна: сессий всего и без автоматов, доля от предыдущей ступени. */
export interface FunnelRow {
  label: string;
  sessions: number;
  normal: number;
  ofPrevious: string | null;
}

/** Ступени окна без ветки обхода, последней - вход, если профиль его ищет. */
export function funnelRows(s: FeatureStats): FunnelRow[] {
  const rows = s.funnel.filter((f) => f.role !== 'skip').map((f) => ({ label: f.label, sessions: f.sessions, normal: f.sessionsNormal }));
  if (s.login?.fromSessions) rows.push({ label: s.login.label, sessions: s.login.reached, normal: s.login.reachedNormal });
  return rows.map((r, i) => ({ ...r, ofPrevious: i ? share(r.sessions, rows[i - 1]!.sessions) : null }));
}

/** Строка исходов после шага: исход (с подробностью, если их несколько), число и тон. */
export interface OutcomeRow {
  label: string;
  n: number;
  tone: 'good' | 'bad' | 'neutral' | 'other';
}

/** Исходы после шага по порядку профиля; исход с несколькими подробностями делится на строки, "Прочее" - последним. */
export function outcomeRows(p: FeatureProfile, s: FeatureStats): OutcomeRow[] {
  const ds = s.downstream;
  if (!ds?.total || !p.downstream) return [];
  const rows: OutcomeRow[] = [];
  for (const o of p.downstream.outcomes) {
    const details = Object.entries(ds.details[o.key] ?? {}).sort((a, b) => b[1] - a[1]);
    if (details.length > 1) for (const [k, n] of details) rows.push({ label: `${o.label}: ${k}`, n, tone: o.tone });
    else rows.push({ label: o.label, n: ds.counts[o.key] ?? 0, tone: o.tone });
  }
  if (ds.counts.__other__) rows.push({ label: p.downstream.otherLabel, n: ds.counts.__other__, tone: 'other' });
  return rows;
}

/** Корзины времени шага по порядку для столбцов. */
export function timingColumns(s: FeatureStats): { x: number; n: number }[] {
  return SECONDS_BUCKETS.map((k, i) => ({ x: i, n: s.timing?.buckets[k] ?? 0 }));
}

/** Час окна: показов и успехов. */
export interface HourBar {
  hour: string;
  shows: number;
  success: number;
}

/** Все часы окна в часовом поясе команды, и пустые: по ним видно, когда шаг не показывался совсем. */
export function hourBars(p: FeatureProfile, s: FeatureStats, from: string, to: string, last?: string): HourBar[] {
  const shows = stageOf(p, 'shown')?.key ?? stageOf(p, 'entry')!.key;
  const success = stageOf(p, 'success')?.key;
  const out: HourBar[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) {
    for (let h = 0; h < 24; h++) {
      const hour = `${d}T${String(h).padStart(2, '0')}`;
      if (last && hour > last) return out;
      const r = s.hourly[hour] ?? {};
      out.push({ hour, shows: r[shows] ?? 0, success: success ? (r[success] ?? 0) : 0 });
    }
  }
  return out;
}

/** Таблица по дням, новые сверху: знаменатель, стадии, незавершенные, ветка обхода и ошибки, как в отчете скилла. */
export function dayTable(p: FeatureProfile, days: FeatureDay[]): { head: string[]; rows: string[][] } {
  const entry = stageOf(p, 'entry')!;
  const shown = stageOf(p, 'shown');
  const success = stageOf(p, 'success');
  const skip = stageOf(p, 'skip');
  const cols: [string, (c: Record<string, number>) => number][] = [
    [p.baseline.label, (c) => c.baseline ?? 0],
    [entry.label, (c) => c[entry.key] ?? 0],
  ];
  if (shown) cols.push([shown.label, (c) => c[shown.key] ?? 0]);
  if (success) cols.push([success.label, (c) => c[success.key] ?? 0]);
  if (shown && success) cols.push(['Не завершено', (c) => (c[shown.key] ?? 0) - (c[success.key] ?? 0)]);
  if (skip) cols.push([skip.label, (c) => c[skip.key] ?? 0]);
  for (const e of p.errors) cols.push([e.label, (c) => c[e.key] ?? 0]);
  return {
    head: ['День', ...cols.map(([h]) => h)],
    rows: days
      .filter((d) => d.day >= p.since)
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((d) => [`${dayLabel(d.day)}${d.note ? ` (${d.note})` : ''}`, ...cols.map(([, v]) => formatCount(v(d.counts)))]),
  };
}

/** Окно статистики: id для выбора, подпись и дни включительно. */
export interface FeatureWindow {
  id: string;
  label: string;
  from: string;
  to: string;
}

/** Окна на выбор: сегодня, три дня, неделя (как у скилла) и две недели; последний день - сегодня. */
export function featureWindows(today: string): FeatureWindow[] {
  return [
    { id: 'today', label: 'Сегодня', from: today, to: today },
    { id: '3d', label: '3 дня', from: shiftDay(today, -2), to: today },
    { id: 'week', label: 'Неделя', from: shiftDay(today, -7), to: today },
    { id: '2w', label: '2 недели', from: shiftDay(today, -14), to: today },
  ];
}

/** Итоги последнего дня для карточки обзора: вход, показ и успех со строкой дня и долей успеха от показов. */
export function lastDayOf(p: FeatureProfile, days: FeatureDay[]): { bar: DayBar; rate: string } | null {
  const bar = dayBars(p, days).at(-1);
  if (!bar) return null;
  return { bar, rate: share(bar.success, bar.shows) };
}
