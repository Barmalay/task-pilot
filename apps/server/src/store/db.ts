import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { FeatureDay, ParamValues, Preview } from '@task-pilot/step-kit';
import {
  buildSet,
  json,
  now,
  RUN_COLUMNS,
  STEP_COLUMNS,
  str,
  strOrNull,
  toAgentSession,
  toApproval,
  toAsk,
  toEvent,
  toMonitorEdit,
  toMonitorVersion,
  toQuestion,
  toRun,
  toStep,
  type AgentSessionRow,
  type AgentSessionStatus,
  type AgentStats,
  type ApprovalRow,
  type ApprovalStatus,
  type AskRow,
  type EventRow,
  type IntegrationAccountKind,
  type IntegrationAccountRow,
  type MonitorAlertRow,
  type MonitorEditMessage,
  type MonitorEditRow,
  type MonitorEditStatus,
  type MonitorVersionRow,
  type QuestionRow,
  type RunRow,
  type RunStepRow,
} from './rows.ts';
import { ADDED_COLUMNS, SCHEMA } from './schema.ts';

export type {
  MonitorEditMessage,
  MonitorEditRow,
  MonitorEditStatus,
  MonitorVersionRow,
  AgentSessionRow,
  AgentSessionStatus,
  AgentStats,
  ApprovalRow,
  ApprovalStatus,
  AskRow,
  AskStatus,
  EventRow,
  IntegrationAccountKind,
  IntegrationAccountRow,
  MonitorAlertRow,
  QuestionRow,
  QuestionStatus,
  RunRow,
  RunStepRow,
} from './rows.ts';

/**
 * Интеграции с активным аккаунтом Task Pilot (токен или вход Claude) по файлу базы, открытому только на чтение: одни
 * id интеграций, без токенов и подписей. Нет базы или в ней еще нет таблиц - пусто.
 */
