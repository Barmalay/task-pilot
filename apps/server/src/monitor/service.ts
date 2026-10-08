import {
  bucketOf,
  DEFAULT_CONTAINER_FIELD,
  deploysOf,
  durationMs,
  filterOf,
  headlinePanels,
  HOUR,
  metricFilters,
  MINUTE,
  panelService,
  PERIODS,
  planAlert,
  planHeadline,
  planPanel,
  rangeOf,
  REFRESH_OPTIONS,
  serviceOf,
  type Breakdown,
  type Dashboard,
  type Headline,
  type IssueRef,
  type JiraPort,
  type LogFilter,
  type LogLine,
  type LogRequest,
  type LogResult,
  type MonitorPort,
  type MonitorProfile,
  type MonitorServiceProfile,
  type Panel,
  type Period,
  type Refresh,
  type TimeRange,
} from '@task-pilot/step-kit';
import type { EventBus } from '../engine/events.ts';
import type {
  DashboardDataDto,
  MonitorAlertDto,
  MonitorCardDto,
  MonitorLinesDto,
  MonitorOverviewDto,
  MonitorTaskDto,
  PanelBreakdownDto,
} from '@task-pilot/api-types';
import type { MonitorAlertRow, Store } from '../store/db.ts';

/** Как долго живут задачи в статусе мониторинга и названия эпиков из Jira. */
const TASKS_TTL = 5 * MINUTE;
/** Как часто сервер смотрит, каким дашбордам пора проверить алерты. */
const TICK_MS = 15_000;
/** Алерты проверяются не чаще этого, даже если страница опрашивается чаще. */
const ALERT_MIN_INTERVAL = 30_000;
/** Порция строк лога при провале до строк. */
const LINES_PAGE = 50;

/** Ошибка запроса к панели с HTTP-статусом. */
export class MonitorError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Зависимости сервиса панели мониторинга. */
export interface MonitorServiceDeps {
  port: MonitorPort;
  /** Профиль панели: источник и Kibana для ссылок; null - панель не настроена. */
  profile: MonitorProfile | null;
  jira: JiraPort;
  jiraBaseUrl: string;
  store: Store;
  bus: EventBus;
  now?: () => number;
}

const kqlString = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const rison = (v: string) => `'${v.replace(/!/g, '!!').replace(/'/g, "!'")}'`;

/** KQL отбора строк сервиса: так же, как запрос панели, чтобы в Discover были те же строки. */
export function kqlOf(s: MonitorServiceProfile, f: LogFilter): string {
  const field = s.fields.message.replace(/\.keyword$/, '');
  const parts = [`${s.fields.container ?? DEFAULT_CONTAINER_FIELD} : ${kqlString(s.container)}`];
  for (const p of f.match) parts.push(`${field} : ${kqlString(p)}`);
  for (const group of f.anyOf) parts.push(`(${group.map((p) => `${field} : ${kqlString(p)}`).join(' or ')})`);
  for (const p of f.not) parts.push(`not ${field} : ${kqlString(p)}`);
  if (f.level.length) parts.push(`${s.fields.level} : (${f.level.map(kqlString).join(' or ')})`);
  return parts.join(' and ');
}

/** Ссылка в Discover Kibana прода на те же строки за то же окно; null - у сервиса не задан data view. */
export function discoverUrl(kibana: string | undefined, s: MonitorServiceProfile, f: LogFilter, range: TimeRange): string | null {
  if (!kibana || !s.dataView) return null;
  const g = `(time:(from:${rison(new Date(range.from).toISOString())},to:${rison(new Date(range.to).toISOString())}))`;
  const a = `(index:${rison(s.dataView)},query:(language:kuery,query:${rison(kqlOf(s, f))}))`;
  return `${kibana.replace(/\/+$/, '')}/app/discover#/?_g=${encodeURIComponent(g)}&_a=${encodeURIComponent(a)}`;
}

/** Результаты по планам: у каждого плана свой отрезок общего списка ответов. */
function split<T extends { requests: LogRequest[] }>(plans: T[], results: LogResult[]): { plan: T; results: LogResult[] }[] {
  let i = 0;
  return plans.map((plan) => {
    const part = results.slice(i, i + plan.requests.length);
    i += plan.requests.length;
    return { plan, results: part };
  });
}

