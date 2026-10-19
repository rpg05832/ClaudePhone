// מנוע הביצוע: משימה אחת בכל המחשב (החלטה בתוכנית), השאר בתור. נעילה לכל שיחה.
import type { Task } from '@claude-phone/shared';
import type { Store } from '../store/db.ts';
import type { Tasks } from '../store/tasks.ts';
import { runClaude, splitSummary, type QueryFn } from './runner.ts';
import { conversationTitle } from '../phone/flow.ts';
import type { PermissionBroker } from './broker.ts';
import { log, logError } from '../log.ts';

export interface WorkerDeps {
  store: Store; tasks: Tasks; query: QueryFn;
  maxTurns: number; model?: string; permissionMinutes: number;
  onChange?: (task: Task) => void;
  broker: PermissionBroker;
  /** משימה הסתיימה (או נכשלה): להתראה. */
  onFinished?: (task: Task) => void;
  /** שיחת Cowork שאפשר להמשיך (שלב 3ג): פרטי ההרצה, או null לשיחה רגילה. */
  /** סשן חי (שלב 5): משימה עם conversationId שמתחיל ב-live: נשלחת לשיחה הפתוחה במחשב במקום להריץ Claude כאן. */
  live?: {
    send: (sessionId: string, chatId: string, text: string, onPermission: (r: { request_id: string; tool_name: string; description: string; input_preview: string }) => Promise<'allow' | 'deny'>) => Promise<string>;
    cancel: (sessionId: string, chatId: string) => void;
  };
  coworkRun?: (conversationId: string) => { session: { cwd: string; folders: string[] }; link: () => () => void; active: boolean; done: () => void } | null;
  /** חיבורי MCP שפתוחים למשימות מהטלפון (נקרא בתחילת כל משימה, כדי ששינוי בלוח יחול מיד). */
  mcp?: () => { enabled: string[]; labels?: Record<string, string>; known?: string[] } | undefined;
}

export class Worker {
  private current: { taskId: string; abort: AbortController } | null = null;
  private kicking = false;

  constructor(private d: WorkerDeps) {}

  get busyWith(): string | null { return this.current?.taskId ?? null; }

  /** בודק את התור ומריץ את הבאה אם אין משימה רצה. בטוח לקריאה חוזרת. */
  kick(): void {
    if (this.current || this.kicking) return;
    this.kicking = true;
    queueMicrotask(() => {
      this.kicking = false;
      const next = this.d.tasks.nextQueued();
      if (next) void this.run(next);
    });
  }

  private liveRunning = new Map<string, { sessionId: string; abort: AbortController }>();

  requestStop(taskId: string, actor: string): void {
    const t = this.d.tasks.get(taskId);
    if (!t) return;
    const lr = this.liveRunning.get(taskId);
    if (lr && ['running', 'awaiting_permission', 'awaiting_answer'].includes(t.state)) {
      this.emit(this.d.tasks.transition(taskId, 'stop_requested', actor, 'התבקשה עצירה'));
      lr.abort.abort();
      this.d.live?.cancel(lr.sessionId, taskId);
      return;
    }
    if (t.state === 'queued') { this.emit(this.d.tasks.transition(taskId, 'cancelled', actor, 'בוטלה לפני שהתחילה')); return; }
    if (['running', 'awaiting_permission', 'awaiting_answer'].includes(t.state) && this.current?.taskId === taskId) {
      this.emit(this.d.tasks.transition(taskId, 'stop_requested', actor, 'התבקשה עצירה'));
      this.current.abort.abort();
    }
  }

  private emit(t: Task): void { try { this.d.onChange?.(t); } catch { /* לוח הבקרה לא זמין */ } }

