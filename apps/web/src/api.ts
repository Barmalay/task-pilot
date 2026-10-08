import type { ParamValue, Period, Preset, Refresh } from '@task-pilot/step-kit';
import type {
  AccountDto,
  ArtifactsDto,
  AskDto,
  AttemptPathDto,
  AttemptProfileDto,
  AttemptSearchDto,
  AttentionDto,
  BudgetDto,
  CacheDto,
  ForecastDto,
  CatalogDto,
  DashboardDataDto,
  DoctorDto,
  EventDetailsDto,
  EventDto,
  FeaturesDto,
  FeatureStatsDto,
  FeedPageDto,
  MonitorEditDto,
  MonitorEditsDto,
  IntegrationDto,
  IntegrationsDto,
  MonitorLinesDto,
  MonitorOverviewDto,
  PanelBreakdownDto,
  ProfileDto,
  ProfilesDto,
  RunDto,
  RunHistoryDto,
  RunJournal,
  RunTimingDto,
  RunViewDto,
  ServiceDto,
  SprintDto,
  StandDto,
  TasksDto,
  TransitionDto,
} from '@task-pilot/api-types';

/** Превью черновика правки: данные дашборда, цифры фичи или ничего. */
export type EditPreviewDto = { kind: 'dashboard'; data: DashboardDataDto } | { kind: 'feature'; stats: FeatureStatsDto } | { kind: 'none' };