/**
 * Панель мониторинга прода: обзор задач по эпикам, данные дашбордов за период, провал до разбивки панели, строк лога и
 * одной попытки входа, фоновая проверка алертов. Все запросы к логам уходят через порт одним пакетом на экран, так
 * что кластер получает _msearch на обзор или дашборд, а не по запросу на панель.
 */
export class MonitorService {
  private readonly d: MonitorServiceDeps;
  private jiraCache: { at: number; tasks: IssueRef[]; byKey: Map<string, IssueRef>; error: string | null } | null = null;
  private readonly lastCheck = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;

  constructor(d: MonitorServiceDeps) {
    this.d = d;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private dashboard(id: string): Dashboard {
    const d = this.d.port.dashboards().dashboards.find((x) => x.id === id);
    if (!d) throw new MonitorError(`Дашборд ${id} не найден`, 404);
    return d;
  }

  private panel(d: Dashboard, panelId: string): Panel {
    const p = d.panels.find((x) => x.id === panelId);
    if (!p) throw new MonitorError(`Панели ${panelId} нет в дашборде ${d.id}`, 404);
    return p;
  }

  /** Интервал опроса дашборда: выбранный на странице или из файла. */
  refreshOf(d: Dashboard): Refresh {
    const saved = this.d.store.monitorRefresh(d.id);
    return saved && (REFRESH_OPTIONS as readonly string[]).includes(saved) ? (saved as Refresh) : d.refresh;
  }

  /** Меняет интервал опроса дашборда; он же задает, как часто проверяются его алерты. */
  setRefresh(id: string, refresh: string): { refresh: Refresh } {
    const d = this.dashboard(id);
    if (!(REFRESH_OPTIONS as readonly string[]).includes(refresh)) throw new MonitorError(`Интервал ${refresh} не из списка ${REFRESH_OPTIONS.join(', ')}`);
    this.d.store.setMonitorRefresh(d.id, refresh);
    return { refresh: refresh as Refresh };
  }

  private taskDto(key: string, ref?: IssueRef): MonitorTaskDto {
    return { key, summary: ref?.summary ?? null, status: ref?.status ?? null, url: ref?.url ?? `${this.d.jiraBaseUrl.replace(/\/$/, '')}/browse/${key}` };
  }

  /**
   * Задачи в статусе мониторинга, задачи дашбордов и эпики из Jira; кэш на пять минут. Недоступная Jira не ломает
   * панель: задачи показываются по ключам, а причина уходит в ответ.
   */
  private async jiraInfo(dashboards: Dashboard[]): Promise<{ tasks: IssueRef[]; byKey: Map<string, IssueRef>; error: string | null }> {
    const keys = new Set(dashboards.flatMap((d) => [d.task, ...(d.epic ? [d.epic] : [])]));
    const cached = this.jiraCache;
    if (cached && this.now() - cached.at < TASKS_TTL && [...keys].every((k) => cached.byKey.has(k) || cached.error)) return cached;
    const byKey = new Map<string, IssueRef>();
    let tasks: IssueRef[] = [];
    let error: string | null = null;
    try {
      const jql = this.d.profile?.tasksJql;
      tasks = jql ? await this.d.jira.search(jql, 50) : [];
      for (const t of tasks) byKey.set(t.key, t);
      const epics = new Set([...keys, ...tasks.map((t) => t.epic).filter((e): e is string => !!e)]);
      const missing = [...epics].filter((k) => !byKey.has(k));
      if (missing.length) for (const t of await this.d.jira.search(`key in (${missing.join(',')})`, missing.length)) byKey.set(t.key, t);
      // Эпик задачи дашборда без поля epic берется из Jira: для него нужна еще одна порция названий.
      const second = [...byKey.values()].map((t) => t.epic).filter((e): e is string => !!e && !byKey.has(e));
      if (second.length) for (const t of await this.d.jira.search(`key in (${[...new Set(second)].join(',')})`, second.length)) byKey.set(t.key, t);
    } catch (e) {
      error = `Jira не ответила: ${e instanceof Error ? e.message : String(e)}`;
      if (cached) return { ...cached, error };
    }
    this.jiraCache = { at: this.now(), tasks, byKey, error };
    return this.jiraCache;
  }

  private alertsOf(d: Dashboard, rows = this.d.store.monitorAlerts(d.id)): MonitorAlertDto[] {
    const paused = this.refreshOf(d) === 'off';
    return d.alerts.map((a) => {
      const row = rows.find((r) => r.alertId === a.id);
      const panel = d.panels.find((p) => p.id === a.panel);
      const kind = panel?.type === 'share' ? 'ratio' : 'count';
      if (paused) return { id: a.id, panel: a.panel, text: row?.text ?? a.title ?? a.id, state: 'paused', kind, value: row?.value ?? null, threshold: row?.threshold ?? null, since: null, checkedAt: row?.checkedAt ?? null };
      if (!row) return { id: a.id, panel: a.panel, text: a.title ?? a.id, state: 'pending', kind, value: null, threshold: null, since: null, checkedAt: null };
      return { id: a.id, panel: a.panel, text: row.text, state: row.state, kind, value: row.value, threshold: row.threshold, since: row.since, checkedAt: row.checkedAt };
    });
  }

  /** Обзор: карточки задач с цифрами дашбордов, сгруппированные по эпикам, и задачи в статусе мониторинга без дашборда. */
  async overview(): Promise<MonitorOverviewDto> {
    const now = this.now();
    const { dashboards, errors } = this.d.port.dashboards();
    const services = this.d.port.services();
    const jira = await this.jiraInfo(dashboards);
    const plans = dashboards.flatMap((d) => headlinePanels(d).map((p) => ({ d, ...planHeadline(d, p, services, now) })));
    const results = plans.length ? await this.d.port.run(plans.flatMap((p) => p.requests)) : [];
    const headlines = new Map<string, Headline[]>();
    for (const { plan, results: r } of split(plans, results)) headlines.set(plan.d.id, [...(headlines.get(plan.d.id) ?? []), plan.value(r)]);
    const rows = this.d.store.monitorAlerts();
    const covered = new Set(dashboards.flatMap((d) => [d.task, ...d.related]));
    const cards: { epic: string | null; card: MonitorCardDto }[] = dashboards.map((d) => {
      const alerts = this.alertsOf(
        d,
        rows.filter((r) => r.dashboardId === d.id),
      );
      const h = headlines.get(d.id) ?? [];
      const status: MonitorCardDto['status'] = alerts.some((a) => a.state === 'firing') ? 'alert' : h.some((x) => x.error) ? 'error' : 'ok';
      const services = [...new Set(d.panels.map((p) => p.service ?? d.service))];
      return {
        epic: d.epic ?? jira.byKey.get(d.task)?.epic ?? null,
        card: { task: this.taskDto(d.task, jira.byKey.get(d.task)), dashboard: { id: d.id, title: d.title, refresh: this.refreshOf(d), services }, headlines: h, alerts, status },
      };
    });
    for (const t of jira.tasks) {
      if (!covered.has(t.key)) cards.push({ epic: t.epic ?? null, card: { task: this.taskDto(t.key, t), dashboard: null, headlines: [], alerts: [], status: 'empty' } });
    }
    const groups = new Map<string, { epic: MonitorTaskDto | null; cards: MonitorCardDto[] }>();
    for (const { epic, card } of cards) {
      const key = epic ?? '';
      const group = groups.get(key) ?? { epic: epic ? this.taskDto(epic, jira.byKey.get(epic)) : null, cards: [] };
      group.cards.push(card);
      groups.set(key, group);
    }
    const rank = (g: { cards: MonitorCardDto[] }) => (g.cards.some((c) => c.status === 'alert') ? 0 : g.cards.some((c) => c.dashboard) ? 1 : 2);
    const ordered = [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.epic ? 0 : 1) - (b.epic ? 0 : 1) || (a.epic?.key ?? '').localeCompare(b.epic?.key ?? ''));
    return { configured: !!this.d.profile, groups: ordered, errors, tasksError: jira.error, load: this.d.port.stats(), at: new Date(now).toISOString() };
  }

