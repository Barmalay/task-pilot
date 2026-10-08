import { describe, expect, it } from 'vitest';
import {
  classifyFeatureLine,
  daysFromSkillHistory,
  downstreamKeys,
  downstreamOf,
  downstreamPhrases,
  featureDailyRules,
  featureLinesFilter,
  featureProfileSchema,
  featureStats,
  fmtCount,
  fmtSeconds,
  localDay,
  localHour,
  loginSessions,
  mergeFeatureDays,
  percentile,
  ruleMatches,
  shiftDay,
  tallyFeature,
  zonedDayStart,
  type FeatureDay,
  type FeatureLine,
  type FeatureProfile,
} from '../src/funnel.ts';

const TZ = 'Europe/Moscow';

/** Профиль учебной фичи: капча с тестовой веткой, исходами после успеха по трассе и входом по callback. */
const PROFILE: FeatureProfile = featureProfileSchema.parse({
  id: 'captcha',
  title: 'Капча на входе по телефону',
  short: 'Капча',
  since: '2026-09-09',
  sinceNote: 'с 11:11',
  service: 'keycloak',
  intro: 'Капча для желтой зоны.',
  session: 'state ?= ?([A-Za-z0-9_\\-]{6,})',
  baseline: { label: 'Риск-проверок', any: ['Проверка антифрода RBA для state'] },
  stages: [
    { key: 'entered', label: 'Попали в желтую зону', any: ['желтая зона'], role: 'entry', detail: { regex: 'score=(\\d+)', label: 'score' } },
    { key: 'shown', label: 'Увидели форму капчи', any: ['показана форма капчи'], role: 'shown' },
    { key: 'passed', label: 'Прошли капчу', any: ['Капча для state'], all: ['пройдена'], not: ['непройденной'], role: 'success' },
    { key: 'test', label: 'Тестовый номер', any: ['тестовый номер реалма'], role: 'skip' },
  ],
  errors: [{ key: 'rejected', label: 'Токен отвергнут', any: ['токен отвергнут сервисом'] }],
  downstream: {
    from: 'passed',
    by: 'trace',
    title: 'Что дальше',
    outcomes: [
      { key: 'code_sent', label: 'Код ушел', any: ['Код отправлен провайдером'], detail: "провайдером '([^']+)'", tone: 'good' },
      { key: 'brute_block', label: 'Слишком много попыток', any: ['Блокировка по числу попыток'], tone: 'bad' },
    ],
  },
  login: { from: 'passed', label: 'Дошли до входа', any: ['www.example.com/auth/event'], session: '"state":"([^"]+)"' },
  timing: { from: 'shown', to: 'passed', label: 'От показа до токена' },
  automation: { stage: 'shown', threshold: 3 },
});

const T0 = Date.UTC(2026, 8, 30, 9, 0); // 12:00 по Москве
const at = (min: number, sec = 0) => T0 + min * 60_000 + sec * 1000;
const line = (t: number, message: string, trace?: string, version?: string): FeatureLine => ({ t, message, ...(trace ? { trace } : {}), ...(version ? { version } : {}) });

