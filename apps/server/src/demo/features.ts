import { localDay, MINUTE, type LogFilter, type LogLine, type MonitorServiceProfile } from '@task-pilot/step-kit';
import { hash01 } from './logs.ts';

/** Сервис учебной фичи: калькулятор учебной команды. */
export const STORY_SERVICE = 'calculator';
/** Сервисы, в которых учебная фича пишет строки пути одной операции. */
const STORY_SERVICES = new Set([STORY_SERVICE, 'gateway', 'audit']);
/** Учебная фича началась за 30 дней до запуска демо: дневные итоги видны с первого дня. */
const SINCE_DAYS = 30;
const VERSIONS = ['1.0.272-master', '1.0.273-master'];

const pick = (seed: string, p: number) => hash01(seed) < p;
const hex = (seed: string, n: number) => Array.from({ length: n }, (_, i) => Math.floor(hash01(`${seed}:${i}`) * 16).toString(16)).join('');
const stateOf = (seed: string) => Array.from({ length: 32 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(hash01(`${seed}/${i}`) * 62)]).join('');

/** Сессий учебной фичи в минуту: суточный ход, днем больше. */
function sessionsIn(minute: number): number {
  const hourMsk = ((minute / 60 + 3) % 24 + 24) % 24;
  const daily = 0.3 + 0.7 * (1 + Math.sin((2 * Math.PI * (hourMsk - 9)) / 24)) / 2;
  return Math.floor(2.4 * daily + hash01(`story-n:${minute}`));
}

const uuidOf = (seed: string) => `${hex(`${seed}1`, 8)}-${hex(`${seed}2`, 4)}-4${hex(`${seed}3`, 3)}-a${hex(`${seed}4`, 3)}-${hex(`${seed}5`, 12)}`;

/**
 * Строки одной минуты учебной фичи "Подтверждение операции": каждая операция калькулятора пишет строку приема, четверть
 * операций просит подтверждение, тестовые пользователи идут без него, подтвержденные получают результат в той же
 * трассе и callback с сессией; редкие боты повторяют показ формы много раз, редкие сбои - недоступный сервис.
 *
 * Для пути одной операции строки связаны, как у настоящего входа: калькулятор передает операцию в шлюз с correlationId
 * и HTTP-строкой Logbook (в ней учебный телефон), шлюз шлет код и пишет клиентские события страницы по clientId, аудит
 * пишет журнал с flowState из строки подтверждения. Телефоны учебные, вида 7900XXXXXXX.
 */