  /** Запрос версий сервиса за окно для отметок деплоев: границы по часу, чтобы он брался из кэша. */
  private versions(service: MonitorServiceProfile, range: TimeRange): LogRequest {
    return { kind: 'versions', service, filter: filterOf({}), from: Math.floor(range.from / HOUR) * HOUR, to: Math.ceil(range.to / HOUR) * HOUR, cacheMs: 10 * MINUTE };
  }

  /** Данные дашборда за период: значения панелей, отметки деплоев, алерты и нагрузка на кластер. */
  async data(id: string, period: string): Promise<DashboardDataDto> {
    return this.dataOf(this.dashboard(id), period);
  }

  /** Данные дашборда, которого еще нет в файлах: превью правки по запросу считается так же, как сам дашборд. */
  preview(d: Dashboard, period: string): Promise<DashboardDataDto> {
    return this.dataOf(d, period);
  }

  private async dataOf(d: Dashboard, period: string): Promise<DashboardDataDto> {
    if (!(period in PERIODS)) throw new MonitorError(`Период ${period} не из списка ${Object.keys(PERIODS).join(', ')}`);
    const now = this.now();
    const services = this.d.port.services();
    const periodMs = PERIODS[period as Period];
    const bucketMs = bucketOf(periodMs);
    const range = rangeOf(now, periodMs, bucketMs);
    const panels = d.panels.map((p) => ({ p, ...planPanel(d, p, services, range, bucketMs) }));
    const used = [...new Set(d.panels.map((p) => p.service ?? d.service))].map((s) => serviceOf(services, s));
    const deploys = used.map((s) => ({ s, requests: [this.versions(s, range)] }));
    const results = await this.d.port.run([...panels.flatMap((p) => p.requests), ...deploys.flatMap((x) => x.requests)]);
    const parts = split([...panels, ...deploys], results);
    const kibana = this.d.profile?.source.kibana;
    const jira = await this.jiraInfo([d]);
    const epic = d.epic ?? jira.byKey.get(d.task)?.epic ?? null;
    return {
      dashboard: d,
      task: this.taskDto(d.task, jira.byKey.get(d.task)),
      epic: epic ? this.taskDto(epic, jira.byKey.get(epic)) : null,
      period: period as Period,
      range,
      bucketMs,
      refresh: this.refreshOf(d),
      panels: parts.slice(0, panels.length).map(({ plan, results: r }) => {
        const p = (plan as (typeof panels)[number]).p;
        return { id: p.id, value: (plan as (typeof panels)[number]).value(r), discover: discoverUrl(kibana, panelService(d, p, services), metricFilters(p).part, range) };
      }),
      deploys: parts.slice(panels.length).flatMap(({ plan, results: r }) => {
        const v = r[0];
        return v?.kind === 'versions' ? deploysOf((plan as (typeof deploys)[number]).s.id, v.versions, range) : [];
      }),
      alerts: this.alertsOf(d),
      load: this.d.port.stats(),
      at: new Date(now).toISOString(),
    };
  }

