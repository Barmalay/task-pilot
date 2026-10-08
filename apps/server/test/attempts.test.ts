import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_FIELD, HOUR, MINUTE, monitorProfileSchema, type LogLine, type LogRequest, type LogResult, type MonitorLogsPort, type MonitorProfile } from '@task-pilot/step-kit';
import { AttemptService } from '../src/monitor/attempts.ts';
import { createMonitorPort } from '../src/monitor/port.ts';

const MONITOR: MonitorProfile = monitorProfileSchema.parse({
  source: { id: 'es-prod', mcp: 'elasticsearch' },
  services: [
    {
      id: 'keycloak',
      title: 'Keycloak',
      index: 'kc-*',
      container: 'gate',
      fields: { message: 'message', level: 'level', logger: 'loggerName.keyword', version: 'v.keyword', pod: 'p.keyword', trace: 'mdc.traceId.keyword' },
    },
    {
      id: 'adapter',
      title: 'Адаптер',
      index: 'fb-*',
      container: 'adapter',
      fields: { message: 'messagetext', level: 'level.keyword', logger: 'logger.keyword', version: 'v.keyword', pod: 'p.keyword' },
      ids: ['flowState.keyword'],
    },
    {
      id: 'web-front',
      title: 'web-front',
      index: 'k8s-*',
      container: 'web-front',
      fields: { message: 'message', level: 'level_name.keyword', logger: 'route.keyword', version: 'v.keyword', pod: 'p.keyword', trace: 'request_id.keyword' },
    },
  ],
});

const ATTEMPT = {
  title: 'Путь попытки входа',
  services: [
    { service: 'keycloak', traces: true },
    { service: 'adapter' },
    { service: 'web-front', fields: [{ field: 'extra.referer', label: 'страница' }] },
  ],
  ids: [
    { key: 'state', label: 'state', patterns: ['\\bstate ?= ?([A-Za-z0-9_-]{8,64})'], fields: { 'adapter': 'flowState.keyword' } },
    { key: 'accountid', label: 'accountId', patterns: ['accountId=([0-9a-f-]{36})'], fields: { 'web-front': 'extra.account_id.keyword' }, scope: 'person', services: ['keycloak', 'web-front'] },
    { key: 'phone', label: 'телефон', patterns: ['номер[ау]? (7\\d{10})'], scope: 'person', sensitive: true, normalize: 'phone' },
    { key: 'code', label: 'код', patterns: ['OTP-код: (\\d{4})'], scope: 'detail', sensitive: true },
  ],
  events: [
    { key: 'phone', label: 'Введен номер', kind: 'action', any: ['Основной вход по телефону'], milestone: true },
    { key: 'sent', label: 'Код отправлен', kind: 'step', any: ['Код отправлен провайдером'], provider: "провайдером '([^']+)'", milestone: true },
    { key: 'wrong', label: 'Неверный код', kind: 'error', any: ['Неверный код'], search: true },
    { key: 'ok', label: 'Вход по телефону успешен', kind: 'outcome', any: ['Телефонная аутентификация успешна'], outcome: 'success', milestone: true },
    { key: 'click', label: 'Действие в браузере', kind: 'action', services: ['web-front'], any: ['channel=client'], detail: 'eventName=(\\w+)' },
  ],
  providers: [{ key: 'mobile', label: 'Mobile ID', values: ['mobile-id'] }],
};

const NOW = Date.UTC(2026, 9, 1, 12, 0);
const A = NOW - 30 * MINUTE;
const ACC = '0f67f2df-cefa-4b00-b43c-f769a0000af4';
const PHONE = '79161234567';
const line = (service: string, t: number, message: string, extra: Partial<LogLine> = {}): LogLine => ({ service, t, level: 'INFO', logger: 'x', message, pod: 'p', version: 'v', ...extra });

/**
 * Две попытки одного человека: первая (stateAAA111) с неверным кодом и успехом, вторая (stateBBB222) через 5 минут без
 * итога. Строки без state связаны с попыткой трассой, клиентские события web-front - accountId.
 */