/** Запрос поиска попыток входа: значения идентификаторов, телефон, признак, провайдер, итог и окно. */
export interface AttemptSearchQuery {
  ids: string[];
  phone?: string;
  sign?: string;
  provider?: string;
  outcome?: 'success' | 'failure' | 'unknown';
  from?: number;
  to?: number;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    // Без тела нет и типа тела: на пустое JSON-тело сервер отвечает ошибкой.
    headers: body === undefined ? { 'x-task-pilot': '1' } : { 'content-type': 'application/json', 'x-task-pilot': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = json as { error_description?: string; error?: string } | null;
    throw new Error(err?.error_description ?? err?.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

/** Какие задачи показывать: мои незакрытые или задачи спринта. */
export type TasksFilter = { scope: 'mine' } | { scope: 'sprint'; sprint: number; mine: boolean; hideDone: boolean };

function tasksUrl(f: TasksFilter): string {
  if (f.scope === 'mine') return '/api/tasks';
  const q = new URLSearchParams({ scope: 'sprint', sprint: String(f.sprint), mine: f.mine ? '1' : '0', hideDone: f.hideDone ? '1' : '0' });
  return `/api/tasks?${q}`;
}

/** Клиент API сервера Task Pilot. */
export const api = {
  tasks: (f: TasksFilter) => request<TasksDto>('GET', tasksUrl(f)),
  sprints: () => request<SprintDto[]>('GET', '/api/sprints'),
  catalog: () => request<CatalogDto>('GET', '/api/catalog'),
  createPreset: (preset: Preset) => request<Preset>('POST', '/api/presets', preset),
  updatePreset: ({ id, ...fields }: Preset) => request<Preset>('PUT', `/api/presets/${encodeURIComponent(id)}`, fields),
  deletePreset: (id: string) => request<{ ok: true }>('DELETE', `/api/presets/${encodeURIComponent(id)}`),
  /** Мастер "Новый шаг": прогон PILOT-<n> по описанию шага, сразу запущенный. */
  draftStep: (description: string) => request<{ id: string }>('POST', '/api/pilot/steps', { description }),
  profiles: () => request<ProfilesDto>('GET', '/api/profiles'),
  /** Что сейчас на стендах контура репозитория; без repoId - репозитория по умолчанию. */
  stands: (repoId?: string) => request<StandDto[]>('GET', repoId ? `/api/stands?repo=${encodeURIComponent(repoId)}` : '/api/stands'),
  /** Активные аккаунты Jira и Claude для шапки. */
  account: () => request<AccountDto>('GET', '/api/account'),
  /** Профиль для панели сбоку: команда и личные настройки этой машины. */
  me: () => request<ProfileDto>('GET', '/api/me'),
  /** Что ждет владельца во всех прогонах: подтверждения шагов и вопросы агентов. */
  attention: () => request<AttentionDto[]>('GET', '/api/attention'),
  /** История уведомлений, от новых к старым. */
  notifications: (limit = 50) => request<EventDto[]>('GET', `/api/notifications?limit=${limit}`),
  /** Последние прогоны всех задач, новые первыми. */
  recentRuns: () => request<RunDto[]>('GET', '/api/runs'),
  /** Расход агентов и лимиты на день и неделю. */
  budget: () => request<BudgetDto>('GET', '/api/budget'),
  /** Новые лимиты расхода агентов; null - без лимита. */
  setBudget: (limits: { dayUsd: number | null; weekUsd: number | null }) => request<BudgetDto>('PUT', '/api/budget', limits),
  /** Проверка окружения машины, как pnpm checkup. */
  doctor: () => request<DoctorDto>('GET', '/api/doctor'),
  service: () => request<ServiceDto>('GET', '/api/service'),
  restartServer: () => request<{ ok: true }>('POST', '/api/service/restart'),
  serviceDoc: (path: string) => request<{ path: string; text: string }>('GET', `/api/service/doc?path=${encodeURIComponent(path)}`),
  acceptDoc: (path: string, accepted: boolean) => request<ServiceDto>('POST', '/api/service/doc/accept', { path, accepted }),
  /** Место на диске: файлы прогонов и кэш QA-браузера. */
  cache: () => request<CacheDto>('GET', '/api/cache'),
  /** Удалить файлы завершенного прогона: журналы его агентов и логи сборок. */
  clearRunCache: (runId: string) => request<CacheDto>('POST', `/api/cache/runs/${runId}/clear`, {}),
  /** Удалить файлы всех завершенных прогонов. */
  clearCompletedCache: () => request<CacheDto>('POST', '/api/cache/runs/clear', {}),
  /** Удалить кэш страниц QA-браузера; входы на стенды остаются. */
  clearQaCache: () => request<CacheDto>('POST', '/api/cache/qa/clear', {}),
  /** Интеграции: откуда берется доступ и под какими аккаунтами работает Task Pilot. */
  integrations: () => request<IntegrationsDto>('GET', '/api/integrations'),
  /** Проверить все аккаунты интеграции заново. */
  checkIntegration: (id: string) => request<IntegrationDto>('POST', `/api/integrations/${encodeURIComponent(id)}/check`, {}),
  /** Завести токен: он проверяется системой, сохраняется в Keychain и становится активным. */
  addToken: (id: string, token: string, label?: string) => request<IntegrationDto>('POST', `/api/integrations/${encodeURIComponent(id)}/accounts`, { token, ...(label ? { label } : {}) }),
  /** Сделать аккаунт активным; null - доступ как обычно. */
  activateAccount: (id: string, active: string | null) => request<IntegrationDto>('PATCH', `/api/integrations/${encodeURIComponent(id)}`, { active }),
  removeAccount: (id: string, account: string) => request<IntegrationDto>('DELETE', `/api/integrations/${encodeURIComponent(id)}/accounts/${encodeURIComponent(account)}`),
  /** Вход в Claude через браузер в отдельной папке аккаунта. */
  claudeLogin: (body: { label?: string; email?: string }) => request<IntegrationDto>('POST', '/api/integrations/claude/logins', body),
  claudeLoginCode: (login: string, code: string) => request<{ ok: true }>('POST', `/api/integrations/claude/logins/${encodeURIComponent(login)}/code`, { code }),
  cancelClaudeLogin: (login: string) => request<{ ok: true }>('DELETE', `/api/integrations/claude/logins/${encodeURIComponent(login)}`),
  /** Открывает задачу: последний прогон или новый, ничего не запуская. */
  openTask: (issueKey: string) => request<{ id: string; created: boolean }>('POST', `/api/tasks/${encodeURIComponent(issueKey)}/open`, {}),
  /** Новый прогон по задаче, даже если старый есть. */
  newRun: (issueKey: string, options: { presetId?: string; repoId?: string; standId?: string | null } = {}) => request<{ id: string }>('POST', '/api/runs', { issueKey, ...options }),
  run: (id: string) => request<RunViewDto>('GET', `/api/runs/${id}`),
  /** Все прогоны задачи, новые первыми. */
  runsOf: (issueKey: string) => request<RunDto[]>('GET', `/api/runs?issue=${encodeURIComponent(issueKey)}`),
  /** Переходы, доступные задаче сейчас, с колонками, куда они ведут. */
  transitions: (issueKey: string) => request<TransitionDto[]>('GET', `/api/tasks/${encodeURIComponent(issueKey)}/transitions`),
  /** Перевести задачу по доске: владелец перетащил карточку. */
  transition: (issueKey: string, transitionId: string) => request<{ to: string | null }>('POST', `/api/tasks/${encodeURIComponent(issueKey)}/transition`, { transitionId }),
  refreshIssue: (id: string) => request<RunViewDto>('POST', `/api/runs/${id}/issue`, {}),
  dismissIssueChanges: (id: string) => request<RunViewDto>('POST', `/api/runs/${id}/issue-changes/dismiss`, {}),
  setOptions: (id: string, body: RunOptions) => request<RunViewDto>('PATCH', `/api/runs/${id}`, body),
  deleteRun: (id: string) => request<{ next: string | null }>('DELETE', `/api/runs/${id}`),
  artifacts: (id: string) => request<ArtifactsDto>('GET', `/api/runs/${id}/artifacts`),
  artifactUrl: (id: string, name: string) => `/api/runs/${id}/artifacts/${encodeURIComponent(name)}`,
  timing: (id: string) => request<RunTimingDto>('GET', `/api/runs/${id}/timing`),
  history: (limit = 200) => request<RunHistoryDto[]>('GET', `/api/timing?limit=${limit}`),
  /** Прогноз прогона по истории: ожидаемое время шагов плана, процент сделанного и прогноз при запуске. */
  forecast: (id: string) => request<ForecastDto>('GET', `/api/runs/${id}/forecast`),
  journal: (id: string) => request<RunJournal>('GET', `/api/runs/${id}/journal`),
  /** Страница ленты: события старше before, без него - самые новые. */
  feed: (id: string, before?: number) => request<FeedPageDto>('GET', `/api/runs/${id}/feed${before ? `?before=${before}` : ''}`),
  eventDetails: (id: string, eventId: number) => request<EventDetailsDto>('GET', `/api/runs/${id}/events/${eventId}`),
  select: (id: string, stepId: string, selected: boolean) => request<RunViewDto>('PATCH', `/api/runs/${id}/steps/${stepId}`, { selected }),
  /** Настройки шага в прогоне: значение поверх умолчаний, null возвращает умолчание пресета или манифеста. */
  setParams: (id: string, stepId: string, params: Record<string, ParamValue | null>) => request<RunViewDto>('PATCH', `/api/runs/${id}/steps/${stepId}/params`, { params }),
  start: (id: string) => request<{ ok: true }>('POST', `/api/runs/${id}/start`, {}),
  retry: (id: string, stepId: string, note?: string) => request<{ ok: true }>('POST', `/api/runs/${id}/steps/${stepId}/retry`, note ? { note } : {}),
  skip: (id: string, stepId: string) => request<{ ok: true }>('POST', `/api/runs/${id}/steps/${stepId}/skip`, {}),
  /** Остановить выполнение прогона: агент и сборка текущего шага завершаются. */
  stop: (id: string) => request<{ ok: true }>('POST', `/api/runs/${id}/stop`, {}),
  decide: (approvalId: string, decision: 'approve' | 'reject' | 'rework', comment?: string) =>
    request<{ ok: true }>('POST', `/api/approvals/${approvalId}`, { decision, comment }),
  /** Ответ владельца на вопрос агента. */
  answer: (questionId: string, answer: string) => request<unknown>('POST', `/api/questions/${questionId}/answer`, { answer }),
  /** Вопросы владельца о прогоне с ответами агента, старые первыми. */
  asks: (id: string) => request<AskDto[]>('GET', `/api/runs/${id}/asks`),
  /** Спросить о прогоне: агент только читает ленту, шаги и код, ответ придет событием ask.answered. */
  ask: (id: string, question: string) => request<AskDto>('POST', `/api/runs/${id}/asks`, { question }),
  /** Обзор панели мониторинга: задачи по эпикам. */
  monitorOverview: () => request<MonitorOverviewDto>('GET', '/api/monitor/overview'),
  /** Данные дашборда за период. */
  dashboard: (id: string, period: Period) => request<DashboardDataDto>('GET', `/api/monitor/dashboards/${encodeURIComponent(id)}?period=${period}`),
  /** Интервал опроса дашборда; он же задает, как часто проверяются его алерты. */
  setRefresh: (id: string, refresh: Refresh) => request<{ refresh: Refresh }>('PATCH', `/api/monitor/dashboards/${encodeURIComponent(id)}`, { refresh }),
  breakdown: (id: string, panel: string, period: Period, by: string) =>
    request<PanelBreakdownDto>('GET', `/api/monitor/dashboards/${encodeURIComponent(id)}/panels/${encodeURIComponent(panel)}/breakdown?${new URLSearchParams({ period, by })}`),
  /** Строки лога панели за окно; before - время самой старой уже показанной строки. */
  monitorLines: (id: string, q: { panel?: string; from: number; to: number; before?: number | null }) =>
    request<MonitorLinesDto>(
      'GET',
      `/api/monitor/dashboards/${encodeURIComponent(id)}/lines?${new URLSearchParams({ ...(q.panel ? { panel: q.panel } : {}), from: String(q.from), to: String(q.to), ...(q.before ? { before: String(q.before) } : {}) })}`,
    ),
  /** Одна попытка входа по state, correlationId или flowState. */
  monitorFeatures: () => request<FeaturesDto>('GET', '/api/monitor/features'),
  monitorFeature: (id: string, from: string, to: string) => request<FeatureStatsDto>('GET', `/api/monitor/features/${encodeURIComponent(id)}?${new URLSearchParams({ from, to })}`),
  monitorEdits: (target: string) => request<MonitorEditsDto>('GET', `/api/monitor/edits?${new URLSearchParams({ target })}`),
  monitorEditRequest: (target: string, message: string) => request<MonitorEditDto>('POST', '/api/monitor/edits', { target, message }),
  monitorEditApply: (id: string) => request<MonitorEditsDto>('POST', `/api/monitor/edits/${encodeURIComponent(id)}/apply`),
  monitorEditDiscard: (id: string) => request<MonitorEditsDto>('POST', `/api/monitor/edits/${encodeURIComponent(id)}/discard`),
  monitorEditPreview: (id: string, q: { period?: string; from?: string; to?: string }) =>
    request<EditPreviewDto>('GET', `/api/monitor/edits/${encodeURIComponent(id)}/preview?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => Boolean(e[1])))}`),
  monitorVersionRevert: (id: string) => request<MonitorEditsDto>('POST', `/api/monitor/versions/${encodeURIComponent(id)}/revert`),
  attemptProfile: () => request<AttemptProfileDto>('GET', '/api/monitor/attempts/profile'),
  // Поиск и путь идут телом POST: телефон не попадает ни в адрес, ни в историю браузера.
  attemptSearch: (q: AttemptSearchQuery) => request<AttemptSearchDto>('POST', '/api/monitor/attempts/search', q),
  attemptPath: (ids: string[], at?: number | null) => request<AttemptPathDto>('POST', '/api/monitor/attempts/path', { ids, ...(at ? { at } : {}) }),
};

/** Параметры прогона, которые владелец меняет в шапке. */
export type RunOptions = { presetId?: string; repoId?: string; standId?: string | null; dryRun?: boolean };
