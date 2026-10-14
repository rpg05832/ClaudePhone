// המאגר התפעולי: node:sqlite. כל הגישה למסד עוברת דרך הקובץ הזה ודרך tasks.ts.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, ProjectPermissions, Conversation, PermissionRequest, PhoneLogEntry, TaskSource } from '@claude-phone/shared';

/** הקולות של מנוע ההקראה של ימות (מקור: https://f2.freeivr.co.il/post/78553). */
export const VOICES = [
  { id: 'ymMale', name: 'קול גברי ראשון' },
  { id: 'Elik_2100', name: 'קול גברי שני' },
  { id: 'Jacob', name: 'קול גברי שלישי' },
  { id: 'ymFemale', name: 'קול נשי ראשון' },
  { id: 'Sivan', name: 'קול נשי שני' },
  { id: 'Osnat', name: 'קול נשי שלישי' },
] as const;

export type EditMode = 'readonly' | 'edit' | 'auto';

export interface AgentSettings {
  /**
   * readonly: קריאה וייעוץ בלבד. edit: עריכת קבצים בפרויקט, ופקודות באישור בטלפון.
   * auto: כל הפעולות מאושרות אוטומטית (בחירת המשתמש בטלפון); שאלות של Claude עדיין נשאלות.
   */
  editMode: EditMode;
  voice: string;
  /** מהירות הקראה: מ-10- (איטי) עד 10 (מהיר) */
  rate: number;
  /** צינתוק בסיום משימה ובבקשת החלטה */
  notify: 'on' | 'off';
  /** מודל ברירת המחדל למשימות: default = לפי חשבון Claude */
  model: ModelChoice;
  /** רמת החשיבה: default = לפי Claude Code */
  effort: EffortChoice;
}

export type EffortChoice = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: { id: EffortChoice; name: string; spoken: string }[] = [
  { id: 'default', name: 'ברירת מחדל', spoken: 'ברירת המחדל' },
  { id: 'low', name: 'נמוכה (מהיר)', spoken: 'נמוכה' },
  { id: 'medium', name: 'בינונית', spoken: 'בינונית' },
  { id: 'high', name: 'גבוהה', spoken: 'גבוהה' },
  { id: 'xhigh', name: 'גבוהה מאוד', spoken: 'גבוהה מאוד' },
  { id: 'max', name: 'מקסימלית (איטי)', spoken: 'מקסימלית' },
];

export type ModelChoice = 'default' | 'fable' | 'opus' | 'sonnet' | 'haiku';
export const MODELS: { id: ModelChoice; name: string; spoken: string }[] = [
  { id: 'default', name: 'ברירת המחדל של החשבון', spoken: 'ברירת המחדל' },
  { id: 'fable', name: 'Fable (הדור החזק ביותר)', spoken: 'פייבל' },
  { id: 'opus', name: 'Opus (חזק מאוד)', spoken: 'אופוס' },
  { id: 'sonnet', name: 'Sonnet (מאוזן)', spoken: 'סונט' },
  { id: 'haiku', name: 'Haiku (מהיר וחסכוני)', spoken: 'הייקו' },
];

export const DEFAULT_SETTINGS: AgentSettings = { editMode: 'edit', voice: 'ymMale', rate: 0, notify: 'on', model: 'default', effort: 'default' };

export const DEFAULT_PERMISSIONS: ProjectPermissions = { editInsideProject: true, runCommands: false };