describe('feature profile', () => {
  it('accepts the profile of the skill and gives defaults to the optional fields', () => {
    expect(PROFILE.errors).toHaveLength(1);
    expect(PROFILE.downstream?.otherLabel).toBe('Прочее');
    expect(PROFILE.stages[1]?.all).toEqual([]);
  });

  it('refuses a profile without exactly one entry stage, with repeated keys or links to missing stages, naming the problem', () => {
    const base = { ...PROFILE, downstream: undefined, login: undefined, timing: undefined, automation: { threshold: 6 } };
    const problems = (p: unknown) => {
      const r = featureProfileSchema.safeParse(p);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(problems({ ...base, stages: base.stages.map((s) => ({ ...s, role: s.role === 'entry' ? undefined : s.role })) })).toContain('нужна ровно одна стадия с ролью entry');
    expect(problems({ ...base, errors: [{ key: 'shown', label: 'x', any: ['x'] }] })).toContain('ключ shown повторяется');
    expect(problems({ ...base, timing: { from: 'shown', to: 'nope', label: 'x' } })).toContain('нет стадии nope');
    expect(problems({ ...base, session: 'state=\\w+' })).toContain('регулярное выражение с группой в скобках');
  });
});

describe('lines of a feature', () => {
  it('match a rule by any, all and not phrases and take the first fitting stage, then the errors', () => {
    expect(ruleMatches({ any: ['Капча для state'], all: ['пройдена'], not: ['непройденной'] }, 'Капча для state = abc123: пройдена')).toBe(true);
    expect(ruleMatches({ any: ['Капча для state'], all: ['пройдена'], not: ['непройденной'] }, 'Капча для state = abc123: капча считается непройденной')).toBe(false);
    expect(classifyFeatureLine(PROFILE, 'Капча для state = abc123: токен отвергнут сервисом, форма показана')).toBe('rejected');
    expect(classifyFeatureLine(PROFILE, 'что-то другое')).toBeNull();
  });

  it('are asked for by every phrase of stages and errors, and the daily totals by each rule with the baseline', () => {
    expect(featureLinesFilter(PROFILE).anyOf).toEqual([['желтая зона', 'показана форма капчи', 'Капча для state', 'тестовый номер реалма', 'токен отвергнут сервисом']]);
    const daily = featureDailyRules(PROFILE);
    expect(Object.keys(daily)).toEqual(['baseline', 'entered', 'shown', 'passed', 'test', 'rejected']);
    expect(daily.passed).toEqual({ match: ['пройдена'], anyOf: [['Капча для state']], not: ['непройденной'], level: [] });
  });

  it('count days and hours in the time zone of the team', () => {
    const late = Date.UTC(2026, 8, 30, 21, 30); // 00:30 следующего дня по Москве
    expect(localDay(late, TZ)).toBe('2026-10-01');
    expect(localHour(late, TZ)).toBe('2026-10-01T00');
    expect(zonedDayStart('2026-10-01', TZ)).toBe(Date.UTC(2026, 8, 30, 21, 0));
    expect(zonedDayStart('2026-10-01', 'UTC')).toBe(Date.UTC(2026, 9, 1));
    expect([shiftDay('2026-09-30', 1), shiftDay('2026-03-01', -1)]).toEqual(['2026-10-01', '2026-02-28']);
  });
});

/** Окно: обычная сессия s1 прошла капчу и вошла, s2 бросила, бот s3 повторил показ трижды, s4 - тестовый номер. */
function windowLines(): FeatureLine[] {
  return [
    line(at(0), 'Проверка антифрода RBA для state = sess01: желтая зона (score=95), потребуется капча', 't1', 'gate:1.0.207-master'),
    line(at(0, 2), 'Капча для state = sess01: токена в запросе нет, показана форма капчи', 't1'),
    line(at(0, 9), 'Капча для state = sess01: пройдена', 't2', 'gate:1.0.208-master'),
    line(at(5), 'Проверка антифрода RBA для state = sess02: желтая зона (score=91), потребуется капча', 't3'),
    line(at(5, 1), 'Капча для state = sess02: токена в запросе нет, показана форма капчи', 't3'),
    line(at(5, 30), 'Капча для state = sess02: токен отвергнут сервисом, форма капчи показана повторно', 't4'),
    line(at(10), 'Капча для state = bot003: токена в запросе нет, показана форма капчи', 't5'),
    line(at(10, 5), 'Капча для state = bot003: токена в запросе нет, показана форма капчи', 't6'),
    line(at(10, 9), 'Капча для state = bot003: токена в запросе нет, показана форма капчи', 't7'),
    line(at(10, 12), 'Капча для state = bot003: пройдена', 't8'),
    line(at(15), 'Капча для state = test04: тестовый номер реалма, капча не требуется', 't9'),
    line(at(16), 'желтая зона без сессии в строке'),
  ];
}

describe('feature stats of a window', () => {
  const tally = tallyFeature(PROFILE, windowLines(), TZ);

  it('group lines by sessions and stages, keep traces, versions, details and hours, and count lines without a session as unparsed', () => {
    expect([...tally.sessions.keys()].sort()).toEqual(['bot003', 'sess01', 'sess02', 'test04']);
    expect(tally.sessions.get('bot003')?.get('shown')).toHaveLength(3);
    expect(tally.lines).toEqual({ entered: 3, shown: 5, passed: 2, rejected: 1, test: 1 });
    expect(tally.details.entered).toEqual({ '95': 1, '91': 1, '?': 1 });
    expect(Object.keys(tally.versions)).toEqual(['1.0.207-master', '1.0.208-master']);
    expect(tally.hourly['2026-09-30T12']?.shown).toBe(5);
    expect(tally.unparsed).toBe(1);
    expect([...(tally.traces.get('passed') ?? [])].sort()).toEqual(['t2', 't8']);
  });

  it('separates automation, measures the step of normal sessions only and counts the funnel with and without automation', () => {
    const s = featureStats(PROFILE, tally, { from: at(0), to: at(60), timeZone: TZ });
    expect(s.funnel.map((f) => [f.key, f.sessions, f.sessionsNormal])).toEqual([
      ['entered', 2, 2],
      ['shown', 3, 2],
      ['passed', 2, 1],
      ['test', 1, 1],
    ]);
    expect(s.automation).toMatchObject({ stage: 'shown', threshold: 3, count: 1, shownLines: 3, successLines: 1 });
    expect(s.automation.rows[0]).toMatchObject({ session: 'bot003', shows: 3, success: 1, first: at(10), last: at(10, 12) });
    expect(s.timing).toMatchObject({ n: 1, median: 7, p90: 7, buckets: { '5-10 с': 1 } });
    expect(s.showsDistribution).toEqual({ '1': 2, '3': 1 });
    expect(s.abandonedByDay).toEqual({ '2026-09-30': 1 });
    expect(s.errors).toEqual({ rejected: 1 });
  });

  it('take the outcome after the step from the joined lines of each trace, other ones otherwise, with the detail', () => {
    const keys = downstreamKeys(PROFILE, tally);
    expect(keys).toEqual({ by: 'trace', from: 'passed', keys: ['t2', 't8'] });
    expect(downstreamPhrases(PROFILE)).toEqual(['Код отправлен провайдером', 'Блокировка по числу попыток', 'Капча для state']);
    const ds = downstreamOf(PROFILE, keys!.keys, new Map([['t2', ['Капча для state = sess01: пройдена', "Код отправлен провайдером 'mobile-id' на шаге SEND"]]]));
    expect(ds).toEqual({ total: 2, counts: { code_sent: 1, __other__: 1 }, details: { code_sent: { 'mobile-id': 1 } } });
  });

  it('count reaching the login after the step for normal sessions and automation apart, with the time to it', () => {
    expect(loginSessions(PROFILE, tally)).toEqual(['bot003', 'sess01']);
    const s = featureStats(PROFILE, tally, { from: at(0), to: at(60), timeZone: TZ, logins: new Map([['sess01', [at(1)]], ['bot003', [at(11)]]]) });
    expect(s.login).toMatchObject({ fromSessions: 2, fromSessionsNormal: 1, reached: 2, reachedNormal: 1, reachedAutomation: 1, median: 51 });
  });

  it('write the findings for the team from the numbers of the window', () => {
    const ds = { total: 4, counts: { code_sent: 3, brute_block: 1 }, details: {} };
    const s = featureStats(PROFILE, tally, { from: at(0), to: at(60), timeZone: TZ, downstream: ds, logins: new Map([['sess01', [at(1)]]]) });
    expect(s.findings.map((f) => [f.tone, f.title])).toEqual([
      ['warn', 'Ошибки сервиса за окно: 1.'],
      ['good', 'Время шага: медиана 7.0 с, p90 7.0 с.'],
      ['warn', 'Не завершили шаг: 1.'],
      ['bad', 'Автоматы: 1.'],
      ['warn', 'Слишком много попыток: 1 из 4.'],
      ['neutral', 'Тестовый номер: 1.'],
      ['neutral', 'Строк не разобрано: 1.'],
    ]);
    expect(s.findings[3]?.text).toContain('повторами шага "Увидели форму капчи"');
    expect(s.findings[3]?.text).toContain('30.09 12:10 - 30.09 12:10. Из них дошли до входа: 0.');
  });

  it('pick percentiles at floor(p * n) and write numbers and seconds for people', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeNull();
    expect(fmtCount(1234567)).toBe('1 234 567');
    expect([fmtSeconds(4.24), fmtSeconds(35.4), fmtSeconds(200), fmtSeconds(null)]).toEqual(['4.2 с', '35 с', '3 мин', '-']);
  });
});

