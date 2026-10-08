import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { ParamValues, Preview, RunStatus, StepStatus } from '@task-pilot/step-kit';

/** Строка ответа node:sqlite. */
export type Row = Record<string, SQLOutputValue>;

/** Прогон цикла по одной задаче. */
export interface RunRow {
  id: string;
  issueKey: string;
  repoId: string;
  standId: string | null;
  presetId: string;
  dryRun: boolean;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

/** Шаг внутри прогона. */
export interface RunStepRow {
  runId: string;
  stepId: string;
  position: number;
  selected: boolean;
  status: StepStatus;
  note: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Замечание владельца, по которому шаг переделывает черновик при следующем выполнении. */
  feedback: string | null;
  /**
   * Замечание владельца к повтору упавшего шага вместе с ошибкой прошлой попытки: движок отдает его агенту шага в
   * следующей попытке и сразу убирает.
   */
  retryNote: string | null;
  /** Настройки шага, выбранные в этом прогоне поверх умолчаний пресета и манифеста; пусто - не меняли. */
  params: ParamValues;
}

/** Событие журнала прогона. */
export interface EventRow {
  id: number;
  runId: string | null;
  stepId: string | null;
  ts: string;
  type: string;
  message: string | null;
  data: unknown;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'rework' | 'consumed' | 'stale';

/** Запрос подтверждения владельца, привязанный к хэшу содержимого. */
export interface ApprovalRow {
  id: string;
  runId: string;
  stepId: string;
  payloadHash: string;
  preview: Preview;
  status: ApprovalStatus;
  comment: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type QuestionStatus = 'open' | 'answered' | 'expired';

/** Вопрос агента владельцу. */
export interface QuestionRow {
  id: string;
  runId: string;
  stepId: string;
  sessionId: string | null;
  question: string;
  options: string[];
  status: QuestionStatus;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export type AgentSessionStatus = 'running' | 'succeeded' | 'failed' | 'aborted' | 'interrupted';

export type AskStatus = 'pending' | 'answered' | 'failed';

/** Вопрос владельца о прогоне и ответ агента, который только читает. */
export interface AskRow {
  id: string;
  runId: string;
  question: string;
  status: AskStatus;
  answer: string | null;
  error: string | null;
  /** Стоимость ответа; null - агент еще отвечает или до запуска не дошло. */
  costUsd: number | null;
  createdAt: string;
  answeredAt: string | null;
}

/** Правка мониторинга по запросу: идет, готова, не прошла проверку, упала, применена или отклонена. */
export type MonitorEditStatus = 'working' | 'ready' | 'invalid' | 'failed' | 'applied' | 'discarded';

/** Сообщение разговора о правке: просьба владельца (телефоны в ней маской) или ответ агента. */
export interface MonitorEditMessage {
  role: 'owner' | 'agent';
  text: string;
  at: string;
}

/** Правка файла мониторинга по запросу в чате: разговор, текст файла до правки и предложенный агентом. */
export interface MonitorEditRow {
  id: string;
  /** Что правится: dashboard:<id>, feature:<id> или attempt. */
  target: string;
  status: MonitorEditStatus;
  messages: MonitorEditMessage[];
  /** Текст файла, от которого агент начал: если файл с тех пор изменился, правка не применяется. */
  base: string;
  draft: string | null;
  /** Что агент изменил, его словами. */
  summary: string | null;
  /** Почему черновик не прошел проверку схемой. */
  errors: string[];
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

/** Прошлая версия файла мониторинга: текст до примененной правки или возврата. */
export interface MonitorVersionRow {
  id: string;
  target: string;
  source: string;
  note: string | null;
  createdAt: string;
}

/** Один запуск агента: новая сессия или продолжение прежней. */
export interface AgentSessionRow {
  id: string;
  sessionId: string;
  runId: string;
  stepId: string;
  label: string;
  model: string | null;
  status: AgentSessionStatus;
  costUsd: number;
  durationMs: number;
  turns: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Последняя проверка алерта панели мониторинга. */
export interface MonitorAlertRow {
  dashboardId: string;
  alertId: string;
  state: 'firing' | 'ok' | 'nodata';
  value: number | null;
  threshold: number | null;
  text: string;
  /** С какого момента алерт в этом состоянии. */
  since: string;
  checkedAt: string;
}

/** Как задан аккаунт интеграции в Task Pilot: токен в Keychain или вход Claude в своей папке. */
export type IntegrationAccountKind = 'token' | 'login' | 'oauth-token' | 'api-key';

/** Аккаунт интеграции, заведенный на экране "Интеграции". Сам токен лежит в Keychain, здесь только подписи. */
export interface IntegrationAccountRow {
  id: string;
  integration: string;
  kind: IntegrationAccountKind;
  /** Подпись владельца; null - показывается владелец доступа. */
  label: string | null;
  /** Логин владельца доступа по ответу самой системы. */
  login: string | null;
  name: string | null;
  /** Последние символы токена: по ним владелец узнает, какой токен заведен. */
  hint: string | null;
  /** Папка входа Claude через браузер (CLAUDE_CONFIG_DIR). */
  dir: string | null;
  createdAt: string;
  checkedAt: string | null;
  error: string | null;
}

/** Сводка агентных запусков шага для интерфейса. */
export interface AgentStats {
  runs: number;
  costUsd: number;
  durationMs: number;
  running: boolean;
}

export const now = () => new Date().toISOString();
export const str = (v: SQLOutputValue): string => String(v);
export const strOrNull = (v: SQLOutputValue): string | null => (v === null ? null : String(v));
export const json = (v: SQLOutputValue): unknown => (v === null ? null : JSON.parse(String(v)));

export function toRun(r: Row): RunRow {
  return {
    id: str(r.id),
    issueKey: str(r.issue_key),
    repoId: str(r.repo_id),
    standId: strOrNull(r.stand_id),
    presetId: str(r.preset_id),
    dryRun: Number(r.dry_run) === 1,
    status: str(r.status) as RunStatus,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function toStep(r: Row): RunStepRow {
  return {
    runId: str(r.run_id),
    stepId: str(r.step_id),
    position: Number(r.position),
    selected: Number(r.selected) === 1,
    status: str(r.status) as StepStatus,
    note: strOrNull(r.note),
    error: strOrNull(r.error),
    startedAt: strOrNull(r.started_at),
    finishedAt: strOrNull(r.finished_at),
    feedback: strOrNull(r.feedback),
    retryNote: strOrNull(r.retry_note),
    params: (json(r.params ?? null) as ParamValues | null) ?? {},
  };
}

export function toQuestion(r: Row): QuestionRow {
  return {
    id: str(r.id),
    runId: str(r.run_id),
    stepId: str(r.step_id),
    sessionId: strOrNull(r.session_id),
    question: str(r.question),
    options: (json(r.options) as string[] | null) ?? [],
    status: str(r.status) as QuestionStatus,
    answer: strOrNull(r.answer),
    createdAt: str(r.created_at),
    answeredAt: strOrNull(r.answered_at),
  };
}

export function toAgentSession(r: Row): AgentSessionRow {
  return {
    id: str(r.id),
    sessionId: str(r.session_id),
    runId: str(r.run_id),
    stepId: str(r.step_id),
    label: str(r.label),
    model: strOrNull(r.model),
    status: str(r.status) as AgentSessionStatus,
    costUsd: Number(r.cost_usd),
    durationMs: Number(r.duration_ms),
    turns: Number(r.turns),
    error: strOrNull(r.error),
    startedAt: str(r.started_at),
    finishedAt: strOrNull(r.finished_at),
  };
}

export function toMonitorEdit(r: Row): MonitorEditRow {
  return {
    id: str(r.id),
    target: str(r.target),
    status: str(r.status) as MonitorEditStatus,
    messages: JSON.parse(str(r.messages)) as MonitorEditMessage[],
    base: str(r.base),
    draft: strOrNull(r.draft),
    summary: strOrNull(r.summary),
    errors: r.errors === null ? [] : (JSON.parse(str(r.errors)) as string[]),
    costUsd: Number(r.cost_usd ?? 0),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function toMonitorVersion(r: Row): MonitorVersionRow {
  return { id: str(r.id), target: str(r.target), source: str(r.source), note: strOrNull(r.note), createdAt: str(r.created_at) };
}

export function toAsk(r: Row): AskRow {
  return {
    id: str(r.id),
    runId: str(r.run_id),
    question: str(r.question),
    status: str(r.status) as AskStatus,
    answer: strOrNull(r.answer),
    error: strOrNull(r.error),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    createdAt: str(r.created_at),
    answeredAt: strOrNull(r.answered_at),
  };
}

export function toEvent(r: Row): EventRow {
  return {
    id: Number(r.id),
    runId: strOrNull(r.run_id),
    stepId: strOrNull(r.step_id),
    ts: str(r.ts),
    type: str(r.type),
    message: strOrNull(r.message),
    data: json(r.data),
  };
}

export function toApproval(r: Row): ApprovalRow {
  return {
    id: str(r.id),
    runId: str(r.run_id),
    stepId: str(r.step_id),
    payloadHash: str(r.payload_hash),
    preview: json(r.preview) as Preview,
    status: str(r.status) as ApprovalStatus,
    comment: strOrNull(r.comment),
    createdAt: str(r.created_at),
    decidedAt: strOrNull(r.decided_at),
  };
}

export const RUN_COLUMNS = { status: 'status', repoId: 'repo_id', standId: 'stand_id', presetId: 'preset_id', dryRun: 'dry_run' } as const;
export const STEP_COLUMNS = {
  selected: 'selected',
  status: 'status',
  note: 'note',
  error: 'error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  feedback: 'feedback',
  retryNote: 'retry_note',
} as const;

export function sqlValue(v: unknown): SQLInputValue {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v as SQLInputValue;
}

export function buildSet(patch: Record<string, unknown>, columns: Record<string, string>): { sql: string; values: SQLInputValue[] } {
  const parts: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (!column || value === undefined) continue;
    parts.push(`${column} = ?`);
    values.push(sqlValue(value));
  }
  return { sql: parts.join(', '), values };
}
