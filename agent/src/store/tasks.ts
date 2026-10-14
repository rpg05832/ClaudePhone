// משימות: יצירה, מעברי מצב מאומתים, תור, תוצאות. כל מעבר נרשם ב-task_events.
import { randomUUID } from 'node:crypto';
import { TASK_TRANSITIONS, ACTIVE_STATES } from '@claude-phone/shared';
import type { Task, TaskState, TaskSource } from '@claude-phone/shared';
import { Store, nowIso } from './db.ts';

export class InvalidTransition extends Error {
  constructor(public taskId: string, public from: TaskState, public to: TaskState) {
    super(`מעבר לא חוקי במשימה ${taskId}: ${from} -> ${to}`);
  }
}

export class Tasks {
  constructor(private store: Store) {}
  private get db() { return this.store.db; }

  create(t: { projectId: string; source: TaskSource; phone?: string | null; conversationId?: string | null; recordingPath?: string | null; prompt?: string; expiresHours?: number }): Task {
    const id = randomUUID();
    const at = nowIso();
    const expires = t.expiresHours ? new Date(Date.now() + t.expiresHours * 3600_000).toISOString() : null;
    const tx = this.db.prepare('BEGIN');
    tx.run();
    try {
      const num = ((this.db.prepare('SELECT COALESCE(MAX(num), 0) AS m FROM tasks').get() as any).m as number) + 1;
      this.db.prepare(`INSERT INTO tasks (id, num, project_id, conversation_id, state, source, prompt, recording_path, phone, created_at, updated_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, num, t.projectId, t.conversationId ?? null, 'draft', t.source, t.prompt ?? '', t.recordingPath ?? null, t.phone ?? null, at, at, expires);
      this.db.prepare('INSERT INTO task_events (task_id, from_state, to_state, actor, reason, at) VALUES (?,?,?,?,?,?)').run(id, null, 'draft', t.source, 'created', at);
      this.db.prepare('COMMIT').run();
    } catch (e) { this.db.prepare('ROLLBACK').run(); throw e; }
    return this.get(id)!;
  }

  get(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    return r ? rowToTask(r) : null;
  }

  getByNum(num: number): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE num = ?').get(num) as any;
    return r ? rowToTask(r) : null;
  }

  /** מעבר מצב מאומת. מחזיר את המשימה המעודכנת; זורק InvalidTransition אם המעבר לא מותר. */
  transition(id: string, to: TaskState, actor: string, reason?: string, patch: Partial<Pick<Task, 'prompt' | 'conversationId' | 'resultText' | 'resultSummary' | 'error' | 'recordingPath'>> = {}): Task {
    const task = this.get(id);
    if (!task) throw new Error(`משימה ${id} לא נמצאה`);
    if (!TASK_TRANSITIONS[task.state].includes(to)) throw new InvalidTransition(id, task.state, to);
    const at = nowIso();
    this.db.prepare(`UPDATE tasks SET state = ?, updated_at = ?,
        prompt = COALESCE(?, prompt), conversation_id = COALESCE(?, conversation_id), result_text = COALESCE(?, result_text),
        result_summary = COALESCE(?, result_summary), error = COALESCE(?, error), recording_path = COALESCE(?, recording_path)
      WHERE id = ?`).run(to, at, patch.prompt ?? null, patch.conversationId ?? null, patch.resultText ?? null, patch.resultSummary ?? null, patch.error ?? null, patch.recordingPath ?? null, id);
    this.db.prepare('INSERT INTO task_events (task_id, from_state, to_state, actor, reason, at) VALUES (?,?,?,?,?,?)').run(id, task.state, to, actor, reason ?? null, at);
    return this.get(id)!;
  }

  /** עדכון שדות בלי מעבר מצב (למשל תמלול שהתקבל). */
  patch(id: string, patch: Partial<Pick<Task, 'prompt' | 'conversationId' | 'recordingPath' | 'resultText' | 'resultSummary' | 'error' | 'model'>>): Task {
    this.db.prepare(`UPDATE tasks SET updated_at = ?,
        prompt = COALESCE(?, prompt), conversation_id = COALESCE(?, conversation_id), recording_path = COALESCE(?, recording_path),
        result_text = COALESCE(?, result_text), result_summary = COALESCE(?, result_summary), error = COALESCE(?, error),
        model = COALESCE(?, model)
      WHERE id = ?`).run(nowIso(), patch.prompt ?? null, patch.conversationId ?? null, patch.recordingPath ?? null, patch.resultText ?? null, patch.resultSummary ?? null, patch.error ?? null, patch.model ?? null, id);
    return this.get(id)!;
  }

  markHeard(id: string): void {
    this.db.prepare('UPDATE tasks SET heard = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  /** המשימה הבאה בתור (הישנה ביותר), או null. משימות שפג תוקפן מבוטלות. */
  nextQueued(): Task | null {
    const now = nowIso();
    const expired = this.db.prepare("SELECT id FROM tasks WHERE state = 'queued' AND expires_at IS NOT NULL AND expires_at < ?").all(now) as any[];
    for (const e of expired) this.transition(e.id, 'cancelled', 'system', 'פג תוקף ההודעה בתור');
    const r = this.db.prepare("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at LIMIT 1").get() as any;
    return r ? rowToTask(r) : null;
  }

  listActive(): Task[] {
    const q = ACTIVE_STATES.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM tasks WHERE state IN (${q}) ORDER BY created_at`).all(...ACTIVE_STATES) as any[]).map(rowToTask);
  }

  listByState(states: TaskState[], limit = 50): Task[] {
    const q = states.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM tasks WHERE state IN (${q}) ORDER BY updated_at DESC LIMIT ?`).all(...states, limit) as any[]).map(rowToTask);
  }

  /** תוצאות שטרם נשמעו (הושלמו או נכשלו), החדשה ראשונה. */
  listUnheardResults(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE state IN ('done','failed') AND heard = 0 ORDER BY updated_at DESC").all() as any[]).map(rowToTask);
  }

  latestResult(): Task | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE state IN ('done','failed') ORDER BY updated_at DESC LIMIT 1").get() as any;
    return r ? rowToTask(r) : null;
  }

  recent(limit = 30): Task[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(rowToTask);
  }

  events(taskId: string) {
    return this.db.prepare('SELECT from_state, to_state, actor, reason, at FROM task_events WHERE task_id = ? ORDER BY id').all(taskId) as any[];
  }

  /** התאוששות אחרי אתחול: משימה שרצה כשהתהליך נעלם מסומנת "דורשת בדיקה" ולא רצה שוב (אפיון 4). */
  recoverAfterRestart(): number {
    const stuck = this.listByState(['running', 'awaiting_permission', 'awaiting_answer', 'stop_requested']);
    for (const t of stuck) this.transition(t.id, 'needs_review', 'system', 'הסוכן אותחל בזמן הריצה');
    this.store.clearAllLocks();
    return stuck.length;
  }
}

export function rowToTask(r: any): Task {
  return {
    id: r.id, num: r.num, projectId: r.project_id, conversationId: r.conversation_id, state: r.state, source: r.source,
    prompt: r.prompt, recordingPath: r.recording_path, resultText: r.result_text, resultSummary: r.result_summary, error: r.error,
    heard: !!r.heard, phone: r.phone, model: r.model ?? null, createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at,
  };
}