  private async runLive(task: Task): Promise<void> {
    const sessionId = task.conversationId!.slice('live:'.length);
    const project = this.d.store.getProject(task.projectId);
    if (!this.d.live || !project) {
      this.emit(this.d.tasks.transition(task.id, 'needs_review', 'system', 'סשן חי לא זמין'));
      return;
    }
    const abort = new AbortController();
    this.liveRunning.set(task.id, { sessionId, abort });
    this.emit(this.d.tasks.transition(task.id, 'running', 'worker', 'נשלחה לשיחה הפתוחה במחשב'));
    log('worker', `משימה ${task.num} נשלחה לסשן החי ${sessionId}`);
    const prompt = this.d.store.getSettings().editMode === 'readonly' ? `[מצב קריאה בלבד: אל תשנה קבצים]\n${task.prompt}` : task.prompt;
    try {
      const text = await this.d.live.send(sessionId, task.id, prompt, async (r) => {
        const res = await this.d.broker.request(this.d.tasks.get(task.id)!, project, r.tool_name, { input_preview: r.input_preview }, liveSummary(r), abort.signal);
        return res.kind === 'allow' ? 'allow' : 'deny';
      });
      const now = this.d.tasks.get(task.id)!;
      if (now.state === 'stop_requested') this.emit(this.d.tasks.transition(task.id, 'cancelled', 'worker', 'נעצרה לבקשת המשתמש'));
      else {
        const { summary } = splitSummary(text);
        this.emit(this.d.tasks.transition(task.id, 'done', 'worker', 'התקבלה תשובה מהשיחה הפתוחה', { resultText: text, resultSummary: summary }));
      }
    } catch (e) {
      const now = this.d.tasks.get(task.id)!;
      if (now.state === 'stop_requested') this.emit(this.d.tasks.transition(task.id, 'cancelled', 'worker', 'נעצרה לבקשת המשתמש', { error: 'ההמתנה לתשובה בוטלה. Claude אולי עדיין עובד בשיחה הפתוחה במחשב' }));
      else this.emit(this.d.tasks.transition(task.id, 'failed', 'worker', 'הסשן החי לא החזיר תשובה', { error: shortError(e instanceof Error ? e.message : String(e)) }));
    } finally {
      this.liveRunning.delete(task.id);
      const final = this.d.tasks.get(task.id);
      if (final && (final.state === 'done' || final.state === 'failed')) { try { this.d.onFinished?.(final); } catch (e) { logError('worker', e, 'onFinished'); } }
    }
  }

  private async run(task: Task): Promise<void> {
    if (task.conversationId?.startsWith('live:')) {
      // לא תופס את המנוע: Claude רץ בסשן הפתוח במחשב, כאן רק מעבירים ומחכים
      void this.runLive(task);
      return this.kick();
    }
    const project = this.d.store.getProject(task.projectId);
    if (!project) { this.emit(this.d.tasks.transition(task.id, 'needs_review', 'system', 'הפרויקט לא נמצא')); return this.kick(); }

    if (task.conversationId && !this.d.store.lockConversation(task.conversationId, task.id)) {
      // השיחה תפוסה (לא אמור לקרות כשרצה משימה אחת בכל פעם): נשארת בתור
      log('worker', `השיחה של משימה ${task.num} נעולה; ממתינה`);
      setTimeout(() => this.kick(), 5000);
      return;
    }

    // המשך שיחת Cowork: רץ בתיקייה של השיחה, עם קישור זמני לתמליל של Desktop
    const cw = task.conversationId ? this.d.coworkRun?.(task.conversationId) ?? null : null;
    let unlink: (() => void) | null = null;
    if (cw) {
      if (cw.active) {
        this.d.store.unlockConversation(task.conversationId!, task.id);
        this.d.tasks.transition(task.id, 'running', 'worker', 'בדיקת שיחת Cowork');
        this.emit(this.d.tasks.transition(task.id, 'failed', 'worker', 'השיחה פתוחה ב-Desktop', { error: 'השיחה פתוחה כרגע ב-Desktop. סגור אותה שם או נסה שוב בעוד כמה דקות' }));
        this.d.onFinished?.(this.d.tasks.get(task.id)!);
        return this.kick();
      }
      try { unlink = cw.link(); }
      catch (e) {
        this.d.store.unlockConversation(task.conversationId!, task.id);
        this.d.tasks.transition(task.id, 'running', 'worker', 'בדיקת שיחת Cowork');
        this.emit(this.d.tasks.transition(task.id, 'failed', 'worker', 'הכנת שיחת Cowork נכשלה', { error: shortError(e instanceof Error ? e.message : String(e)) }));
        this.d.onFinished?.(this.d.tasks.get(task.id)!);
        return this.kick();
      }
    }

    const abort = new AbortController();
    this.current = { taskId: task.id, abort };
    let lockedConv = task.conversationId;
    this.emit(this.d.tasks.transition(task.id, 'running', 'worker', 'התחילה'));
    log('worker', `משימה ${task.num} התחילה בפרויקט ${project.name}${cw ? ' (המשך שיחת Cowork)' : task.conversationId ? ' (המשך שיחה)' : ' (שיחה חדשה)'}`);

    try {
      const res = await runClaude(this.d.query, {
        project, prompt: task.prompt, resumeId: task.conversationId, maxTurns: this.d.maxTurns, model: modelFor(task, this.d.store.getSettings().model, this.d.model), effort: effortFor(this.d.store.getSettings().effort), abort,
        editMode: this.d.store.getSettings().editMode,
        mcp: this.d.mcp?.(),
        ...(cw ? {
          cwd: cw.session.cwd,
          additionalDirectories: [project.path, ...cw.session.folders.filter(f => f.toLowerCase() !== project.path.toLowerCase())],
          editRoots: [project.path, cw.session.cwd],
        } : {}),
        onSession: (sid) => {
          if (cw) return;   // שיחת Cowork נשארת של Desktop: לא נרשמת במאגר כשיחה שלנו
          if (!lockedConv) {
            this.d.store.upsertConversation({ id: sid, projectId: project.id, title: conversationTitle(task.prompt), source: task.source });
            this.d.store.lockConversation(sid, task.id);
            lockedConv = sid;
            this.d.tasks.patch(task.id, { conversationId: sid });
          } else {
            this.d.store.upsertConversation({ id: sid, projectId: project.id, title: conversationTitle(task.prompt), source: task.source });
          }
        },
        onPermission: (p) => {
          const at = new Date();
          this.d.store.addPermissionRequest({
            taskId: task.id, projectId: project.id, toolName: p.toolName, input: p.input, summary: p.summary,
            expiresAt: new Date(at.getTime() + this.d.permissionMinutes * 60_000).toISOString(),
            decision: p.allowed ? 'allow' : 'deny', decidedAt: at.toISOString(), decidedVia: 'policy', explanation: p.reason,
          });
        },
        askUser: (p) => this.d.broker.request(this.d.tasks.get(task.id)!, project, p.toolName, p.input, p.summary, p.signal),
      });
      const now = this.d.tasks.get(task.id)!;
      if (now.state === 'stop_requested') {
        this.emit(this.d.tasks.transition(task.id, 'cancelled', 'worker', 'נעצרה לבקשת המשתמש', { resultText: res.text || null, error: 'נעצרה לבקשתך. שינויים שכבר בוצעו נשארים' }));
      } else if (res.isError) {
        this.emit(this.d.tasks.transition(task.id, 'failed', 'worker', 'Claude החזיר שגיאה', { resultText: res.text || null, error: shortError(res.errorText) }));
      } else {
        const { summary } = splitSummary(res.text);
        this.emit(this.d.tasks.transition(task.id, 'done', 'worker', `הסתיימה (${res.turns} סבבים)`, { resultText: res.text, resultSummary: summary }));
      }
      log('worker', `משימה ${task.num} הסתיימה: ${this.d.tasks.get(task.id)!.state}`);
    } catch (e) {
      const now = this.d.tasks.get(task.id)!;
      if (now.state === 'stop_requested') {
        this.emit(this.d.tasks.transition(task.id, 'cancelled', 'worker', 'נעצרה לבקשת המשתמש', { error: 'נעצרה לבקשתך. שינויים שכבר בוצעו נשארים' }));
      } else {
        logError('worker', e, `משימה ${task.num}`);
        this.emit(this.d.tasks.transition(task.id, 'failed', 'worker', 'שגיאה בהרצה', { error: shortError(e instanceof Error ? e.message : String(e)) }));
      }
    } finally {
      if (lockedConv) this.d.store.unlockConversation(lockedConv, task.id);
      if (unlink) { try { unlink(); cw!.done(); } catch (e) { logError('worker', e, 'cowork unlink'); } }
      this.current = null;
      const final = this.d.tasks.get(task.id);
      if (final && (final.state === 'done' || final.state === 'failed')) { try { this.d.onFinished?.(final); } catch (e) { logError('worker', e, 'onFinished'); } }
      this.kick();
    }
  }
}

