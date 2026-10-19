// התראות לטלפון (אפיון 6): צינתוק אחד לכל אירוע, לא בזמני שקט, ולא כשהמשתמש כבר בשיחה.
// אירועים שנדחו בזמן שקט נשלחים כצינתוק מרוכז אחד כשהשקט נגמר, ורק אם עוד לא טופלו.
import type { Store } from '../store/db.ts';
import type { Tasks } from '../store/tasks.ts';
import { quietState, type QuietConfig } from './quiet.ts';
import { log, logError } from '../log.ts';

export type EventKind = 'done' | 'failed' | 'permission' | 'question';

export interface NotifierDeps {
  store: Store; tasks: Tasks;
  quiet: QuietConfig;
  phones: () => string[];
  /** שולח צינתוק; מחזיר 'free' (רשימה חינמית) או 'paid' (מספרים ישירות), או כלום */
  tzintuk: (phones: string[]) => Promise<'free' | 'paid' | void>;
  /** האם המספר נמצא כרגע בשיחה עם המערכת (אז הוא ישמע את האירוע בשיחה). */
  inCall: (phone: string) => boolean;
  maxAttempts: number;
  now?: () => Date;
}

export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  constructor(private d: NotifierDeps) {}

  private now(): Date { return this.d.now ? this.d.now() : new Date(); }

  /** אירוע חדש. kind+refId מזהים אותו; התראה שנייה לאותו אירוע לא תישלח. */
  async event(kind: EventKind, refId: string, phone: string | null): Promise<string> {
    const targets = phone ? [phone] : this.d.phones();
    if (this.d.store.getSettings().notify === 'off') { this.d.store.addNotification(kind, refId, 'disabled'); return 'disabled'; }
    if (targets.some(p => this.d.inCall(p))) { this.d.store.addNotification(kind, refId, 'in_call'); return 'in_call'; }
    const q = quietState(this.now(), this.d.quiet);
    if (q.quiet) {
      if (this.d.store.addNotification(kind, refId, 'deferred')) log('notify', `התראה נדחתה (${q.reason}): ${kind} ${refId.slice(0, 8)}`);
      return 'deferred';
    }
    if (!this.d.store.addNotification(kind, refId, 'pending')) return 'duplicate';
    await this.send([{ kind, refId }], targets);
    return 'sent';
  }

  /** בדיקה תקופתית: שליחת התראות שנדחו כשהשקט נגמר, וניסיון חוזר להתראות שנכשלו. */
  async tick(): Promise<void> {
    if (quietState(this.now(), this.d.quiet).quiet) return;
    const due = [...this.d.store.notificationsInState('deferred'), ...this.d.store.notificationsInState('retry')]
      .filter(n => this.stillRelevant(n.kind as EventKind, n.refId));
    for (const n of this.d.store.notificationsInState('deferred')) {
      if (!due.some(x => x.kind === n.kind && x.refId === n.refId)) this.d.store.setNotificationState(n.kind, n.refId, 'dropped');
    }
    if (!due.length) return;
    if (this.d.store.getSettings().notify === 'off') { for (const n of due) this.d.store.setNotificationState(n.kind, n.refId, 'disabled'); return; }
    if (this.d.phones().some(p => this.d.inCall(p))) return;   // ינסה שוב בבדיקה הבאה
    await this.send(due, this.d.phones());
  }

  /** אירוע שכבר טופל (בקשה שהוחלטה, תוצאה שנשמעה) לא מצדיק צינתוק מאוחר. */
  private stillRelevant(kind: EventKind, refId: string): boolean {
    if (kind === 'permission' || kind === 'question') {
      const r = this.d.store.getPermissionRequest(refId);
      return !!r && r.decision === null && Date.parse(r.expiresAt) > this.now().getTime();
    }
    const t = this.d.tasks.get(refId);
    return !!t && !t.heard;
  }

  private async send(items: { kind: string; refId: string }[], phones: string[]): Promise<void> {
    if (!phones.length) return;
    try {
      const how = await this.d.tzintuk(phones);
      for (const n of items) this.d.store.setNotificationState(n.kind, n.refId, 'sent', { attempt: true, sent: true });
      log('notify', `צינתוק נשלח (${items.map(n => n.kind).join(', ')})${how === 'free' ? ' דרך הרשימה החינמית' : how === 'paid' ? ' למספר, 0.1 יחידה' : ''}`);
    } catch (e) {
      logError('notify', e, 'צינתוק');
      for (const n of items) {
        const row = this.d.store.notificationsInState('pending').concat(this.d.store.notificationsInState('retry'), this.d.store.notificationsInState('deferred'))
          .find(x => x.kind === n.kind && x.refId === n.refId);
        const attempts = (row?.attempts ?? 0) + 1;
        this.d.store.setNotificationState(n.kind, n.refId, attempts >= this.d.maxAttempts ? 'failed' : 'retry', { attempt: true });
      }
    }
  }

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => { this.tick().catch(e => logError('notify', e, 'tick')); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}
