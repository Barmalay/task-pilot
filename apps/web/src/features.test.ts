import { describe, expect, it } from 'vitest';
import { featureProfileSchema, type FeatureDay, type FeatureStats } from '@task-pilot/step-kit';
import { dayBars, dayLabel, dayTable, featureTiles, featureWindows, funnelRows, hourBars, lastDayOf, outcomeRows, timingColumns } from './features.ts';

const PROFILE = featureProfileSchema.parse({
  id: 'captcha',
  title: 'Капча',
  short: 'Капча',
  since: '2026-09-09',
  service: 'keycloak',
  intro: 'Капча для желтой зоны.',
  session: 'state ?= ?([A-Za-z0-9_\\-]{6,})',
  baseline: { label: 'Риск-проверок', any: ['RBA'] },
  stages: [
    { key: 'entered', label: 'Попали в желтую зону', any: ['желтая зона'], role: 'entry' },
    { key: 'shown', label: 'Увидели форму', any: ['показана форма'], role: 'shown' },
    { key: 'passed', label: 'Прошли капчу', any: ['пройдена'], role: 'success' },
    { key: 'test', label: 'Тестовый номер', any: ['тестовый номер'], role: 'skip' },
  ],
  errors: [{ key: 'rejected', label: 'Токен отвергнут', any: ['отвергнут'] }],
  downstream: {
    from: 'passed',
    by: 'trace',
    title: 'Что дальше',
    outcomes: [
      { key: 'code_sent', label: 'Код ушел', any: ['Код отправлен'], tone: 'good' },
      { key: 'brute_block', label: 'Блокировка', any: ['Блокировка'], tone: 'bad' },
    ],
  },
  login: { from: 'passed', label: 'Дошли до входа', any: ['auth/event'], session: '"state":"([^"]+)"' },
});

const DAYS: FeatureDay[] = [
  { day: '2026-09-08', counts: { baseline: 9 }, note: null },
  { day: '2026-09-29', counts: { baseline: 1000, entered: 100, shown: 90, passed: 80, test: 5, rejected: 1 }, note: null },
  { day: '2026-09-30', counts: { baseline: 500, entered: 50, shown: 40, passed: 30 }, note: 'до 12:30' },
];

const STATS = {
  sessions: 150,
  funnel: [
    { key: 'entered', label: 'Попали в желтую зону', role: 'entry', sessions: 150, sessionsNormal: 148, lines: 150 },
    { key: 'shown', label: 'Увидели форму', role: 'shown', sessions: 130, sessionsNormal: 128, lines: 140 },
    { key: 'passed', label: 'Прошли капчу', role: 'success', sessions: 110, sessionsNormal: 109, lines: 110 },
    { key: 'test', label: 'Тестовый номер', role: 'skip', sessions: 5, sessionsNormal: 5, lines: 5 },
  ],
  automation: { stage: 'shown', threshold: 6, count: 2, shownLines: 20, successLines: 1, rows: [] },
  login: { label: 'Дошли до входа', from: 'passed', fromSessions: 110, fromSessionsNormal: 109, reached: 90, reachedNormal: 89, reachedAutomation: 1, median: 15, p75: 20, p90: 40 },
  downstream: { total: 110, counts: { code_sent: 100, brute_block: 6, __other__: 4 }, details: { code_sent: { 'mobile-id': 90, 'call-password': 10 } }, by: 'trace', from: 'passed', title: 'Что дальше' },
  timing: { label: 'От показа до токена', n: 100, median: 4, p75: 6, p90: 10, p95: 20, buckets: { 'до 5 с': 60, '10-60 с': 40 } },
  hourly: { '2026-09-30T00': { shown: 3, passed: 2 }, '2026-09-30T05': { shown: 1 } },
} as unknown as FeatureStats;