/** המודל למשימה: מה שנבחר לבקשה הזו, אחרת ההגדרה הכללית, אחרת config (ובלי: ברירת המחדל של החשבון). */
export function modelFor(task: Task, setting: string, cfgModel?: string): string | undefined {
  if (task.model && task.model !== 'default') return task.model;
  if (setting && setting !== 'default') return setting;
  return cfgModel || undefined;
}

export function effortFor(setting: string): string | undefined { return setting && setting !== 'default' ? setting : undefined; }

export function liveSummary(r: { tool_name: string; description: string; input_preview: string }): string {
  let preview = '';
  try { const o = JSON.parse(r.input_preview); preview = String(o.command ?? o.file_path ?? o.url ?? ''); } catch { preview = r.input_preview; }
  preview = preview.slice(0, 300);
  return `${r.description || r.tool_name}${preview ? `. הפקודה: ${preview}` : ''}`;
}

export function shortError(s?: string): string {
  const t = String(s ?? 'שגיאה לא ידועה');
  if (/auth|401|login|oauth/i.test(t)) return 'החיבור של Claude במחשב פג. יש להתחבר מחדש במחשב';
  // מכסת השימוש נגמרה: הודעה ברורה, ואם Claude ציין מתי היא מתחדשת, זה נשמר (למשל "resets 3pm")
  if (/usage limit|hit your limit|limit reached|rate.?limit|quota|\b429\b/i.test(t)) {
    const when = t.match(/resets?\s*(?:at\s*)?([^\n.|·]{1,30})/i)?.[1]?.trim();
    return `הגעת למכסת השימוש של Claude. המשימה לא בוצעה. אפשר לנסות שוב אחרי שהמכסה מתחדשת${when ? `, בשעה ${when}` : ''}`;
  }
  return t.slice(0, 200);
}