function minuteLines(minute: number, deployAt: number): LogLine[] {
  const out: LogLine[] = [];
  for (let i = 0; i < sessionsIn(minute); i++) {
    const seed = `story:${minute}:${i}`;
    const t0 = minute * MINUTE + Math.floor(hash01(`${seed}t`) * 50_000);
    const state = stateOf(seed);
    const trace1 = hex(`${seed}a`, 32);
    const trace2 = hex(`${seed}b`, 32);
    const client = uuidOf(`${seed}c`);
    const add = (t: number, message: string, trace: string, level = 'INFO', logger = 'demo.calculator.ConfirmGate') =>
      out.push({ service: STORY_SERVICE, t, level, logger, message, pod: `calculator-deployment-${hex(`pod${t < deployAt ? 0 : 1}`, 9)}-a1b2c`, version: VERSIONS[t < deployAt ? 0 : 1]!, trace });
    const gateway = (t: number, message: string, page?: string) =>
      out.push({ service: 'gateway', t, level: 'INFO', logger: 'demo.gateway.RequestHandler', message, pod: `demo-gateway-deployment-${hex('gw', 9)}-a1b2c`, version: '1.0.176-master', ...(page ? { fields: { page } } : {}) });
    add(t0, `Операция принята: state = ${state}, канал = web, clientId=${client}`, trace1);
    if (!pick(`${seed}e`, 0.25)) continue;
    const corr = uuidOf(`${seed}r`);
    const phone = `7900${String(Math.floor(hash01(`${seed}ph`) * 1e7)).padStart(7, '0')}`;
    gateway(t0 - 3000, `[send-event], channel=client, eventName=openForm, clientId=${client}`, 'https://demo.invalid/calculator/');
    add(t0 + 1000, `Проверка операции для state = ${state}: нужно подтверждение, сумма=${100 + Math.floor(hash01(`${seed}s`) * 9) * 100}`, trace1);
    if (pick(`${seed}k`, 0.06)) {
      add(t0 + 1500, `Подтверждение для state = ${state}: тестовый пользователь, подтверждение не требуется`, trace1);
      continue;
    }
    add(t0 + 1100, `Операция передана в шлюз, state = ${state}, correlationId=${corr}`, trace1);
    add(
      t0 + 1200,
      `Outgoing Request: ${hex(`${seed}lb`, 16)}\nRemote: gateway.demo.invalid\nPOST https://gateway.demo.invalid/api/confirm/send HTTP/1.1\nX-Api-Key: demo-key\nContent-Type: application/json\n\n{"correlationId":"${corr}","phone":"${phone}"}`,
      trace1,
      'TRACE',
      'org.zalando.logbook.Logbook',
    );
    gateway(t0 + 1300, `Операция передана дальше, correlation id '${corr}'`);
    gateway(t0 + 1500, `Код подтверждения отправлен на номер ${phone}, correlation id '${corr}'`);
    const bot = pick(`${seed}bot`, 0.01);
    const shows = bot ? 8 : pick(`${seed}r`, 0.1) ? 2 : 1;
    for (let k = 0; k < shows; k++) add(t0 + 2000 + k * 2500, `Подтверждение для state = ${state}: показана форма подтверждения`, trace1);
    if (pick(`${seed}x`, 0.02)) add(t0 + 4000, `Подтверждение для state = ${state}: сервис подтверждения недоступен, форма показана повторно`, trace1, 'WARN');
    if (!(bot || pick(`${seed}p`, 0.85))) {
      gateway(t0 + 2600, `[send-event], channel=client, eventName=closeForm, clientId=${client}`, 'https://demo.invalid/calculator/confirm');
      continue;
    }
    const passedAt = t0 + 2000 + (shows - 1) * 2500 + 3000 + Math.floor(hash01(`${seed}d`) ** 2 * 40_000);
    if (pick(`${seed}w`, 0.08)) {
      // Неверный код - между последним показом формы и подтверждением.
      const wrongAt = t0 + 3500 + (shows - 1) * 2500;
      add(wrongAt, `Введенный пользователем код подтверждения: ${String(1000 + Math.floor(hash01(`${seed}wc`) * 9000))}`, trace2);
      add(wrongAt + 100, `Неверный код подтверждения для state = ${state}`, trace2, 'WARN');
    }
    gateway(passedAt - 700, `[send-event], channel=client, eventName=buttonTap, clientId=${client}`, 'https://demo.invalid/calculator/confirm');
    add(passedAt - 400, `Введенный пользователем код подтверждения: ${String(1000 + Math.floor(hash01(`${seed}code`) * 9000))}`, trace2);
    const flow = uuidOf(`${seed}f`);
    add(passedAt, `Подтверждение для state = ${state}: принято, flowState=${flow}`, trace2);
    out.push({ service: 'audit', t: passedAt + 200, level: 'INFO', logger: 'demo.audit.AuditWriter', message: 'Операция записана в журнал', pod: `demo-audit-deployment-${hex('au', 9)}-a1b2c`, version: '1.0.24-master', ids: { 'flowState.keyword': flow } });
    if (pick(`${seed}lim`, 0.04)) add(passedAt + 300, 'Превышен лимит операций для пользователя, отказ', trace2, 'WARN');
    else if (pick(`${seed}done`, 0.92)) add(passedAt + 300, `Результат отправлен в канал '${pick(`${seed}ch`, 0.8) ? 'web' : 'push'}'`, trace2);
    if (!bot && pick(`${seed}login`, 0.88)) add(passedAt + 1200, `POST https://demo.invalid/api/result {"state":"${state}","channel":"web"}`, trace2);
  }
  return out;
}