const UNIVERSE: LogLine[] = [
  line('web-front', A - 4000, `[send-event], channel=client, eventName=buttonTap, accountId=${ACC}`, { trace: 'r-1', ids: { 'extra.account_id.keyword': ACC }, fields: { 'extra.referer': 'https://www.example.com/auth/' } }),
  line('keycloak', A, `Фрод-проверка: state=stateAAA111, accountId=${ACC}`, { trace: 't-1' }),
  line('keycloak', A + 1000, `Основной вход по телефону: каскад remote для номера ${PHONE}`, { trace: 't-2' }),
  line('keycloak', A + 1100, 'state = stateAAA111: форма кода', { trace: 't-2' }),
  line('keycloak', A + 2000, "Код отправлен провайдером 'mobile-id' на шаге SEND", { trace: 't-2' }),
  line('keycloak', A + 20_000, 'Введенный пользователем OTP-код: 1234', { trace: 't-3' }),
  line('keycloak', A + 20_100, 'Неверный код на провайдере', { trace: 't-3' }),
  line('keycloak', A + 20_200, 'state = stateAAA111: повтор', { trace: 't-3' }),
  line('keycloak', A + 40_000, 'Телефонная аутентификация успешна', { trace: 't-4' }),
  line('keycloak', A + 40_100, 'state = stateAAA111: завершение, flow state=flow-1111-2222', { trace: 't-4' }),
  line('adapter', A + 40_500, 'Построена ссылка авторизации: провайдер=partner1', { ids: { 'flowState.keyword': 'flow-1111-2222' } }),
  line('keycloak', A + 5 * MINUTE, `Основной вход по телефону: каскад remote для номера ${PHONE}`, { trace: 't-9' }),
  line('keycloak', A + 5 * MINUTE + 100, 'state = stateBBB222: форма кода', { trace: 't-9' }),
  line('keycloak', A - 3 * HOUR, 'state = stateOLD000: давно', { trace: 't-0' }),
];

/** Логи по UNIVERSE: match - по значениям в тексте и полях, lines - по фразам признака, новые первыми. */
function logsOf(universe = UNIVERSE): MonitorLogsPort & { requests: LogRequest[] } {
  const requests: LogRequest[] = [];
  const valueOf = (l: LogLine, field: string, trace?: string) => (field === trace ? l.trace : (l.ids?.[field] ?? l.fields?.[field]));
  const answer = (r: LogRequest): LogResult => {
    const own = universe.filter((l) => l.service === r.service.id && l.t >= r.from && l.t < r.to);
    if (r.kind === 'match') {
      const wanted = new Set(r.values);
      const found = own.filter((l) => (r.text && r.values.some((v) => l.message.includes(v))) || r.fields.some((f) => wanted.has(valueOf(l, f, r.service.fields.trace) ?? '')));
      return { kind: 'match', lines: found, capped: false };
    }
    if (r.kind === 'lines') {
      const f = r.filter;
      const found = own.filter((l) => f.match.every((p) => l.message.includes(p)) && f.anyOf.every((g) => g.some((p) => l.message.includes(p))) && !f.not.some((p) => l.message.includes(p)));
      return { kind: 'lines', lines: found.reverse().slice(0, r.size) };
    }
    throw new Error(`неожиданный запрос ${r.kind}`);
  };
  return {
    requests,
    async run(rs) {
      requests.push(...rs);
      return rs.map(answer);
    },
    stats: () => ({ windowMs: 300_000, calls: 1, searches: requests.length, cached: 0, errors: 0, avgTookMs: 20, lastError: null }),
  };
}