describe('feature screen', () => {
  it('shows the tiles of the skill report: sessions of the baseline, step, success, not finished, the skip branch and logins', () => {
    const tiles = featureTiles({ profile: PROFILE, stats: STATS, days: DAYS, window: { from: '2026-09-29', to: '2026-09-30', toPartial: true } });
    expect(tiles.map((t) => [t.value, t.label, t.note].map((x) => x.replace(/\s/g, ' ')))).toEqual([
      ['150', 'попали в желтую зону', '10% от 1 500: риск-проверок'],
      ['130', 'увидели форму', '87% сессий'],
      ['110', 'прошли капчу', '85% от показов'],
      ['20', 'не завершили шаг', 'без автоматов: 19'],
      ['5', 'тестовый номер', 'в успешные не входят'],
      ['82%', 'дошли до входа', '89 из 109 обычных сессий'],
    ]);
  });

  it('splits the shows of a day into successful and unfinished from the start of the feature, the skip branch beside them', () => {
    expect(dayBars(PROFILE, DAYS)).toEqual([
      { day: '2026-09-29', success: 80, fail: 10, skip: 5, shows: 90, entry: 100, baseline: 1000, note: null },
      { day: '2026-09-30', success: 30, fail: 10, skip: 0, shows: 40, entry: 50, baseline: 500, note: 'до 12:30' },
    ]);
    expect(lastDayOf(PROFILE, DAYS)?.rate).toBe('75%');
    expect(lastDayOf(PROFILE, [])).toBeNull();
  });

  it('builds the funnel without the skip branch and with the login last, each step as a share of the previous one', () => {
    expect(funnelRows(STATS).map((r) => [r.label, r.sessions, r.normal, r.ofPrevious])).toEqual([
      ['Попали в желтую зону', 150, 148, null],
      ['Увидели форму', 130, 128, '87%'],
      ['Прошли капчу', 110, 109, '85%'],
      ['Дошли до входа', 90, 89, '82%'],
    ]);
  });

  it('lists the outcomes after the step by the profile, split by details when there are several, "other" last', () => {
    expect(outcomeRows(PROFILE, STATS)).toEqual([
      { label: 'Код ушел: mobile-id', n: 90, tone: 'good' },
      { label: 'Код ушел: call-password', n: 10, tone: 'good' },
      { label: 'Блокировка', n: 6, tone: 'bad' },
      { label: 'Прочее', n: 4, tone: 'other' },
    ]);
    expect(timingColumns(STATS)).toEqual([{ x: 0, n: 60 }, { x: 1, n: 0 }, { x: 2, n: 40 }, { x: 3, n: 0 }, { x: 4, n: 0 }]);
  });

  it('gives every hour of the window, also the empty ones, and stops at the current hour', () => {
    const hours = hourBars(PROFILE, STATS, '2026-09-30', '2026-09-30', '2026-09-30T05');
    expect(hours).toHaveLength(6);
    expect(hours[0]).toEqual({ hour: '2026-09-30T00', shows: 3, success: 2 });
    expect(hours[1]).toEqual({ hour: '2026-09-30T01', shows: 0, success: 0 });
    expect(hourBars(PROFILE, STATS, '2026-09-29', '2026-09-30')).toHaveLength(48);
  });

  it('writes the day table newest first with notes, unfinished shows and errors, from the start of the feature', () => {
    const t = dayTable(PROFILE, DAYS);
    expect(t.head).toEqual(['День', 'Риск-проверок', 'Попали в желтую зону', 'Увидели форму', 'Прошли капчу', 'Не завершено', 'Тестовый номер', 'Токен отвергнут']);
    expect(t.rows.map((r) => r.map((c) => c.replace(/\s/g, ' ')))).toEqual([
      ['30.09 (до 12:30)', '500', '50', '40', '30', '10', '0', '0'],
      ['29.09', '1 000', '100', '90', '80', '10', '5', '1'],
    ]);
    expect(dayLabel('2026-10-01')).toBe('01.10');
  });

  it('offers windows ending today: today, three days, a week like the skill and two weeks', () => {
    expect(featureWindows('2026-10-01').map((w) => [w.id, w.from, w.to])).toEqual([
      ['today', '2026-10-01', '2026-10-01'],
      ['3d', '2026-09-29', '2026-10-01'],
      ['week', '2026-09-24', '2026-10-01'],
      ['2w', '2026-09-17', '2026-10-01'],
    ]);
  });
});
