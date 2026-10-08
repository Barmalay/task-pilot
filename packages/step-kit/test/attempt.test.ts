import { describe, expect, it } from 'vitest';
import {
  attemptPath,
  attemptProfileSchema,
  classifyAttemptLine,
  cleanMessage,
  formatPhone,
  groupAttempts,
  hiddenLine,
  lineIds,
  linkLines,
  maskPhone,
  maskPhones,
  phoneDigits,
  selectAttempt,
  type AttemptProfile,
} from '../src/attempt.ts';
import type { LogLine } from '../src/monitor.ts';

/** Профиль пути: Keycloak со state в тексте, адаптер с flowState в поле, web-front с accountId и страницей. */
const PROFILE: AttemptProfile = attemptProfileSchema.parse({
  title: 'Путь попытки входа',
  services: [
    { service: 'keycloak', traces: true },
    { service: 'adapter' },
    { service: 'web-front', traces: true, fields: [{ field: 'extra.referer', label: 'страница' }] },
  ],
  ids: [
    { key: 'state', label: 'state', patterns: ['\\bstate ?= ?([A-Za-z0-9_-]{8,64})'], fields: { 'adapter': 'flowState.keyword' } },
    { key: 'accountid', label: 'accountId', patterns: ['accountId=([0-9a-f-]{36})'], fields: { 'web-front': 'extra.account_id.keyword' }, scope: 'person' },
    { key: 'phone', label: 'телефон', patterns: ['номер[ау]? \\+?(7\\d{10})'], scope: 'person', sensitive: true, normalize: 'phone' },
    { key: 'code', label: 'код', patterns: ['OTP-код: (\\d{4,6})'], scope: 'detail', sensitive: true },
  ],
  events: [
    { key: 'rba', label: 'Риск-проверка антифрода', kind: 'step', any: ['Проверка антифрода RBA'], detail: 'score = (\\d+)', milestone: true },
    { key: 'phone', label: 'Введен номер', kind: 'action', any: ['Основной вход по телефону: каскад'], milestone: true },
    { key: 'sent', label: 'Код отправлен', kind: 'step', any: ['Код отправлен провайдером'], provider: "провайдером '([^']+)'", milestone: true },
    { key: 'code', label: 'Введен код', kind: 'action', any: ['OTP-код'] },
    { key: 'wrong', label: 'Неверный код', kind: 'error', any: ['Неверный код'] },
    { key: 'ok', label: 'Вход по телефону успешен', kind: 'outcome', any: ['Телефонная аутентификация успешна'], outcome: 'success', milestone: true },
    { key: 'exchange_fail', label: 'Обмен с партнером не удался', kind: 'error', services: ['adapter'], any: ['Обмен завершён'], not: ['исход=SUCCESS'], outcome: 'failure', provider: 'провайдер=(\\w+)' },
    { key: 'click', label: 'Действие в браузере', kind: 'action', services: ['web-front'], any: ['channel=client'], detail: 'eventName=(\\w+)' },
  ],
  hide: [{ logger: 'org.keycloak.models.sessions' }],
  providers: [{ key: 'mobile', label: 'Mobile ID', values: ['mobile-id'] }],
});

const T0 = Date.UTC(2026, 8, 30, 9, 0);
const ACC = '0f67f2df-cefa-4b00-b43c-f769a0000af4';
const kc = (s: number, message: string, trace = 't-1', extra: Partial<LogLine> = {}): LogLine => ({
  service: 'keycloak',
  t: T0 + s * 1000,
  level: 'INFO',
  logger: 'com.example.keycloak.Service',
  message,
  pod: 'p',
  version: '1',
  trace,
  ...extra,
});
const web = (s: number, message: string, trace: string, extra: Partial<LogLine> = {}): LogLine => ({ ...kc(s, message, trace), service: 'web-front', logger: 'route', ...extra });