describe('daily history of a feature', () => {
  const history = new Map<string, FeatureDay>([
    ['2026-09-08', { day: '2026-09-08', counts: { baseline: 5 }, note: null }],
    ['2026-09-10', { day: '2026-09-10', counts: { baseline: 9, shown: 2 }, note: 'до 18:00' }],
    ['2026-09-11', { day: '2026-09-11', counts: { baseline: 7, shown: 1 }, note: null }],
  ]);

  it('merges days from the logs like the skill: not before since, keeps old days the index no longer has, notes today and clears past notes', () => {
    const merged = mergeFeatureDays(
      PROFILE,
      history,
      { '2026-09-08': { baseline: 1 }, '2026-09-09': { baseline: 4, shown: 1 }, '2026-09-10': { baseline: 10, shown: 3 }, '2026-09-11': { baseline: 0 }, '2026-09-12': { baseline: 3 } },
      '2026-09-12',
      'до 14:05',
    );
    expect(merged).toEqual([
      { day: '2026-09-09', counts: { baseline: 4, shown: 1 }, note: 'с 11:11' },
      { day: '2026-09-10', counts: { baseline: 10, shown: 3 }, note: null },
      { day: '2026-09-12', counts: { baseline: 3 }, note: 'до 14:05' },
    ]);
  });

  it('reads the history file of the skill as days with their notes', () => {
    expect(daysFromSkillHistory({ days: { '2026-09-10': { baseline: 9 }, junk: { baseline: 1 } }, notes: { '2026-09-10': 'с 11:11' } })).toEqual([{ day: '2026-09-10', counts: { baseline: 9 }, note: 'с 11:11' }]);
    expect(() => daysFromSkillHistory({ notes: {} })).toThrow();
  });
});
