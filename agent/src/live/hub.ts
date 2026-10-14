// שלב 5: סשן חי. Claude Code שפתוח בטרמינל עם ערוץ claudephone (Channels, research preview) נרשם כאן,
// מקבל הודעות מהטלפון לתוך השיחה הפתוחה, ומחזיר תשובה בכלי phone_reply. בקשות הרשאה של הסשן מועברות לטלפון
// רק בזמן שהודעה מהטלפון בטיפול (אחרת המשתמש ליד המסך וחלון האישור בטרמינל מספיק).
// התקשורת: שרת הערוץ (תהליך-בן של Claude Code) פונה ל-127.0.0.1 עם אסימון מקומי שנקרא מקובץ.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { log } from '../log.ts';

export interface LiveSessionInfo { id: string; cwd: string; name: string; pid: number | null; since: string; lastSeen: number; busy: boolean }

type LiveEvent =
  | { type: 'message'; chat_id: string; text: string }
  | { type: 'permission'; request_id: string; behavior: 'allow' | 'deny' };

export interface LivePermissionRequest { request_id: string; tool_name: string; description: string; input_preview: string }

interface Session {
  id: string; cwd: string; pid: number | null; since: string; lastSeen: number;
  queue: LiveEvent[];
  poller: ((events: LiveEvent[]) => void) | null;
  /** הודעות מהטלפון שמחכות לתשובה: chat_id -> מחכה */
  waiting: Map<string, { resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; onPermission: (r: LivePermissionRequest) => Promise<'allow' | 'deny'> }>;
}

export interface LiveHubOptions {
  /** כמה זמן בלי פנייה מהערוץ עד שהסשן נחשב סגור. */
  staleMs?: number;
  /** כמה זמן מחכים לתשובה מ-Claude על הודעה מהטלפון. */
  replyTimeoutMs?: number;
  pollMs?: number;
}

export class LiveHub {
  private sessions = new Map<string, Session>();
  private staleMs: number; private replyTimeoutMs: number; private pollMs: number;

  constructor(o: LiveHubOptions = {}) {
    this.staleMs = o.staleMs ?? 45_000;
    this.replyTimeoutMs = o.replyTimeoutMs ?? 30 * 60_000;
    this.pollMs = o.pollMs ?? 25_000;
  }

  register(cwd: string, pid: number | null): string {
    const id = randomUUID().slice(0, 8);
    this.sessions.set(id, { id, cwd, pid, since: new Date().toISOString(), lastSeen: Date.now(), queue: [], poller: null, waiting: new Map() });
    log('live', `סשן חי נרשם: ${basename(cwd)} (${id})`);
    return id;
  }

  /** סשנים פתוחים כרגע (פנו בזמן האחרון). */
  list(): LiveSessionInfo[] {
    const now = Date.now();
    for (const s of this.sessions.values()) if (now - s.lastSeen > this.staleMs) this.close(s.id, 'לא פנה זמן רב');
    return [...this.sessions.values()].map(s => ({ id: s.id, cwd: s.cwd, name: basename(s.cwd) || s.cwd, pid: s.pid, since: s.since, lastSeen: s.lastSeen, busy: s.waiting.size > 0 }));
  }

  get(id: string): LiveSessionInfo | null { return this.list().find(s => s.id === id) ?? null; }

  /** פנייה ארוכה מהערוץ: מחזירה אירועים שממתינים, או מחכה עד שיגיעו (או עד שנגמר הזמן). */
  poll(id: string): Promise<LiveEvent[] | null> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(null);
    s.lastSeen = Date.now();
    if (s.queue.length) { const ev = s.queue.splice(0); return Promise.resolve(ev); }
    return new Promise(res => {
      const timer = setTimeout(() => { if (s.poller === done) s.poller = null; s.lastSeen = Date.now(); res([]); }, this.pollMs);
      const done = (ev: LiveEvent[]) => { clearTimeout(timer); s.lastSeen = Date.now(); res(ev); };
      if (s.poller) s.poller([]);   // פנייה כפולה: הקודמת נסגרת ריקה
      s.poller = done;
    });
  }

  private push(s: Session, ev: LiveEvent): void {
    if (s.poller) { const p = s.poller; s.poller = null; p([ev]); }
    else s.queue.push(ev);
  }

  /** שולח הודעה מהטלפון לסשן ומחכה לתשובה של Claude. */
  send(id: string, chatId: string, text: string, onPermission: (r: LivePermissionRequest) => Promise<'allow' | 'deny'>): Promise<string> {
    const s = this.sessions.get(id);
    if (!s) return Promise.reject(new Error('השיחה הפתוחה במחשב נסגרה'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { s.waiting.delete(chatId); reject(new Error('Claude לא ענה בזמן')); }, this.replyTimeoutMs);
      s.waiting.set(chatId, { resolve, reject, timer, onPermission });
      this.push(s, { type: 'message', chat_id: chatId, text });
      log('live', `הודעה מהטלפון נשלחה לסשן ${id}`);
    });
  }

  /** ביטול המתנה (עצירה מהטלפון או מהלוח). Claude ממשיך בסשן, אבל התשובה לא תוקרא. */
  cancel(id: string, chatId: string): void {
    const s = this.sessions.get(id);
    const w = s?.waiting.get(chatId);
    if (w) { clearTimeout(w.timer); s!.waiting.delete(chatId); w.reject(new Error('בוטל')); }
  }

  /** התשובה מ-Claude (כלי phone_reply). בלי chat_id מוכר: לתשובה האחרונה שממתינה. */
  reply(id: string, chatId: string | null, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.lastSeen = Date.now();
    const key = chatId && s.waiting.has(chatId) ? chatId : [...s.waiting.keys()].pop();
    if (!key) return false;
    const w = s.waiting.get(key)!;
    clearTimeout(w.timer); s.waiting.delete(key);
    w.resolve(text);
    return true;
  }

  /** בקשת הרשאה מהסשן. מועברת לטלפון רק אם יש הודעה מהטלפון בטיפול. */
  permission(id: string, req: LivePermissionRequest): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.lastSeen = Date.now();
    const w = [...s.waiting.values()].pop();
    if (!w) return false;
    w.onPermission(req).then(behavior => {
      if (this.sessions.get(id) === s) this.push(s, { type: 'permission', request_id: req.request_id, behavior });
    }).catch(() => { /* לא הוכרע (פג/בוטל): חלון האישור בטרמינל נשאר */ });
    return true;
  }

  close(id: string, why = 'נסגר'): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (s.poller) s.poller([]);
    for (const w of s.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('השיחה הפתוחה במחשב נסגרה')); }
    log('live', `סשן חי ${id} ${why}`);
  }
}
