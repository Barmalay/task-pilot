/** Таблицы базы Task Pilot: создаются при открытии, если их еще нет. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  stand_id TEXT,
  preset_id TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_issue ON runs (issue_key, created_at);
CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  selected INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, step_id)
);
CREATE TABLE IF NOT EXISTS run_context (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  step_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  step_id TEXT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  preview TEXT NOT NULL,
  status TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals (run_id, step_id, status);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  session_id TEXT,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_run ON questions (run_id, status);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_sessions_run ON agent_sessions (run_id, step_id, started_at);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  error TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS asks_run ON asks (run_id, created_at);
CREATE TABLE IF NOT EXISTS monitor_settings (
  dashboard_id TEXT PRIMARY KEY,
  refresh TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_alerts (
  dashboard_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  state TEXT NOT NULL,
  value REAL,
  threshold REAL,
  text TEXT NOT NULL,
  since TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (dashboard_id, alert_id)
);
CREATE TABLE IF NOT EXISTS feature_days (
  feature TEXT NOT NULL,
  day TEXT NOT NULL,
  counts TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (feature, day)
);
CREATE TABLE IF NOT EXISTS monitor_edits (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  messages TEXT NOT NULL,
  base TEXT NOT NULL,
  draft TEXT,
  summary TEXT,
  errors TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_edits_target ON monitor_edits (target, created_at);
CREATE TABLE IF NOT EXISTS monitor_versions (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_versions_target ON monitor_versions (target, created_at);
CREATE TABLE IF NOT EXISTS integration_accounts (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  login TEXT,
  name TEXT,
  hint TEXT,
  dir TEXT,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS integration_settings (
  integration TEXT PRIMARY KEY,
  active TEXT REFERENCES integration_accounts(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Колонки, добавленные после первой версии схемы: в старой базе они появляются при открытии. */
export const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'run_steps', column: 'draft', ddl: 'draft TEXT' },
  { table: 'run_steps', column: 'feedback', ddl: 'feedback TEXT' },
  { table: 'run_steps', column: 'retry_note', ddl: 'retry_note TEXT' },
  { table: 'run_steps', column: 'params', ddl: 'params TEXT' },
  { table: 'agent_sessions', column: 'started', ddl: 'started INTEGER NOT NULL DEFAULT 0' },
];