function setup(o: { attempt?: unknown; logs?: ReturnType<typeof logsOf> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-attempts-'));
  const file = join(dir, 'attempt.yaml');
  if (o.attempt !== null) writeFileSync(file, typeof o.attempt === 'string' ? o.attempt : stringify(o.attempt ?? ATTEMPT));
  const logs = o.logs ?? logsOf();
  const port = createMonitorPort({ profile: MONITOR, dir: join(dir, 'dashboards'), attempt: file, logs });
  return { logs, port, service: new AttemptService({ port, now: () => NOW }) };
}

const matches = (rs: LogRequest[]) => rs.filter((r): r is Extract<LogRequest, { kind: 'match' }> => r.kind === 'match');

describe('path of one attempt', () => {
  it('starts from the state around the moment, follows keys, person ids and traces found in its lines, round by round', async () => {
    const { service, logs } = setup();
    const path = await service.path({ ids: ['stateAAA111'], at: A });
    expect(path.range).toEqual({ from: A - 2 * HOUR, to: NOW });
    const first = matches(logs.requests).slice(0, 3);
    expect(first.map((r) => [r.service.id, r.values, r.fields, r.text])).toEqual([
      ['keycloak', ['stateAAA111'], ['mdc.traceId.keyword'], true],
      ['adapter', ['stateAAA111'], ['flowState.keyword'], true],
      ['web-front', ['stateAAA111'], ['extra.account_id.keyword', 'request_id.keyword'], true],
    ]);
    expect(first[2]!.extra).toEqual(['extra.referer']);
    // Трассы идут отдельным поиском только по полю трассы; круги - в запасе 15 минут вокруг найденного.
    const traces = matches(logs.requests).filter((r) => !r.text);
    expect(traces[0]).toMatchObject({ service: { id: 'keycloak' }, fields: ['mdc.traceId.keyword'], values: ['t-1', 't-2', 't-3', 't-4'] });
    expect(traces[0]!.from).toBe(A - 15 * MINUTE);
    expect(path.rounds).toBeGreaterThanOrEqual(2);

    expect(path.steps.map((s) => s.event?.label ?? s.message)).toEqual([
      'Действие в браузере',
      `Фрод-проверка: state=stateAAA111, accountId=${ACC}`,
      'Введен номер',
      'state = stateAAA111: форма кода',
      'Код отправлен',
      'Введенный пользователем OTP-код: 1234',
      'Неверный код',
      'state = stateAAA111: повтор',
      'Вход по телефону успешен',
      'state = stateAAA111: завершение, flow state=flow-1111-2222',
      'Построена ссылка авторизации: провайдер=partner1',
    ]);
    expect(path.summary).toMatchObject({ outcome: 'success', providers: ['Mobile ID'], durationMs: 44_500 });
    expect(path.summary.ids.find((i) => i.key === 'phone')).toMatchObject({ sensitive: true, values: [PHONE] });
    expect(path.summary.ids.find((i) => i.key === 'code')).toMatchObject({ sensitive: true, values: ['1234'] });
    // Вторая попытка того же человека найдена по телефону, но в путь не смешана.
    expect(path.others.map((o) => [o.key, o.outcome])).toEqual([['stateBBB222', 'unknown']]);
    // Код - подробность: по нему строки не ищутся.
    expect(matches(logs.requests).some((r) => r.values.includes('1234'))).toBe(false);
  });

  it('refuses ids that are not ids, and never asks the logs for cookies or headers', async () => {
    const { service, logs } = setup({ attempt: { ...ATTEMPT, services: [{ service: 'keycloak', traces: true }, { service: 'web-front', fields: [{ field: 'http_req_cookies', label: 'куки' }] }] } });
    await expect(service.path({ ids: ['a b'] })).rejects.toMatchObject({ statusCode: 400 });
    expect(service.profile().error).toContain('куки, заголовки, токены и пароли путь не показывает');
    await service.path({ ids: ['stateAAA111'] });
    expect(matches(logs.requests).flatMap((r) => [...r.fields, ...(r.extra ?? [])]).some((f) => FORBIDDEN_FIELD.test(f))).toBe(false);
  });

  it('follows the id fields of the panel services when the team pack has no attempt.yaml', async () => {
    const state = 'i27JCOsA3FS93OelYtPJPp7Z7rm0DsvV';
    const broker = '0801fff4-3d3a-40f5-8a26-fa1d24692f3b';
    const universe = [
      line('keycloak', A, `Проверка антифрода RBA для state = ${state}: status = success`, { trace: 't-1' }),
      line('keycloak', A + 1000, `GET /broker/partner1/endpoint?code=x&state=${broker}`, { trace: 't-1' }),
      line('adapter', A + 2000, 'Построена ссылка авторизации', { ids: { 'flowState.keyword': broker } }),
    ];
    const { service, logs } = setup({ attempt: null, logs: logsOf(universe) });
    expect(service.profile()).toMatchObject({ configured: false, title: 'Одна попытка входа', error: null });
    const path = await service.path({ ids: [state], at: A });
    expect(matches(logs.requests)[1]).toMatchObject({ service: { id: 'adapter' }, fields: ['flowState.keyword'] });
    expect(path.summary.services.map((s) => s.service)).toEqual(['keycloak', 'adapter']);
  });
});

describe('search of attempts', () => {
  it('finds the attempts of a phone in the window, newest first, with outcome and provider gathered from their traces', async () => {
    const { service, logs } = setup();
    const r = await service.search({ ids: [], phone: '+7 (916) 123-45-67' });
    expect(r.range).toEqual({ from: NOW - 24 * HOUR, to: NOW });
    expect(r.attempts.map((a) => [a.key, a.outcome, a.providers])).toEqual([
      ['stateBBB222', 'unknown', []],
      ['stateAAA111', 'success', ['Mobile ID']],
    ]);
    // Телефон ищется фразой в тексте, без полей.
    expect(matches(logs.requests)[0]).toMatchObject({ values: [PHONE], fields: [], text: true });
  });

  it('keeps only attempts that have every value, the sign, the provider and the outcome asked for', async () => {
    const { service } = setup();
    expect((await service.search({ ids: ['stateAAA111'], phone: PHONE })).attempts.map((a) => a.key)).toEqual(['stateAAA111']);
    expect((await service.search({ ids: [], phone: PHONE, outcome: 'success' })).attempts.map((a) => a.key)).toEqual(['stateAAA111']);
    expect((await service.search({ ids: [], phone: PHONE, provider: 'mobile' })).attempts.map((a) => a.key)).toEqual(['stateAAA111']);
    expect((await service.search({ ids: [], sign: 'event:wrong' })).attempts.map((a) => a.key)).toEqual(['stateAAA111']);
    expect((await service.search({ ids: [ACC] })).attempts.map((a) => a.key)).toEqual(['stateAAA111']);
  });

  it('asks for at least one value, a real phone and a window of at most a week', async () => {
    const { service } = setup();
    await expect(service.search({ ids: [] })).rejects.toThrow('Нужен идентификатор, телефон или признак попытки');
    await expect(service.search({ ids: [], phone: '123' })).rejects.toThrow('Телефон - 10 или 11 цифр');
    await expect(service.search({ ids: ['x'] })).rejects.toThrow('Идентификатор - 4-128 символов');
    await expect(service.search({ ids: ['stateAAA111'], from: NOW - 8 * 24 * HOUR })).rejects.toThrow('не длиннее недели');
    await expect(service.search({ ids: ['stateAAA111'], from: NOW, to: NOW - 1 })).rejects.toThrow('Начало окна позже его конца');
    await expect(service.search({ ids: [], sign: 'event:nope' })).rejects.toThrow('Признака nope нет в профиле пути');
  });

  it('offers the searchable events of the path and the stages of the features as signs', () => {
    const { service } = setup();
    const p = service.profile();
    expect(p).toMatchObject({ configured: true, title: 'Путь попытки входа', windowMs: 2 * HOUR, providers: [{ key: 'mobile', label: 'Mobile ID' }] });
    expect(p.signs).toEqual([{ key: 'event:wrong', label: 'Неверный код', group: 'Путь попытки входа' }]);
    expect(p.ids.find((i) => i.key === 'phone')).toEqual({ key: 'phone', label: 'телефон', scope: 'person', sensitive: true });
  });
});