export function nowIso(): string { return new Date().toISOString(); }

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    this.db.exec(schema);
    // הוספת עמודות למאגר קיים (בלי למחוק נתונים)
    const cols = (this.db.prepare('PRAGMA table_info(tasks)').all() as any[]).map(c => c.name);
    if (!cols.includes('model')) this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT');
    const pcols = (this.db.prepare('PRAGMA table_info(projects)').all() as any[]).map(c => c.name);
    if (!pcols.includes('former_paths')) this.db.exec('ALTER TABLE projects ADD COLUMN former_paths TEXT');
    if (!pcols.includes('listed')) this.db.exec('ALTER TABLE projects ADD COLUMN listed INTEGER NOT NULL DEFAULT 1');
  }

  close(): void { this.db.close(); }

  // ---------- הגדרות ----------

  getSettings(): AgentSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as any[];
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
      editMode: m.editMode === 'readonly' || m.editMode === 'auto' ? m.editMode : 'edit',
      voice: VOICES.some(v => v.id === m.voice) ? m.voice : DEFAULT_SETTINGS.voice,
      rate: m.rate !== undefined && Number.isFinite(Number(m.rate)) ? Math.max(-10, Math.min(10, Number(m.rate))) : DEFAULT_SETTINGS.rate,
      notify: m.notify === 'off' ? 'off' : 'on',
      model: MODELS.some(x => x.id === m.model) ? m.model : 'default',
      effort: EFFORTS.some(x => x.id === m.effort) ? m.effort : 'default',
    };
  }

  setSetting<K extends keyof AgentSettings>(key: K, value: AgentSettings[K]): void {
    this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, String(value), nowIso());
  }

  // ---------- פרויקטים ----------

  listProjects(onlyPhone = false): Project[] {
    const rows = this.db.prepare(`SELECT * FROM projects ${onlyPhone ? 'WHERE phone_enabled = 1' : ''} ORDER BY created_at`).all() as any[];
    return rows.map(rowToProject);
  }

  /** הפרויקטים שמוקראים במקש 3 (בלי תיקיות שנרשמו אוטומטית מהמשך שיחה). */
  listMenuProjects(): Project[] {
    return this.listProjects(true).filter(p => p.listed !== false);
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return r ? rowToProject(r) : null;
  }

  getProjectByPath(path: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as any;
    return r ? rowToProject(r) : null;
  }

  addProject(p: { name: string; spokenName?: string; path: string; phoneEnabled?: boolean; listed?: boolean; permissions?: Partial<ProjectPermissions> }): Project {
    const existing = this.getProjectByPath(p.path);
    if (existing) return existing;
    const proj: Project = {
      id: randomUUID(), name: p.name, spokenName: p.spokenName || p.name, path: p.path,
      phoneEnabled: p.phoneEnabled ?? true, permissions: { ...DEFAULT_PERMISSIONS, ...(p.permissions || {}) }, createdAt: nowIso(),
    };
    this.db.prepare('INSERT INTO projects (id, name, spoken_name, path, phone_enabled, permissions_json, created_at, listed) VALUES (?,?,?,?,?,?,?,?)')
      .run(proj.id, proj.name, proj.spokenName, proj.path, proj.phoneEnabled ? 1 : 0, JSON.stringify(proj.permissions), proj.createdAt, p.listed === false ? 0 : 1);
    return this.getProject(proj.id)!;
  }

  /** עדכון פרויקט מלוח הבקרה. */
  updateProject(id: string, patch: { phoneEnabled?: boolean; spokenName?: string; editInsideProject?: boolean; listed?: boolean }): Project | null {
    const p = this.getProject(id);
    if (!p) return null;
    const perms = { ...p.permissions, ...(patch.editInsideProject !== undefined ? { editInsideProject: patch.editInsideProject } : {}) };
    this.db.prepare('UPDATE projects SET phone_enabled = ?, spoken_name = ?, permissions_json = ?, listed = ? WHERE id = ?')
      .run((patch.phoneEnabled ?? p.phoneEnabled) ? 1 : 0, patch.spokenName ?? p.spokenName, JSON.stringify(perms), (patch.listed ?? p.listed ?? true) ? 1 : 0, id);
    return this.getProject(id);
  }

  /** העברת פרויקט לתיקייה אחרת: הנתיב הקודם נשמר, כדי ששיחות ישנות (שנרשמו עם הנתיב הקודם) יישארו משויכות. */
  moveProject(id: string, newPath: string): Project | null {
    const p = this.getProject(id);
    if (!p) return null;
    const former = [...new Set([...(p.formerPaths ?? []), p.path])].filter(x => x !== newPath);
    this.db.prepare('UPDATE projects SET path = ?, former_paths = ? WHERE id = ?').run(newPath, JSON.stringify(former), id);
    return this.getProject(id);
  }

  /** הפעלה או כיבוי של פרויקט בטלפון (בלי למחוק את ההיסטוריה שלו). */
  setProjectPhoneEnabled(path: string, enabled: boolean): void {
    this.db.prepare('UPDATE projects SET phone_enabled = ? WHERE path = ?').run(enabled ? 1 : 0, path);
  }

  // ---------- שיחות ----------

  listConversations(limit = 50): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY last_active_at DESC LIMIT ?').all(limit) as any[];
    return rows.map(rowToConversation);
  }

  getConversation(id: string): Conversation | null {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    return r ? rowToConversation(r) : null;
  }

  upsertConversation(c: { id: string; projectId: string; title: string; source: TaskSource }): Conversation {
    const t = nowIso();
    this.db.prepare(`INSERT INTO conversations (id, project_id, title, source, created_at, last_active_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at`).run(c.id, c.projectId, c.title, c.source, t, t);
    return this.getConversation(c.id)!;
  }

  // ---------- נעילות ----------

  /** נעילה לשיחה. מחזיר false אם כבר נעולה למשימה אחרת. */
  lockConversation(conversationId: string, taskId: string): boolean {
    try {
      this.db.prepare('INSERT INTO conversation_locks (conversation_id, task_id, locked_at) VALUES (?,?,?)').run(conversationId, taskId, nowIso());
      return true;
    } catch {
      const r = this.db.prepare('SELECT task_id FROM conversation_locks WHERE conversation_id = ?').get(conversationId) as any;
      return r?.task_id === taskId;
    }
  }

  unlockConversation(conversationId: string, taskId: string): void {
    this.db.prepare('DELETE FROM conversation_locks WHERE conversation_id = ? AND task_id = ?').run(conversationId, taskId);
  }

  conversationLockedBy(conversationId: string): string | null {
    const r = this.db.prepare('SELECT task_id FROM conversation_locks WHERE conversation_id = ?').get(conversationId) as any;
    return r ? r.task_id : null;
  }

  clearAllLocks(): void { this.db.exec('DELETE FROM conversation_locks'); }

  // ---------- אירועי טלפון: מניעת כפילויות ויומן ----------

  /** אם האירוע כבר נענה, מחזיר את התשובה הקודמת. */
  getPhoneEventResponse(eventId: string): string | null {
    const r = this.db.prepare('SELECT response FROM phone_events WHERE event_id = ?').get(eventId) as any;
    return r ? r.response : null;
  }

  savePhoneEvent(eventId: string, callId: string, response: string): void {
    this.db.prepare('INSERT OR REPLACE INTO phone_events (event_id, call_id, received_at, response) VALUES (?,?,?,?)').run(eventId, callId, nowIso(), response);
  }

  phoneLog(e: { callId: string; phone: string; kind: string; detail?: string | null }): void {
    this.db.prepare('INSERT INTO phone_log (call_id, phone, at, kind, detail) VALUES (?,?,?,?,?)').run(e.callId, e.phone, nowIso(), e.kind, e.detail ?? null);
  }

  recentPhoneLog(limit = 50): PhoneLogEntry[] {
    const rows = this.db.prepare('SELECT call_id, phone, at, kind, detail FROM phone_log ORDER BY id DESC LIMIT ?').all(limit) as any[];
    return rows.map(r => ({ callId: r.call_id, phone: r.phone, at: r.at, kind: r.kind, detail: r.detail }));
  }

  // ---------- בקשות הרשאה (בשלב 1 נרשמות ומוחלטות לפי מדיניות) ----------

  addPermissionRequest(p: Omit<PermissionRequest, 'id' | 'createdAt'> & { id?: string }): PermissionRequest {
    const req: PermissionRequest = { ...p, id: p.id || randomUUID(), createdAt: nowIso() };
    this.db.prepare(`INSERT INTO permission_requests (id, task_id, project_id, tool_name, input_json, summary, created_at, expires_at, decision, decided_at, decided_via, explanation)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.id, req.taskId, req.projectId, req.toolName, JSON.stringify(req.input), req.summary, req.createdAt, req.expiresAt,
      req.decision, req.decidedAt, req.decidedVia, req.explanation);
    return req;
  }

  /**
   * החלטה אטומית (אפיון 5): ההחלטה הראשונה שנשמרת קובעת. מצליח רק אם הבקשה עדיין פתוחה ולא פג תוקפה.
   * decision: allow | deny | answer (תשובה לשאלה) | expired | cancelled.
   */
  decidePermission(id: string, decision: 'allow' | 'deny' | 'answer' | 'expired' | 'cancelled', via: string, explanation: string | null = null, now = nowIso()): 'ok' | 'already' | 'expired' | 'missing' {
    const expiredCheck = decision === 'expired' || decision === 'cancelled' ? '' : ' AND expires_at > ?';
    const args: any[] = [decision, now, via, explanation, id];
    if (expiredCheck) args.push(now);
    const r = this.db.prepare(`UPDATE permission_requests SET decision = ?, decided_at = ?, decided_via = ?, explanation = ? WHERE id = ? AND decision IS NULL${expiredCheck}`).run(...args);
    if (Number(r.changes) === 1) return 'ok';
    const row = this.db.prepare('SELECT decision, expires_at FROM permission_requests WHERE id = ?').get(id) as any;
    if (!row) return 'missing';
    if (row.decision) return 'already';
    return 'expired';
  }

  getPermissionRequest(id: string): PermissionRequest | null {
    return this.listPermissionRequestsWhere('id = ?', [id])[0] ?? null;
  }

  /** בקשות פתוחות (לא הוחלטו ולא פג תוקפן), הישנה ראשונה. */
  pendingPermissionRequests(now = nowIso()): PermissionRequest[] {
    return this.listPermissionRequestsWhere('decision IS NULL AND expires_at > ? ORDER BY created_at', [now]);
  }

  /** אחרי אתחול: בקשות פתוחות נסגרות. התהליך שחיכה להן כבר לא קיים. */
  closeAllPending(): number {
    const r = this.db.prepare("UPDATE permission_requests SET decision = 'cancelled', decided_at = ?, decided_via = 'system', explanation = 'הסוכן אותחל' WHERE decision IS NULL").run(nowIso());
    return Number(r.changes);
  }

  private listPermissionRequestsWhere(where: string, args: any[]): PermissionRequest[] {
    const rows = this.db.prepare(`SELECT * FROM permission_requests WHERE ${where}`).all(...args) as any[];
    return rows.map(rowToPermission);
  }

  // ---------- התראות: לכל היותר התראה אחת לכל אירוע ----------

  /** רושם התראה. מחזיר false אם כבר נרשמה התראה לאותו אירוע. */
  addNotification(kind: string, refId: string, state: string, deferredUntil: string | null = null): boolean {
    try {
      this.db.prepare('INSERT INTO notifications (id, event_kind, ref_id, state, attempts, created_at, deferred_until) VALUES (?,?,?,?,0,?,?)')
        .run(`${kind}:${refId}`, kind, refId, state, nowIso(), deferredUntil);
      return true;
    } catch { return false; }
  }

  setNotificationState(kind: string, refId: string, state: string, opts: { attempt?: boolean; sent?: boolean } = {}): void {
    this.db.prepare(`UPDATE notifications SET state = ?${opts.attempt ? ', attempts = attempts + 1' : ''}${opts.sent ? ', sent_at = ?' : ''} WHERE id = ?`)
      .run(...([state, ...(opts.sent ? [nowIso()] : []), `${kind}:${refId}`] as any[]));
  }

  notificationsInState(state: string): { kind: string; refId: string; attempts: number }[] {
    return (this.db.prepare('SELECT event_kind, ref_id, attempts FROM notifications WHERE state = ? ORDER BY created_at').all(state) as any[])
      .map(r => ({ kind: r.event_kind, refId: r.ref_id, attempts: r.attempts }));
  }

  listPermissionRequests(taskId?: string): PermissionRequest[] {
    const rows = (taskId
      ? this.db.prepare('SELECT * FROM permission_requests WHERE task_id = ? ORDER BY created_at').all(taskId)
      : this.db.prepare('SELECT * FROM permission_requests ORDER BY created_at DESC LIMIT 100').all()) as any[];
    return rows.map(rowToPermission);
  }
}

function rowToPermission(r: any): PermissionRequest {
  return {
    id: r.id, taskId: r.task_id, projectId: r.project_id, toolName: r.tool_name, input: JSON.parse(r.input_json), summary: r.summary,
    createdAt: r.created_at, expiresAt: r.expires_at, decision: r.decision, decidedAt: r.decided_at, decidedVia: r.decided_via, explanation: r.explanation,
  };
}

function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, spokenName: r.spoken_name, path: r.path, phoneEnabled: !!r.phone_enabled,
    permissions: { ...DEFAULT_PERMISSIONS, ...safeJson(r.permissions_json) }, createdAt: r.created_at,
    ...(r.former_paths ? { formerPaths: (safeJson(r.former_paths) as unknown as string[]) ?? [] } : {}),
    listed: r.listed === undefined || r.listed === null ? true : !!r.listed,
  };
}

function rowToConversation(r: any): Conversation {
  return { id: r.id, projectId: r.project_id, title: r.title, source: r.source, createdAt: r.created_at, lastActiveAt: r.last_active_at };
}

function safeJson(s: string): any { try { return JSON.parse(s || '{}'); } catch { return {}; } }