/** Строка проходит отбор: фразы в тексте, уровни и значения полей трассы и идентификаторов. */
export function passes(s: MonitorServiceProfile, l: LogLine, f: LogFilter): boolean {
  const has = (p: string) => l.message.includes(p);
  if (!f.match.every(has)) return false;
  if (!f.anyOf.every((g) => g.some(has))) return false;
  if (f.not.some(has)) return false;
  if (f.level.length && !f.level.includes(l.level)) return false;
  return (f.terms ?? []).every((t) => {
    const value = t.field === s.fields.trace ? l.trace : l.ids?.[t.field];
    return value !== undefined && t.values.includes(value);
  });
}

/** Истории учебной фичи: строки сессий по минутам, с кэшем минут, чтобы дневные итоги за недели не пересобирались. */
export function storyLines(now: () => number, deployAt: () => number) {
  const cache = new Map<number, LogLine[]>();
  const start = () => Math.floor((now() - SINCE_DAYS * 24 * 60 * MINUTE) / MINUTE);
  const minute = (m: number) => {
    let lines = cache.get(m);
    if (!lines) {
      lines = minuteLines(m, deployAt());
      cache.set(m, lines);
      if (cache.size > 60_000) cache.delete(cache.keys().next().value!);
    }
    return lines;
  };
  /** Строки сервиса за окно, которые прошли проверку, от старых к новым. */
  const scan = (s: MonitorServiceProfile, from: number, to: number, test: (l: LogLine) => boolean): LogLine[] => {
    if (!STORY_SERVICES.has(s.id)) return [];
    const out: LogLine[] = [];
    const end = Math.min(to, now());
    // Строки минуты могут уходить на секунды назад (клиентские события раньше приема операции): минута берется с запасом.
    for (let m = Math.max(Math.floor(from / MINUTE) - 1, start()); m * MINUTE < end; m++) {
      for (const l of minute(m)) if (l.service === s.id && l.t >= from && l.t < end && test(l)) out.push(l);
    }
    return out.sort((a, b) => a.t - b.t);
  };
  /** Строки окна, которые прошли отбор, от старых к новым. */
  const between = (s: MonitorServiceProfile, f: LogFilter, from: number, to: number): LogLine[] => scan(s, from, to, (l) => passes(s, l, f));
  return {
    between,
    /** Строки окна с любым из значений: фразой в тексте (text) или точным значением полей (трасса, идентификаторы, поля для экрана). */
    match(s: MonitorServiceProfile, f: LogFilter, values: string[], fields: string[], text: boolean, from: number, to: number): LogLine[] {
      const wanted = new Set(values);
      const valueOf = (l: LogLine, field: string) => (field === s.fields.trace ? l.trace : (l.ids?.[field] ?? l.fields?.[field]));
      return scan(s, from, to, (l) => passes(s, l, f) && ((text && values.some((v) => l.message.includes(v))) || fields.some((x) => wanted.has(valueOf(l, x) ?? ''))));
    },
    /** Строк по каждому правилу за каждый день окна в часовом поясе. */
    daily(s: MonitorServiceProfile, base: LogFilter, rules: Record<string, LogFilter>, from: number, to: number, timeZone: string): Record<string, Record<string, number>> {
      const days: Record<string, Record<string, number>> = {};
      for (const l of between(s, base, from, to)) {
        const d = (days[localDay(l.t, timeZone)] ??= Object.fromEntries(Object.keys(rules).map((k) => [k, 0])));
        for (const [k, f] of Object.entries(rules)) if (passes(s, l, f)) d[k]!++;
      }
      return days;
    },
  };
}