  /** Разбивка панели по полю за период и число строк до и после последнего деплоя в нем. */
  async breakdown(id: string, panelId: string, period: string, by: string): Promise<PanelBreakdownDto> {
    const d = this.dashboard(id);
    const p = this.panel(d, panelId);
    if (!(period in PERIODS)) throw new MonitorError(`Период ${period} не из списка ${Object.keys(PERIODS).join(', ')}`);
    const breakdown = parseBreakdown(by);
    const services = this.d.port.services();
    const service = panelService(d, p, services);
    const range = rangeOf(this.now(), PERIODS[period as Period]);
    const filter = metricFilters(p).part;
    const [terms, versions] = await this.d.port.run([{ kind: 'terms', service, filter, ...range, by: breakdown, size: 10, cacheMs: MINUTE }, this.versions(service, range)]);
    const deploy = versions?.kind === 'versions' ? deploysOf(service.id, versions.versions, range).at(-1) : undefined;
    let around: PanelBreakdownDto['deploy'] = null;
    if (deploy) {
      // Сравниваются равные отрезки до и после деплоя: столько, сколько прошло после него, но не больше половины периода.
      const spanMs = Math.max(MINUTE, Math.min(range.to - deploy.at, deploy.at - range.from, (range.to - range.from) / 2));
      const [before, after] = await this.d.port.run([
        { kind: 'count', service, filter, from: deploy.at - spanMs, to: deploy.at },
        { kind: 'count', service, filter, from: deploy.at, to: deploy.at + spanMs },
      ]);
      if (before?.kind === 'count' && after?.kind === 'count') around = { ...deploy, before: before.count, after: after.count, spanMs };
    }
    if (terms?.kind !== 'terms') return { panel: p.id, by, items: [], other: 0, deploy: around, error: terms?.kind === 'error' ? terms.message : 'нет ответа' };
    return { panel: p.id, by, items: terms.terms, other: terms.other, deploy: around, error: null };
  }

