-- המאגר התפעולי של הסוכן (SQLite, node:sqlite). לא נוגע בקובצי ההיסטוריה של Claude.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, spoken_name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE, phone_enabled INTEGER NOT NULL DEFAULT 1,
  permissions_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);

-- שיחות שהמערכת פתחה או מכירה (המשך שיחה בטלפון בשלב 1 הוא רק לשיחות האלה)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, source TEXT NOT NULL,
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT, state TEXT NOT NULL, source TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '', recording_path TEXT,
  result_text TEXT, result_summary TEXT, error TEXT, heard INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);

-- כל מעבר מצב נרשם עם זמן, גורם וסיבה (אפיון 4)
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
  from_state TEXT, to_state TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, at TEXT NOT NULL
);

-- נעילה לשיחה: אין שני תהליכים כותבים לאותה שיחה
CREATE TABLE IF NOT EXISTS conversation_locks (
  conversation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, locked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, input_json TEXT NOT NULL, summary TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  decision TEXT, decided_at TEXT, decided_via TEXT, explanation TEXT
);

-- מניעת כפילויות: כל אירוע מימות (שיחה + צעד) נרשם פעם אחת, עם התשובה שניתנה
CREATE TABLE IF NOT EXISTS phone_events (
  event_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, received_at TEXT NOT NULL, response TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, phone TEXT NOT NULL,
  at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, event_kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, sent_at TEXT, deferred_until TEXT
);

-- הגדרות שמשתנות מהטלפון: מצב שינויים, קול ההקראה ומהירותה
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
