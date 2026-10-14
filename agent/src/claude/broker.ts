// מתווך ההרשאות והשאלות (אפיון 5): כל בקשה נרשמת עם מזהה ותוקף, וההחלטה הראשונה שנשמרת קובעת.
// הסוכן (worker) מחכה כאן; הטלפון (ובשלב 4 לוח הבקרה) מחליטים דרך decide().
import type { Task, Project, PermissionRequest } from '@claude-phone/shared';
import type { Store } from '../store/db.ts';
import type { Tasks } from '../store/tasks.ts';
import type { AskResult } from './runner.ts';
import { QUESTION_TOOL } from './policy.ts';
import { log } from '../log.ts';

export type DecideResult = 'ok' | 'already' | 'expired' | 'missing';

export interface BrokerDeps {
  store: Store; tasks: Tasks;
  minutes: number;
  /** אירוע חדש לטלפון (צינתוק). */
  onEvent: (kind: 'permission' | 'question', requestId: string, phone: string | null) => void;
  onTaskChange?: (t: Task) => void;
}

interface Waiter { resolve: (r: AskResult) => void; timer: NodeJS.Timeout; request: PermissionRequest; }

export class PermissionBroker {
  private waiters = new Map<string, Waiter>();

  constructor(private d: BrokerDeps) {}

  /** בקשה חדשה מהמשתמש. מחזיר כשהתקבלה החלטה, כשפג התוקף, או כשהמשימה נעצרה. */
  request(task: Task, project: Project, toolName: string, input: Record<string, unknown>, summary: string, signal: AbortSignal): Promise<AskResult> {
    const isQuestion = toolName === QUESTION_TOOL;
    const req = this.d.store.addPermissionRequest({
      taskId: task.id, projectId: project.id, toolName, input, summary,
      expiresAt: new Date(Date.now() + this.d.minutes * 60_000).toISOString(),
      decision: null, decidedAt: null, decidedVia: null, explanation: null,
    });
    this.setTaskState(task.id, isQuestion ? 'awaiting_answer' : 'awaiting_permission', isQuestion ? 'Claude שאל שאלה' : 'Claude ביקש אישור');
    log('broker', `בקשה ${req.id.slice(0, 8)} (${isQuestion ? 'שאלה' : toolName}) ממתינה`);

    return new Promise<AskResult>(resolve => {
      const finish = (r: AskResult) => {
        const w = this.waiters.get(req.id);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiters.delete(req.id);
        // אם Claude ביקש כמה דברים במקביל, המשימה חוזרת לריצה רק כשכולם הוחלטו
        if (![...this.waiters.values()].some(x => x.request.taskId === task.id)) this.setTaskState(task.id, 'running', 'התקבלה החלטה');
        resolve(r);
      };
      const timer = setTimeout(() => {
        if (this.d.store.decidePermission(req.id, 'expired', 'system') === 'ok') {
          log('broker', `בקשה ${req.id.slice(0, 8)} פגה`);
          finish({ kind: 'deny', reason: 'לא התקבלה תשובה מהמשתמש בזמן' });
        }
      }, this.d.minutes * 60_000);
      this.waiters.set(req.id, { resolve: finish, timer, request: req });
      // this.d.onEvent אחרי הרישום, כדי שתשובה מהירה לא תפספס את הממתין
      this.d.onEvent(isQuestion ? 'question' : 'permission', req.id, task.phone);
      signal.addEventListener('abort', () => {
        this.d.store.decidePermission(req.id, 'cancelled', 'system', 'המשימה נעצרה');
        finish({ kind: 'deny', reason: 'המשימה נעצרה' });
      }, { once: true });
    });
  }

  /**
   * החלטה מהטלפון. allow/deny לבקשת הרשאה; answer לשאלה (answers: שאלה -> תשובה).
   * explanation: הסבר בהקלטה (מקש 8) שמועבר ל-Claude יחד עם הדחייה.
   */
  decide(id: string, d: { decision: 'allow' } | { decision: 'deny'; explanation?: string } | { decision: 'answer'; answers: Record<string, string> }, via: 'phone' | 'dashboard'): DecideResult {
    const text = d.decision === 'answer' ? JSON.stringify(d.answers) : d.decision === 'deny' ? (d.explanation ?? null) : null;
    const res = this.d.store.decidePermission(id, d.decision, via, text);
    if (res !== 'ok') return res;
    log('broker', `בקשה ${id.slice(0, 8)}: ${d.decision} (${via})`);
    const w = this.waiters.get(id);
    if (w) {
      if (d.decision === 'allow') w.resolve({ kind: 'allow' });
      else if (d.decision === 'answer') w.resolve({ kind: 'answer', answers: d.answers });
      else w.resolve({ kind: 'deny', reason: 'המשתמש דחה', explanation: d.explanation });
    }
    return 'ok';
  }

  pendingCount(): number { return this.d.store.pendingPermissionRequests().length; }

  private setTaskState(taskId: string, to: 'running' | 'awaiting_permission' | 'awaiting_answer', reason: string): void {
    const t = this.d.tasks.get(taskId);
    if (!t || t.state === to) return;
    if (to === 'running' && !(t.state === 'awaiting_permission' || t.state === 'awaiting_answer')) return;
    if (to !== 'running' && t.state !== 'running') return;
    // מעבר בין המתנות (שתי בקשות ברצף) עובר דרך running
    const updated = this.d.tasks.transition(taskId, to, 'broker', reason);
    this.d.onTaskChange?.(updated);
  }
}