  /** Строки лога панели (или всего сервиса дашборда) за окно, новые сверху, порциями. */
  async lines(id: string, panelId: string | null, from: number, to: number, before: number | null): Promise<MonitorLinesDto> {
    const d = this.dashboard(id);
    const p = panelId ? this.panel(d, panelId) : null;
    if (!(from < to)) throw new MonitorError('Начало окна должно быть раньше конца');
    if (to - from > PERIODS['7d']) throw new MonitorError('Строки ищутся в окне не больше недели');
    const services = this.d.port.services();
    const service = p ? panelService(d, p, services) : serviceOf(services, d.service);
    const filter = p ? metricFilters(p).part : filterOf({});
    const end = before !== null ? Math.min(to, before) : to;
    const [r] = await this.d.port.run([{ kind: 'lines', service, filter, from, to: end, size: LINES_PAGE, cacheMs: 15_000 }]);
    const discover = discoverUrl(this.d.profile?.source.kibana, service, filter, { from, to });
    if (r?.kind !== 'lines') return { lines: [], before: null, discover, error: r?.kind === 'error' ? r.message : 'нет ответа' };
    return { lines: r.lines, before: r.lines.length === LINES_PAGE ? (r.lines.at(-1)?.t ?? null) : null, discover, error: null };
  }

  /** Запускает фоновую проверку алертов. */
  start(): void {
    if (!this.d.profile || this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Проверяет алерты дашбордов, которым пора: интервал опроса дашборда, но не чаще раза в 30 секунд; выключенный опрос
   * выключает и алерты. Срабатывание и снятие алерта пишутся событием monitor.alert в общий поток.
   */
  async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = this.now();
      const { dashboards } = this.d.port.dashboards();
      this.d.store.pruneMonitorAlerts(dashboards.flatMap((d) => d.alerts.map((a) => ({ dashboardId: d.id, alertId: a.id }))));
      const services = this.d.port.services();
      const due = dashboards.filter((d) => {
        const refresh = this.refreshOf(d);
        if (!d.alerts.length || refresh === 'off') return false;
        return now - (this.lastCheck.get(d.id) ?? 0) >= Math.max(durationMs(refresh), ALERT_MIN_INTERVAL);
      });
      if (!due.length) return;
      const plans = due.flatMap((d) => d.alerts.map((a) => ({ d, a, ...planAlert(d, a, services, now) })));
      const results = await this.d.port.run(plans.flatMap((p) => p.requests));
      const previous = new Map(this.d.store.monitorAlerts().map((r) => [`${r.dashboardId}/${r.alertId}`, r]));
      for (const { plan, results: r } of split(plans, results)) {
        const outcome = plan.outcome(r);
        const before: MonitorAlertRow | undefined = previous.get(`${plan.d.id}/${plan.a.id}`);
        this.d.store.saveMonitorAlert({ dashboardId: plan.d.id, alertId: plan.a.id, state: outcome.state, value: outcome.value, threshold: outcome.threshold, text: outcome.text });
        const kind = plan.d.panels.find((p) => p.id === plan.a.panel)?.type === 'share' ? 'ratio' : 'count';
        const data = { dashboard: plan.d.id, alert: plan.a.id, state: outcome.state, value: outcome.value, threshold: outcome.threshold, kind };
        if (outcome.state === 'firing' && before?.state !== 'firing') {
          this.d.bus.emitEvent({ type: 'monitor.alert', message: `Алерт: ${plan.d.title}: ${outcome.text}`, data });
        } else if (outcome.state === 'ok' && before?.state === 'firing') {
          this.d.bus.emitEvent({ type: 'monitor.alert', message: `Алерт снят: ${plan.d.title}: ${outcome.text}`, data });
        }
      }
      for (const d of due) this.lastCheck.set(d.id, now);
    } catch (e) {
      console.error('Мониторинг: проверка алертов не прошла', e);
    } finally {
      this.checking = false;
    }
  }
}

/** Разбивка из параметра запроса: поле профиля или extract:<префикс>. */
export function parseBreakdown(by: string): Breakdown {
  if (by === 'level' || by === 'logger' || by === 'version' || by === 'pod') return by;
  if (by.startsWith('extract:') && by.length > 'extract:'.length && by.length <= 300) return { extract: by.slice('extract:'.length) };
  throw new MonitorError(`Разбивка ${by} не из списка: level, logger, version, pod или extract:<префикс>`);
}