export function activeIntegrationsIn(file: string): string[] {
  if (!existsSync(file)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db
      .prepare('SELECT integration FROM integration_settings WHERE active IS NOT NULL ORDER BY integration')
      .all()
      .map((r) => str(r.integration));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Хранилище прогонов на node:sqlite. */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    for (const c of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${c.table})`).all().map((r) => String(r.name));
      if (!columns.includes(c.column)) this.db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.ddl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Согласованная копия базы в новый файл (VACUUM INTO): запись в базу на это время ждет. Файла быть не должно. */
  backupTo(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  createRun(
    input: { issueKey: string; repoId: string; standId: string | null; presetId: string; dryRun: boolean },
    steps: { stepId: string; selected: boolean }[],
  ): RunRow {
    const id = randomUUID();
    const ts = now();
    this.tx(() => {
      this.db
        .prepare('INSERT INTO runs (id, issue_key, repo_id, stand_id, preset_id, dry_run, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.issueKey, input.repoId, input.standId, input.presetId, input.dryRun ? 1 : 0, 'idle', ts, ts);
      const insert = this.db.prepare('INSERT INTO run_steps (run_id, step_id, position, selected, status) VALUES (?, ?, ?, ?, ?)');
      steps.forEach((s, i) => insert.run(id, s.stepId, i, s.selected ? 1 : 0, 'pending'));
    });
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? toRun(r) : undefined;
  }

  listRuns(limit = 50): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit).map(toRun);
  }

  /**
   * Удаляет прогон со всем, что к нему привязано: шаги с черновиками, контекст, подтверждения, вопросы и сессии
   * агентов уходят каскадом, ленту событий (у нее нет внешнего ключа) удаляет запрос.
   */
  deleteRun(runId: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM events WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    });
  }

  /** Id сессий агентов прогона: журналы сессий лежат в папках agent/<id> служебной папки. */
  agentSessionIds(runId: string): string[] {
    return this.db.prepare('SELECT id FROM agent_sessions WHERE run_id = ?').all(runId).map((r) => str(r.id));
  }

  /** Ключи задач прогонов с префиксом, например PILOT-: по ним мастер шагов нумерует свои прогоны. */
  issueKeys(prefix: string): string[] {
    return this.db
      .prepare('SELECT DISTINCT issue_key FROM runs WHERE substr(issue_key, 1, ?) = ?')
      .all(prefix.length, prefix)
      .map((r) => str(r.issue_key));
  }

  /** Все прогоны задачи, новые первыми. */
  runsOfIssue(issueKey: string): RunRow[] {
    return this.db.prepare('SELECT * FROM runs WHERE issue_key = ? ORDER BY created_at DESC').all(issueKey).map(toRun);
  }

  /** Последний прогон по каждой из задач. */
  latestRunsByIssue(keys: string[]): Map<string, RunRow> {
    const result = new Map<string, RunRow>();
    if (!keys.length) return result;
    const marks = keys.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT * FROM runs WHERE issue_key IN (${marks}) ORDER BY created_at ASC`).all(...keys);
    for (const row of rows) {
      const run = toRun(row);
      result.set(run.issueKey, run);
    }
    return result;
  }

  updateRun(id: string, patch: Partial<Pick<RunRow, 'status' | 'repoId' | 'standId' | 'presetId' | 'dryRun'>>): void {
    const { sql, values } = buildSet(patch, RUN_COLUMNS);
    if (!sql) return;
    this.db.prepare(`UPDATE runs SET ${sql}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  }

  getSteps(runId: string): RunStepRow[] {
    return this.db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY position').all(runId).map(toStep);
  }

  getStep(runId: string, stepId: string): RunStepRow | undefined {
    const r = this.db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?').get(runId, stepId);
    return r ? toStep(r) : undefined;
  }

  updateStep(runId: string, stepId: string, patch: Partial<Pick<RunStepRow, keyof typeof STEP_COLUMNS>>): void {
    const { sql, values } = buildSet(patch, STEP_COLUMNS);
    if (!sql) return;
    this.db.prepare(`UPDATE run_steps SET ${sql} WHERE run_id = ? AND step_id = ?`).run(...values, runId, stepId);
    this.db.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(now(), runId);
  }

  /** Черновик шага; undefined - черновика нет. */
  getDraft(runId: string, stepId: string): unknown {
    const r = this.db.prepare('SELECT draft FROM run_steps WHERE run_id = ? AND step_id = ?').get(runId, stepId);
    return r?.draft == null ? undefined : json(r.draft);
  }

  /** Сохраняет настройки шага, выбранные в прогоне; пустой набор - шаг снова идет с умолчаниями. */
  setStepParams(runId: string, stepId: string, params: ParamValues): void {
    const value = Object.keys(params).length ? JSON.stringify(params) : null;
    this.db.prepare('UPDATE run_steps SET params = ? WHERE run_id = ? AND step_id = ?').run(value, runId, stepId);
    this.db.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(now(), runId);
  }

  /** Сохраняет черновик шага; undefined его удаляет. */
  setDraft(runId: string, stepId: string, draft: unknown): void {
    const value = draft === undefined ? null : JSON.stringify(draft ?? null);
    this.db.prepare('UPDATE run_steps SET draft = ? WHERE run_id = ? AND step_id = ?').run(value, runId, stepId);
  }

  setContext(runId: string, key: string, value: unknown, stepId: string | null): void {
    this.db
      .prepare(
        'INSERT INTO run_context (run_id, key, value, step_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, key) DO UPDATE SET value = excluded.value, step_id = excluded.step_id, updated_at = excluded.updated_at',
      )
      .run(runId, key, JSON.stringify(value ?? null), stepId, now());
  }

  /** Убирает один ключ из контекста прогона. */
  deleteContext(runId: string, key: string): void {
    this.db.prepare('DELETE FROM run_context WHERE run_id = ? AND key = ?').run(runId, key);
  }

  /** Удаляет из контекста то, что последним записал шаг: например, выходы пробного прогона. */
  deleteContextOf(runId: string, stepId: string): number {
    return Number(this.db.prepare('DELETE FROM run_context WHERE run_id = ? AND step_id = ?').run(runId, stepId).changes);
  }

  getContext(runId: string): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM run_context WHERE run_id = ?').all(runId);
    return Object.fromEntries(rows.map((r) => [str(r.key), json(r.value)]));
  }

  addEvent(e: { runId?: string | null; stepId?: string | null; type: string; message?: string | null; data?: unknown }): EventRow {
    const result = this.db
      .prepare('INSERT INTO events (run_id, step_id, ts, type, message, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.runId ?? null, e.stepId ?? null, now(), e.type, e.message ?? null, e.data === undefined ? null : JSON.stringify(e.data));
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid);
    return toEvent(row!);
  }

  /** Первое событие прогона этого типа; undefined - такого не было. */
  firstEventOf(runId: string, type: string): EventRow | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND type = ? ORDER BY id LIMIT 1').get(runId, type);
    return row ? toEvent(row) : undefined;
  }

  listEvents(runId: string, afterId = 0, limit = 500): EventRow[] {
    return this.db
      .prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
      .all(runId, afterId, limit)
      .map(toEvent);
  }

  /** Событие прогона по id; undefined - такого нет или оно из другого прогона. */
  getEvent(runId: string, id: number): EventRow | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND id = ?').get(runId, id);
    return r ? toEvent(r) : undefined;
  }

  /** Страница ленты: до limit событий прогона старше before (без него - самые новые) по порядку и есть ли еще старше. */
  eventsPage(runId: string, before: number | null, limit: number): { events: EventRow[]; more: boolean } {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(runId, before ?? Number.MAX_SAFE_INTEGER, limit + 1)
      .map(toEvent);
    return { events: rows.slice(0, limit).reverse(), more: rows.length > limit };
  }

  /**
   * До limit событий этих типов старше before (без него - самые новые), от новых к старым, по всем прогонам и без
   * прогона: из них собирается история уведомлений.
   */
  eventsOfTypes(types: readonly string[], before: number | null, limit: number): EventRow[] {
    if (!types.length) return [];
    return this.db
      .prepare(`SELECT * FROM events WHERE type IN (${types.map(() => '?').join(', ')}) AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(...types, before ?? Number.MAX_SAFE_INTEGER, limit)
      .map(toEvent);
  }

  /** События прогона, из которых считается время: статусы шагов и прогона, запросы и решения подтверждений. */
  timingEvents(runId: string): EventRow[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE run_id = ? AND type IN ('step.status', 'run.status', 'approval.requested', 'approval.decided', 'approval.stale') ORDER BY id",
      )
      .all(runId)
      .map(toEvent);
  }

  /** События прогона для журнала разбора: решения на подтверждениях, статусы шагов, отказы агентам и круги петель. */
  journalEvents(runId: string): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND type IN ('approval.decided', 'step.status', 'agent.denied', 'loop.restart') ORDER BY id")
      .all(runId)
      .map(toEvent);
  }

  /** Моменты перезапуска сервера, когда были прерваны шаги в работе: событий статуса у прерванных шагов нет. */
  restartTimes(): string[] {
    return this.db
      .prepare("SELECT ts FROM events WHERE run_id IS NULL AND type = 'engine.recovered' ORDER BY id")
      .all()
      .map((r) => str(r.ts));
  }

  createApproval(a: { runId: string; stepId: string; payloadHash: string; preview: Preview }): ApprovalRow {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO approvals (id, run_id, step_id, payload_hash, preview, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.runId, a.stepId, a.payloadHash, JSON.stringify(a.preview), 'pending', now());
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return r ? toApproval(r) : undefined;
  }

  /** Последний запрос подтверждения шага в нужном статусе. */
  findApproval(runId: string, stepId: string, status: ApprovalStatus): ApprovalRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM approvals WHERE run_id = ? AND step_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
      .get(runId, stepId, status);
    return r ? toApproval(r) : undefined;
  }

  /** Гасит ожидающие и неизрасходованные одобренные запросы прогона или одного шага; возвращает их число. */
  staleApprovals(runId: string, stepId?: string): number {
    const r = stepId
      ? this.db
          .prepare("UPDATE approvals SET status = 'stale', decided_at = ? WHERE run_id = ? AND step_id = ? AND status IN ('pending', 'approved')")
          .run(now(), runId, stepId)
      : this.db.prepare("UPDATE approvals SET status = 'stale', decided_at = ? WHERE run_id = ? AND status IN ('pending', 'approved')").run(now(), runId);
    return Number(r.changes);
  }

  /** Шаги, выбор которых владелец менял сам. */
  toggledSteps(runId: string): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT step_id FROM events WHERE run_id = ? AND type = 'step.selected' AND step_id IS NOT NULL").all(runId);
    return new Set(rows.map((r) => str(r.step_id)));
  }

  /**
   * Ставит шаги прогона в заданном порядке: существующие переставляет, недостающие добавляет, шаги не из
   * списка удаляет вместе с черновиками. Статусы оставшихся шагов не меняются.
   */
  resyncSteps(runId: string, steps: { stepId: string; selected: boolean }[]): void {
    this.tx(() => {
      const existing = new Set(this.getSteps(runId).map((s) => s.stepId));
      const wanted = new Set(steps.map((s) => s.stepId));
      const update = this.db.prepare('UPDATE run_steps SET position = ?, selected = ? WHERE run_id = ? AND step_id = ?');
      const insert = this.db.prepare('INSERT INTO run_steps (run_id, step_id, position, selected, status) VALUES (?, ?, ?, ?, ?)');
      const remove = this.db.prepare('DELETE FROM run_steps WHERE run_id = ? AND step_id = ?');
      for (const stepId of existing) if (!wanted.has(stepId)) remove.run(runId, stepId);
      steps.forEach((s, i) => {
        if (existing.has(s.stepId)) update.run(i, s.selected ? 1 : 0, runId, s.stepId);
        else insert.run(runId, s.stepId, i, s.selected ? 1 : 0, 'pending');
      });
      this.db.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(now(), runId);
    });
  }

  /** Ожидающий решения запрос подтверждения в прогоне; если их несколько, то самый свежий. */
  pendingApproval(runId: string): ApprovalRow | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(runId);
    return r ? toApproval(r) : undefined;
  }

  /** Все ожидающие решения запросы подтверждения прогона, от ранних к поздним: у шага цепочки и у фоновых шагов. */
  pendingApprovals(runId: string): ApprovalRow[] {
    return this.db.prepare("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at, rowid").all(runId).map(toApproval);
  }

  /** Ожидающие решения запросы подтверждения всех прогонов, от ранних к поздним: то, что ждет владельца. */
  allPendingApprovals(): ApprovalRow[] {
    return this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at, rowid").all().map(toApproval);
  }

  updateApproval(id: string, patch: { status: ApprovalStatus; comment?: string | null }): void {
    this.db
      .prepare('UPDATE approvals SET status = ?, comment = COALESCE(?, comment), decided_at = ? WHERE id = ?')
      .run(patch.status, patch.comment ?? null, now(), id);
  }

  createQuestion(q: { runId: string; stepId: string; sessionId: string | null; question: string; options: string[] }): QuestionRow {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO questions (id, run_id, step_id, session_id, question, options, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, q.runId, q.stepId, q.sessionId, q.question, JSON.stringify(q.options), 'open', now());
    return this.getQuestion(id)!;
  }

  getQuestion(id: string): QuestionRow | undefined {
    const r = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    return r ? toQuestion(r) : undefined;
  }

  /** Все вопросы агентов прогона по времени. */
  questionsOf(runId: string): QuestionRow[] {
    return this.db.prepare('SELECT * FROM questions WHERE run_id = ? ORDER BY created_at').all(runId).map(toQuestion);
  }

  /** Открытые вопросы прогона, старые первыми. */
  openQuestions(runId: string): QuestionRow[] {
    return this.db.prepare("SELECT * FROM questions WHERE run_id = ? AND status = 'open' ORDER BY created_at").all(runId).map(toQuestion);
  }

  /** Открытые вопросы агентов всех прогонов, старые первыми: то, что ждет ответа владельца. */
  allOpenQuestions(): QuestionRow[] {
    return this.db.prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY created_at").all().map(toQuestion);
  }

  /** Новый вопрос владельца о прогоне: ждет ответа агента. */
  createAsk(runId: string, question: string): AskRow {
    const id = randomUUID();
    this.db.prepare("INSERT INTO asks (id, run_id, question, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(id, runId, question, now());
    return this.getAsk(id)!;
  }

  getAsk(id: string): AskRow | undefined {
    const r = this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id);
    return r ? toAsk(r) : undefined;
  }

  /** Вопросы владельца о прогоне по порядку: старые первыми. */
  asksOf(runId: string): AskRow[] {
    return this.db.prepare('SELECT * FROM asks WHERE run_id = ? ORDER BY created_at, rowid').all(runId).map(toAsk);
  }

  /** Закрывает вопрос о прогоне ответом агента или ошибкой. */
  finishAsk(id: string, result: { answer: string; costUsd: number } | { error: string; costUsd: number | null }): void {
    const answer = 'answer' in result ? result.answer : null;
    const error = 'error' in result ? result.error : null;
    this.db
      .prepare('UPDATE asks SET status = ?, answer = ?, error = ?, cost_usd = ?, answered_at = ? WHERE id = ?')
      .run(answer === null ? 'failed' : 'answered', answer, error, result.costUsd, now(), id);
  }

  /** Отвечает на открытый вопрос; false, если вопрос уже закрыт. */
  answerQuestion(id: string, answer: string): boolean {
    const r = this.db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'").run(answer, now(), id);
    return Number(r.changes) > 0;
  }

  /** Закрывает без ответа открытые вопросы сессии агента или один вопрос. */
  expireQuestions(filter: { sessionId?: string; id?: string }): number {
    const r = filter.id
      ? this.db.prepare("UPDATE questions SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'open'").run(now(), filter.id)
      : this.db.prepare("UPDATE questions SET status = 'expired', answered_at = ? WHERE session_id = ? AND status = 'open'").run(now(), filter.sessionId ?? '');
    return Number(r.changes);
  }

  createAgentSession(a: { sessionId: string; runId: string; stepId: string; label: string; model: string | null }): AgentSessionRow {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO agent_sessions (id, session_id, run_id, step_id, label, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.sessionId, a.runId, a.stepId, a.label, a.model, 'running', now());
    return this.getAgentSession(id)!;
  }

  getAgentSession(id: string): AgentSessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id);
    return r ? toAgentSession(r) : undefined;
  }

  /** CLI начал сессию (пришло событие init): только такую сессию можно продолжить через --resume. */
  markAgentStarted(id: string): void {
    this.db.prepare('UPDATE agent_sessions SET started = 1 WHERE id = ?').run(id);
  }

  finishAgentSession(id: string, patch: { status: AgentSessionStatus; costUsd?: number; durationMs?: number; turns?: number; error?: string | null }): void {
    this.db
      .prepare('UPDATE agent_sessions SET status = ?, cost_usd = ?, duration_ms = ?, turns = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(patch.status, patch.costUsd ?? 0, patch.durationMs ?? 0, patch.turns ?? 0, patch.error ?? null, now(), id);
  }

  /**
   * Последний запуск агента шага с этой меткой, в котором CLI действительно начал сессию.
   * Запуск, упавший до начала сессии, продолжить нельзя: такой сессии в Claude нет.
   */
  lastAgentSession(runId: string, stepId: string, label: string): AgentSessionRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM agent_sessions WHERE run_id = ? AND step_id = ? AND label = ? AND started = 1 ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(runId, stepId, label);
    return r ? toAgentSession(r) : undefined;
  }

  /** Все запуски агентов прогона по времени. */
  /** Расход агентов в долларах по сессиям, которые кончились с момента iso (или идут, начавшись после него). */
  agentSpendSince(iso: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM agent_sessions WHERE COALESCE(finished_at, started_at) >= ?').get(iso);
    // Агенты правок мониторинга идут вне прогонов, их расход лежит у правок.
    const edits = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM monitor_edits WHERE updated_at >= ?').get(iso);
    return Number(r?.usd ?? 0) + Number(edits?.usd ?? 0);
  }

  agentSessionsOf(runId: string): AgentSessionRow[] {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE run_id = ? ORDER BY started_at').all(runId).map(toAgentSession);
  }

  /** Сводка агентных запусков по шагам прогона. */
  agentStats(runId: string): Map<string, AgentStats> {
    const rows = this.db
      .prepare(
        "SELECT step_id, COUNT(*) AS runs, SUM(cost_usd) AS cost, SUM(duration_ms) AS duration, SUM(status = 'running') AS running FROM agent_sessions WHERE run_id = ? GROUP BY step_id",
      )
      .all(runId);
    return new Map(rows.map((r) => [str(r.step_id), { runs: Number(r.runs), costUsd: Number(r.cost), durationMs: Number(r.duration), running: Number(r.running) > 0 }]));
  }

  /**
   * После перезапуска сервера шаги в работе считаются прерванными, а их прогоны встают на паузу.
   * Агентов прежнего процесса уже нет: их запуски помечаются прерванными, вопросы закрываются, а вопросы владельца о
   * прогоне, на которые агент не успел ответить, - отвеченными ошибкой.
   */
  markInterrupted(): { steps: number; runs: number } {
    return this.tx(() => {
      const steps = this.db
        .prepare("UPDATE run_steps SET status = 'failed', error = 'Прервано перезапуском сервера', finished_at = ? WHERE status = 'running'")
        .run(now());
      const runs = this.db.prepare("UPDATE runs SET status = 'paused', updated_at = ? WHERE status = 'running'").run(now());
      this.db.prepare("UPDATE agent_sessions SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());
      this.db.prepare("UPDATE questions SET status = 'expired', answered_at = ? WHERE status = 'open'").run(now());
      this.db.prepare("UPDATE asks SET status = 'failed', error = 'Сервер перезапустился, пока агент отвечал: спросите снова', answered_at = ? WHERE status = 'pending'").run(now());
      return { steps: Number(steps.changes), runs: Number(runs.changes) };
    });
  }

  /** Интервал опроса дашборда, выбранный на странице; null - берется из файла дашборда. */
  monitorRefresh(dashboardId: string): string | null {
    const r = this.db.prepare('SELECT refresh FROM monitor_settings WHERE dashboard_id = ?').get(dashboardId);
    return r ? str(r.refresh) : null;
  }

  setMonitorRefresh(dashboardId: string, refresh: string): void {
    this.db
      .prepare('INSERT INTO monitor_settings (dashboard_id, refresh) VALUES (?, ?) ON CONFLICT(dashboard_id) DO UPDATE SET refresh = excluded.refresh')
      .run(dashboardId, refresh);
  }

  /** Дневные итоги фичи по порядку дней: строк по baseline, стадиям и ошибкам и пометка дня. */
  featureDays(feature: string): FeatureDay[] {
    return this.db
      .prepare('SELECT day, counts, note FROM feature_days WHERE feature = ? ORDER BY day')
      .all(feature)
      .map((r) => ({ day: str(r.day), counts: JSON.parse(str(r.counts)) as Record<string, number>, note: r.note === null ? null : str(r.note) }));
  }

  /** Записывает итоги дней фичи поверх прежних: история хранит дни дольше индекса логов. */
  saveFeatureDays(feature: string, days: FeatureDay[]): void {
    const put = this.db.prepare(
      'INSERT INTO feature_days (feature, day, counts, note) VALUES (?, ?, ?, ?) ON CONFLICT(feature, day) DO UPDATE SET counts = excluded.counts, note = excluded.note',
    );
    this.tx(() => {
      for (const d of days) put.run(feature, d.day, JSON.stringify(d.counts), d.note);
    });
  }

  /** Новая правка мониторинга с первой просьбой владельца. */
  createMonitorEdit(e: { target: string; base: string; message: string }): MonitorEditRow {
    const id = randomUUID();
    const at = now();
    const messages: MonitorEditMessage[] = [{ role: 'owner', text: e.message, at }];
    this.db
      .prepare("INSERT INTO monitor_edits (id, target, status, messages, base, created_at, updated_at) VALUES (?, ?, 'working', ?, ?, ?, ?)")
      .run(id, e.target, JSON.stringify(messages), e.base, at, at);
    return this.getMonitorEdit(id)!;
  }

  getMonitorEdit(id: string): MonitorEditRow | undefined {
    const r = this.db.prepare('SELECT * FROM monitor_edits WHERE id = ?').get(id);
    return r ? toMonitorEdit(r) : undefined;
  }

  /** Незакрытая правка цели: последняя, которую не применили и не отклонили. */
  openMonitorEdit(target: string): MonitorEditRow | undefined {
    const r = this.db.prepare("SELECT * FROM monitor_edits WHERE target = ? AND status NOT IN ('applied', 'discarded') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(target);
    return r ? toMonitorEdit(r) : undefined;
  }

  /** Меняет правку: статус, черновик, итог агента, ошибки проверки, новое сообщение разговора. */
  updateMonitorEdit(id: string, patch: { status?: MonitorEditStatus; draft?: string | null; summary?: string | null; errors?: string[]; message?: MonitorEditMessage }): MonitorEditRow {
    const cur = this.getMonitorEdit(id);
    if (!cur) throw new Error(`Правки ${id} нет`);
    const messages = patch.message ? [...cur.messages, patch.message] : cur.messages;
    this.db
      .prepare('UPDATE monitor_edits SET status = ?, draft = ?, summary = ?, errors = ?, messages = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.status ?? cur.status,
        patch.draft === undefined ? cur.draft : patch.draft,
        patch.summary === undefined ? cur.summary : patch.summary,
        JSON.stringify(patch.errors ?? cur.errors),
        JSON.stringify(messages),
        now(),
        id,
      );
    return this.getMonitorEdit(id)!;
  }

  /** Прибавляет расход агента к правке: он входит в общий расход агентов. */
  addMonitorEditCost(id: string, costUsd: number): void {
    if (costUsd > 0) this.db.prepare('UPDATE monitor_edits SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?').run(costUsd, now(), id);
  }

  /** Сохраняет прошлую версию файла мониторинга. */
  addMonitorVersion(v: { target: string; source: string; note: string | null }): MonitorVersionRow {
    const id = randomUUID();
    this.db.prepare('INSERT INTO monitor_versions (id, target, source, note, created_at) VALUES (?, ?, ?, ?, ?)').run(id, v.target, v.source, v.note, now());
    return this.getMonitorVersion(id)!;
  }

  getMonitorVersion(id: string): MonitorVersionRow | undefined {
    const r = this.db.prepare('SELECT * FROM monitor_versions WHERE id = ?').get(id);
    return r ? toMonitorVersion(r) : undefined;
  }

  /** Прошлые версии файла, новые первыми. */
  monitorVersions(target: string, limit = 30): MonitorVersionRow[] {
    return this.db.prepare('SELECT * FROM monitor_versions WHERE target = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(target, limit).map(toMonitorVersion);
  }

  /** Последние проверки алертов: всех или одного дашборда. */
  monitorAlerts(dashboardId?: string): MonitorAlertRow[] {
    const rows = dashboardId
      ? this.db.prepare('SELECT * FROM monitor_alerts WHERE dashboard_id = ? ORDER BY alert_id').all(dashboardId)
      : this.db.prepare('SELECT * FROM monitor_alerts ORDER BY dashboard_id, alert_id').all();
    return rows.map((r) => ({
      dashboardId: str(r.dashboard_id),
      alertId: str(r.alert_id),
      state: str(r.state) as MonitorAlertRow['state'],
      value: r.value === null ? null : Number(r.value),
      threshold: r.threshold === null ? null : Number(r.threshold),
      text: str(r.text),
      since: str(r.since),
      checkedAt: str(r.checked_at),
    }));
  }

  /** Записывает проверку алерта; since сдвигается, только когда меняется состояние. */
  saveMonitorAlert(row: Omit<MonitorAlertRow, 'since' | 'checkedAt'> & { checkedAt?: string }): MonitorAlertRow {
    const checkedAt = row.checkedAt ?? now();
    this.db
      .prepare(
        `INSERT INTO monitor_alerts (dashboard_id, alert_id, state, value, threshold, text, since, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dashboard_id, alert_id) DO UPDATE SET
           since = CASE WHEN monitor_alerts.state = excluded.state THEN monitor_alerts.since ELSE excluded.since END,
           state = excluded.state, value = excluded.value, threshold = excluded.threshold, text = excluded.text, checked_at = excluded.checked_at`,
      )
      .run(row.dashboardId, row.alertId, row.state, row.value, row.threshold, row.text, checkedAt, checkedAt);
    return this.monitorAlerts(row.dashboardId).find((a) => a.alertId === row.alertId)!;
  }

  /** Убирает алерты, которых больше нет в дашборде или дашборд удален. */
  pruneMonitorAlerts(keep: { dashboardId: string; alertId: string }[]): void {
    const alive = new Set(keep.map((k) => `${k.dashboardId}/${k.alertId}`));
    for (const a of this.monitorAlerts()) {
      if (!alive.has(`${a.dashboardId}/${a.alertId}`)) this.db.prepare('DELETE FROM monitor_alerts WHERE dashboard_id = ? AND alert_id = ?').run(a.dashboardId, a.alertId);
    }
  }

  /** Аккаунты интеграций в порядке заведения: все или одной интеграции. */
  integrationAccounts(integration?: string): IntegrationAccountRow[] {
    const rows = integration
      ? this.db.prepare('SELECT * FROM integration_accounts WHERE integration = ? ORDER BY created_at, id').all(integration)
      : this.db.prepare('SELECT * FROM integration_accounts ORDER BY created_at, id').all();
    return rows.map((r) => ({
      id: str(r.id),
      integration: str(r.integration),
      kind: str(r.kind) as IntegrationAccountKind,
      label: strOrNull(r.label),
      login: strOrNull(r.login),
      name: strOrNull(r.name),
      hint: strOrNull(r.hint),
      dir: strOrNull(r.dir),
      createdAt: str(r.created_at),
      checkedAt: strOrNull(r.checked_at),
      error: strOrNull(r.error),
    }));
  }

  addIntegrationAccount(a: Pick<IntegrationAccountRow, 'integration' | 'kind' | 'label' | 'login' | 'name' | 'hint' | 'dir'> & { id?: string }): IntegrationAccountRow {
    const id = a.id ?? randomUUID().slice(0, 8);
    const ts = now();
    this.db
      .prepare('INSERT INTO integration_accounts (id, integration, kind, label, login, name, hint, dir, created_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.integration, a.kind, a.label, a.login, a.name, a.hint, a.dir, ts, ts);
    return this.integrationAccounts(a.integration).find((r) => r.id === id)!;
  }

  /** Итог проверки аккаунта: кто владелец доступа или почему проверка не прошла. */
  checkedIntegrationAccount(id: string, result: { login?: string | null; name?: string | null; error: string | null }): void {
    const known = result.error === null;
    this.db
      .prepare(
        'UPDATE integration_accounts SET checked_at = ?, error = ?, login = CASE WHEN ? THEN ? ELSE login END, name = CASE WHEN ? THEN ? ELSE name END WHERE id = ?',
      )
      .run(now(), result.error, known ? 1 : 0, result.login ?? null, known ? 1 : 0, result.name ?? null, id);
  }

  removeIntegrationAccount(id: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE integration_settings SET active = NULL WHERE active = ?').run(id);
      this.db.prepare('DELETE FROM integration_accounts WHERE id = ?').run(id);
    });
  }

  /** Активный аккаунт интеграции; null - доступ "как обычно", из настроек Claude Code. */
  /** Настройка приложения по ключу; null - не задана. */
  setting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return r ? str(r.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  activeIntegrationAccount(integration: string): string | null {
    const r = this.db.prepare('SELECT active FROM integration_settings WHERE integration = ?').get(integration);
    return r ? strOrNull(r.active) : null;
  }

  setActiveIntegrationAccount(integration: string, accountId: string | null): void {
    this.db
      .prepare('INSERT INTO integration_settings (integration, active) VALUES (?, ?) ON CONFLICT(integration) DO UPDATE SET active = excluded.active')
      .run(integration, accountId);
  }
}