const LINES: LogLine[] = [
  web(-5, `[send-event], channel=client, status=success, eventName=buttonTap, accountId=${ACC}`, 'r-1', { fields: { 'extra.referer': 'https://www.example.com/auth/' } }),
  kc(0, 'Проверка антифрода RBA для state = stateAAA111: status = success, score = 0'),
  kc(1, 'Основной вход по телефону: каскад remote для номера 79161234567', 't-2'),
  kc(1.5, 'session changed', 't-2', { logger: 'org.keycloak.models.sessions' }),
  kc(2, "Код отправлен провайдером 'mobile-id' на шаге SEND", 't-2'),
  kc(3, 'state = stateAAA111: форма кода', 't-2'),
  kc(20, '[NotificationGate; CallPassword] Введенный пользователем OTP-код: 1234', 't-3'),
  kc(20.5, 'Неверный код на провайдере', 't-3'),
  kc(21, 'state = stateAAA111: повторный ввод', 't-3'),
  kc(40, 'Телефонная аутентификация успешна', 't-4'),
  kc(40.2, 'state = stateAAA111: завершение', 't-4'),
  kc(41, 'POST https://www.example.com/auth/event', 't-4', { level: 'ERROR' }),
];

describe('attempt profile', () => {
  it('refuses repeated keys, unknown services, ids without patterns and fields, and fields with cookies or headers', () => {
    const problems = (p: unknown) => {
      const r = attemptProfileSchema.safeParse(p);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    const base = { title: 'x', services: [{ service: 'keycloak' }], ids: [{ key: 'state', label: 's', patterns: ['state=(\\w+)'] }] };
    expect(problems(base)).toEqual([]);
    expect(problems({ ...base, ids: [...base.ids, { key: 'state', label: 's', patterns: ['x(\\d)'] }] })).toContain('ключ state повторяется');
    expect(problems({ ...base, ids: [{ key: 'state', label: 's', fields: { gateway: 'state.keyword' } }] })).toContain('сервиса gateway нет в services пути');
    expect(problems({ ...base, ids: [{ key: 'state', label: 's' }] })).toContain('идентификатору нужны patterns или fields');
    expect(problems({ ...base, services: [{ service: 'keycloak', fields: [{ field: 'http_req_cookies', label: 'куки' }] }] })).toContain('куки, заголовки, токены и пароли путь не показывает');
    expect(problems({ ...base, ids: [{ key: 'phone', label: 'p', patterns: ['(7\\d{10})'], scope: 'person' }] })).toContain('нужен хотя бы один ключ попытки (scope: attempt)');
  });
});

describe('ids of a line', () => {
  it('are found by patterns in the text and by fields of the service, the phone brought to 7XXXXXXXXXX', () => {
    expect(lineIds(PROFILE, kc(1, 'Основной вход по телефону: каскад remote для номера +79161234567, state = stateAAA111'))).toEqual([
      { key: 'state', value: 'stateAAA111' },
      { key: 'phone', value: '79161234567' },
    ]);
    const adapter: LogLine = { ...kc(0, 'Построена ссылка авторизации: провайдер=partner1'), service: 'adapter', ids: { 'flowState.keyword': 'flow-0000-1111' } };
    expect(lineIds(PROFILE, adapter)).toEqual([{ key: 'state', value: 'flow-0000-1111' }]);
  });

  it('turn a phone typed by a person into 11 digits, show it on the screen and mask it for agents', () => {
    expect([phoneDigits('+7 (916) 123-45-67'), phoneDigits('89161234567'), phoneDigits('9161234567'), phoneDigits('12345')]).toEqual(['79161234567', '79161234567', '79161234567', null]);
    expect(formatPhone('79161234567')).toBe('+7 916 123-45-67');
    expect(maskPhone('79161234567')).toBe('+7 9** ***-**-67');
    expect(maskPhones('позвонить +7 (916) 123-45-67 или 89161234568, но не 1234567890123 и не код 7700')).toBe('позвонить +7 9** ***-**-67 или +7 9** ***-**-68, но не 1234567890123 и не код 7700');
  });
});

describe('lines of an attempt', () => {
  it('lose the headers of Logbook HTTP lines but keep the request, the duration and the body', () => {
    const logbook = 'Outgoing Request: 0123456789abcdef\nRemote: 10.0.0.1\nPOST https://api/phone-auth/start HTTP/1.1\nCookie: a=b\nX-Api-Key: secret\nContent-Type: application/json\n\n{"state":"s","phone":"79161234567"}';
    expect(cleanMessage(logbook)).toBe('Outgoing Request: 0123456789abcdef\nPOST https://api/phone-auth/start HTTP/1.1\n\n{"state":"s","phone":"79161234567"}');
    const response = 'Incoming Response: 0123456789abcdef\nDuration: 35 ms\nHTTP/1.1 200 OK\nContent-Type: application/json\n\n{"ok":true}\nRequest: POST https://api/x';
    expect(cleanMessage(response)).toBe('Incoming Response: 0123456789abcdef\nDuration: 35 ms\nHTTP/1.1 200 OK\n\n{"ok":true}\nRequest: POST https://api/x');
    expect(cleanMessage('Обычная строка: Header: value')).toBe('Обычная строка: Header: value');
  });

  it('get their meaning from the first fitting event rule with detail and provider, service rules only for their service', () => {
    expect(classifyAttemptLine(PROFILE, kc(2, "Код отправлен провайдером 'mobile-id' на шаге SEND"))).toMatchObject({ key: 'sent', kind: 'step', provider: 'Mobile ID', milestone: true });
    expect(classifyAttemptLine(PROFILE, kc(0, 'Проверка антифрода RBA для state = s1: score = 90'))?.detail).toBe('90');
    const fail = { ...kc(0, 'Обмен завершён: провайдер=partner2, исход=PROVIDER_ERROR'), service: 'adapter' };
    expect(classifyAttemptLine(PROFILE, fail)).toMatchObject({ kind: 'error', outcome: 'failure', provider: 'partner2' });
    expect(classifyAttemptLine(PROFILE, kc(0, 'Обмен завершён: провайдер=partner2, исход=PROVIDER_ERROR'))).toBeNull();
    expect(hiddenLine(PROFILE, kc(0, 'x', 't', { logger: 'org.keycloak.models.sessions' }))).toBe(true);
  });
});

describe('path of one attempt', () => {
  it('lays the lines out in time with the gap to the previous one, errors by rule and by level, and hides service lines', () => {
    const { steps, summary } = attemptPath(PROFILE, LINES);
    expect(steps).toHaveLength(LINES.length - 1);
    expect(summary.hidden).toBe(1);
    expect(steps[0]).toMatchObject({ service: 'web-front', event: { key: 'click', detail: 'buttonTap' }, fields: [{ label: 'страница', value: 'https://www.example.com/auth/' }], sinceStart: 0 });
    expect(steps[2]).toMatchObject({ event: { key: 'phone' }, sincePrev: 1000, sinceStart: 6000 });
    expect(steps.filter((s) => s.error).map((s) => s.event?.label ?? s.message)).toEqual(['Неверный код', 'POST https://www.example.com/auth/event']);
    // Служебное правило для всех строк сервиса ошибку уровня ERROR не прячет, а сводка подписывает ее текстом строки.
    const wide = attemptProfileSchema.parse({ ...PROFILE, events: [...PROFILE.events, { key: 'any_kc', label: 'Строка Keycloak', kind: 'info', services: ['keycloak'] }] });
    const path = attemptPath(wide, LINES);
    expect(path.steps.at(-1)).toMatchObject({ event: { key: 'any_kc' }, error: true });
    expect(path.summary.errors.map((e) => e.label)).toEqual(['Неверный код', 'POST https://www.example.com/auth/event']);
  });

  it('sums up start, duration, outcome, providers, milestones with the time between them and every id found', () => {
    const { summary } = attemptPath(PROFILE, LINES);
    expect(summary).toMatchObject({ start: T0 - 5000, end: T0 + 41_000, durationMs: 46_000, outcome: 'success', outcomeLabel: 'Вход по телефону успешен', providers: ['Mobile ID'] });
    expect(summary.milestones.map((m) => [m.label, m.sincePrev])).toEqual([
      ['Риск-проверка антифрода', null],
      ['Введен номер', 1000],
      ['Код отправлен', 1000],
      ['Вход по телефону успешен', 38_000],
    ]);
    expect(summary.ids).toEqual([
      { key: 'state', label: 'state', sensitive: false, scope: 'attempt', values: ['stateAAA111'] },
      { key: 'accountid', label: 'accountId', sensitive: false, scope: 'person', values: [ACC] },
      { key: 'phone', label: 'телефон', sensitive: true, scope: 'person', values: ['79161234567'] },
      { key: 'code', label: 'код', sensitive: true, scope: 'detail', values: ['1234'] },
    ]);
    expect(summary.services.map((s) => [s.service, s.lines])).toEqual([
      ['keycloak', 10],
      ['web-front', 1],
    ]);
    expect(attemptPath(PROFILE, []).summary).toMatchObject({ start: null, outcome: 'unknown', durationMs: 0 });
  });

  it('links lines by keys of the attempt and by traces, but not by the phone or accountId of the person', () => {
    const other = kc(100, 'Основной вход по телефону: каскад remote для номера 79161234567, state = stateBBB222', 't-9');
    const links = linkLines(PROFILE, [...LINES, other]);
    expect(new Set(links.group.slice(1, LINES.length).filter((g, i) => !hiddenLine(PROFILE, LINES[i + 1]!)))).toEqual(new Set([links.group[1]]));
    expect(links.group.at(-1)).not.toBe(links.group[1]);
    expect(links.keyed[links.group[0]!]).toBe(false);
  });

  it('keeps the lines of the seed attempt and nearby lines without keys, and returns other attempts of the person apart', () => {
    const other = [kc(300, 'Проверка антифрода RBA для state = stateBBB222: status = success, score = 0', 't-9'), kc(301, 'Основной вход по телефону: каскад remote для номера 79161234567', 't-9')];
    const far = web(5000, `[send-event], channel=client, status=success, eventName=viewBlock, accountId=${ACC}`, 'r-2');
    const { lines, others } = selectAttempt(PROFILE, [...LINES, ...other, far], ['stateAAA111'], 15 * 60_000);
    expect(lines).toHaveLength(LINES.length);
    expect(others).toHaveLength(1);
    expect(others[0]!.summary.ids.find((i) => i.key === 'state')?.values).toEqual(['stateBBB222']);
    // Трасса тоже годится началом пути: попытка - компонента строки с этой трассой.
    expect(selectAttempt(PROFILE, [...LINES, ...other], ['t-9'], 15 * 60_000).lines.map((l) => l.trace)).toEqual(['t-9', 't-9']);
  });

  it('groups the lines found by a search into attempts, newest first, giving loose lines to the nearest attempt', () => {
    const second = [kc(600, 'Проверка антифрода RBA для state = stateCCC333: status = success, score = 0', 't-7'), kc(601, 'Телефонная аутентификация успешна', 't-7')];
    const groups = groupAttempts(PROFILE, [...LINES, ...second], 15 * 60_000);
    expect(groups.map((g) => [g.summary.ids[0]?.values[0], g.summary.outcome, g.lines.length])).toEqual([
      ['stateCCC333', 'success', 2],
      ['stateAAA111', 'success', LINES.length],
    ]);
    const loose = groupAttempts(PROFILE, [LINES[0]!], 15 * 60_000);
    expect(loose).toHaveLength(1);
  });
});
