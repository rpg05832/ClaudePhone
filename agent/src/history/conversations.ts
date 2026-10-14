// רשימת השיחות המאוחדת: שיחות שהמערכת פתחה (מאגר תפעולי) + שיחות מהיסטוריית Claude (Desktop, טרמינל).
// אפיון 3/6: מוצג מקור מזוהה או "לא ידוע"; "ניתן להמשך" רק אחרי בדיקת תאימות ובעלות.
import type { Project } from '@claude-phone/shared';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Store } from '../store/db.ts';
import { ClaudeHistory, samePath, type HistorySession, type HistorySource, type HistoryMessage } from './claude-history.ts';
import type { CoworkHistory, CoworkSession } from './cowork.ts';

export type ConvSource = 'phone' | 'cowork' | HistorySource;

export interface ConversationEntry {
  id: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  source: ConvSource;
  createdAt: string | null;
  lastActiveAt: string;
  /** פעילה: נעולה למשימה שלנו, או נכתבה בדקות האחרונות (ייתכן שפתוחה ב-Desktop). */
  active: boolean;
  /** אפשר לשלוח אליה המשך מהטלפון. */
  canContinue: boolean;
  /** אם אי אפשר: למה (מוקרא בטלפון ומוצג בלוח). */
  blockedReason: string | null;
  inHistory: boolean;
  /** התיקייה שבה השיחה רצה (לשיחות מחוץ לפרויקטים). */
  folder?: string | null;
  /** במקש 8: שיחה מחוץ לפרויקטים שאפשר להמשיך. התיקייה תירשם אוטומטית כשממשיכים. */
  autoFolder?: string | null;
  /** פרויקט Cowork (לשיחות Cowork). */
  coworkProject?: string | null;
  archived?: boolean;
}

export interface ConversationIndexOptions {
  /** מקורות שאפשר להמשיך מהם (שיחות שלנו תמיד). ברירת מחדל: sdk בלבד, עד שבדיקת ההמשך של Desktop תעבור. */
  resumeSources: (HistorySource | 'cowork')[];
  activeMinutes: number;
}

export class ConversationIndex {
  constructor(private store: Store, private history: ClaudeHistory, private opts: ConversationIndexOptions, private cowork?: CoworkHistory) {}

  all(): ConversationEntry[] {
    const projects = this.store.listProjects();
    const byId = new Map<string, ConversationEntry>();
    const hist = this.history.list();
    const histById = new Map(hist.map(h => [h.id, h]));

    // Cowork קודם: המזהה שלה יכול להופיע גם במאגר (משימה מהטלפון) או ב-~/.claude/projects (קישור בזמן ריצה)
    for (const s of this.cowork?.list() ?? []) {
      const p = projects.find(x => s.folders.some(f => samePath(x.path, f)))
        ?? projects.find(x => s.folders.some(f => (x.formerPaths ?? []).some(fp => samePath(fp, f)))) ?? null;
      byId.set(s.id, this.fromCowork(s, p));
    }

    for (const c of this.store.listConversations(1000)) {
      if (byId.has(c.id)) continue;
      const p = projects.find(x => x.id === c.projectId) ?? null;
      const h = histById.get(c.id);
      const locked = !!this.store.conversationLockedBy(c.id);
      byId.set(c.id, {
        id: c.id, projectId: c.projectId, projectName: p?.spokenName ?? null, title: c.title, source: 'phone',
        createdAt: c.createdAt, lastActiveAt: maxIso(c.lastActiveAt, h?.lastActiveAt),
        active: locked, canContinue: !!p?.phoneEnabled, blockedReason: p?.phoneEnabled ? null : 'הפרויקט אינו זמין בטלפון',
        inHistory: !!h,
      });
    }
    for (const h of hist) {
      if (byId.has(h.id)) continue;
      const p = projects.find(x => samePath(x.path, h.cwd)) ?? projects.find(x => (x.formerPaths ?? []).some(fp => samePath(fp, h.cwd))) ?? null;
      byId.set(h.id, this.fromHistory(h, p));
    }
    return [...byId.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  /** לטלפון: רק שיחות של פרויקטים מורשים. */
  forPhone(): ConversationEntry[] {
    const enabled = new Set(this.store.listProjects(true).map(p => p.id));
    return this.all().filter(c => c.projectId && enabled.has(c.projectId) && !c.archived);
  }

  get(id: string): ConversationEntry | null { return this.all().find(c => c.id === id) ?? null; }

  /**
   * לטלפון, מקש 8: כל השיחות במחשב, גם מחוץ לפרויקטים. לא כולל שיחות בארכיון ושיחות של פרויקט שכובה בטלפון.
   * שיחה מחוץ לפרויקטים שאפשר להמשיך מסומנת ב-autoFolder: התיקייה שלה תירשם אוטומטית בהמשך.
   */
  allForPhone(): ConversationEntry[] {
    const disabled = new Set(this.store.listProjects().filter(p => !p.phoneEnabled).map(p => p.id));
    return this.all().filter(c => !c.archived && !(c.projectId && disabled.has(c.projectId))).map(c => this.autoFolderView(c));
  }

  /** שיחה בלי פרויקט: אפשר להמשיך אם התיקייה שלה קיימת והמקור מותר. */
  autoFolderView(c: ConversationEntry): ConversationEntry {
    if (c.projectId) return c;
    const f = c.folder;
    if (!f) return c;
    if (!existsSync(f)) return { ...c, blockedReason: 'התיקייה של השיחה כבר לא קיימת במחשב' };
    let reason: string | null = null;
    if (c.source === 'cowork') {
      const s = this.cowork?.get(c.id);
      if (!s?.hostMode) reason = 'השיחה רצה במכונה הווירטואלית של Cowork, ואפשר רק לקרוא אותה';
      else if (!s.transcript) reason = 'התמליל של השיחה לא נמצא';
      else if (!this.opts.resumeSources.includes('cowork')) reason = 'המשך שיחות Cowork כבוי בהגדרות';
      else if (c.active) reason = 'השיחה פתוחה כרגע ב-Desktop';
    } else if (!this.opts.resumeSources.includes(c.source as any)) {
      reason = c.source === 'unknown' ? 'השיחה נוצרה בכלי לא מוכר, ולכן לא ממשיכים אותה מהטלפון' : 'המשך שיחות מהמקור הזה כבוי בהגדרות';
    } else if (c.active) reason = 'השיחה פתוחה כרגע במחשב';
    return { ...c, canContinue: !reason, blockedReason: reason, autoFolder: reason ? null : f, projectName: c.projectName ?? (basename(f) || f) };
  }

  /** תוכן השיחה, מכל מקור. */
  messages(id: string, limit = 500): HistoryMessage[] {
    const cw = this.cowork?.get(id);
    return cw ? this.cowork!.messages(id, limit) : this.history.messages(id, limit);
  }

  /** זמן שינוי התמליל (למטמון החיפוש). */
  transcriptMtime(id: string): number | null {
    const cw = this.cowork?.get(id);
    if (cw) return cw.mtimeMs;
    return this.history.get(id)?.mtimeMs ?? null;
  }

  /** לשיחת Cowork שאפשר להמשיך: מה המנוע צריך כדי להריץ אותה (תיקייה, תיקיות נוספות, קישור לתמליל). */
  coworkRun(id: string): { session: CoworkSession; link: () => () => void; active: boolean; done: () => void } | null {
    const s = this.cowork?.get(id);
    if (!s || !s.hostMode || !s.transcript) return null;
    return {
      session: s, link: () => this.cowork!.linkForRun(s), active: this.coworkActive(s),
      // אחרי הרצה שלנו התמליל עודכן: זה לא סימן ש-Desktop פתוח
      done: () => { const now = this.cowork!.get(id); if (now) this.ownWrites.set(id, now.mtimeMs); },
    };
  }

  /** זמני כתיבה שלנו לתמלילי Cowork, כדי לא לחשוב שהשיחה פתוחה ב-Desktop רק כי המערכת עצמה כתבה אליה. */
  private ownWrites = new Map<string, number>();
  private coworkActive(s: CoworkSession): boolean {
    return this.cowork!.isActive(s, Date.now(), this.opts.activeMinutes) && this.ownWrites.get(s.id) !== s.mtimeMs;
  }

  private fromCowork(s: CoworkSession, p: Project | null): ConversationEntry {
    const active = this.coworkActive(s) || !!this.store.conversationLockedBy(s.id);
    let blockedReason: string | null = null;
    if (!s.hostMode) blockedReason = 'השיחה רצה במכונה הווירטואלית של Cowork, ואפשר רק לקרוא אותה';
    else if (!s.transcript) blockedReason = 'התמליל של השיחה לא נמצא';
    else if (!p) blockedReason = 'התיקייה של השיחה אינה פרויקט בטלפון';
    else if (!p.phoneEnabled) blockedReason = 'הפרויקט אינו זמין בטלפון';
    else if (!this.opts.resumeSources.includes('cowork')) blockedReason = 'המשך שיחות Cowork כבוי בהגדרות';
    else if (this.store.conversationLockedBy(s.id)) blockedReason = null;   // שלנו, רצה עכשיו: ההודעה תחכה בתור
    else if (this.coworkActive(s)) blockedReason = 'השיחה פתוחה כרגע ב-Desktop';
    return {
      id: s.id, projectId: p?.id ?? null, projectName: p?.spokenName ?? s.spaceName ?? null, title: s.title, source: 'cowork',
      createdAt: s.createdAt, lastActiveAt: s.lastActiveAt, active, canContinue: blockedReason === null, blockedReason,
      inHistory: !!s.transcript, coworkProject: s.spaceName, archived: s.archived,
      folder: s.folders.find(f => existsSync(f)) ?? s.cwd ?? null,
    };
  }

  private fromHistory(h: HistorySession, p: Project | null): ConversationEntry {
    const active = this.history.isActive(h, Date.now(), this.opts.activeMinutes) || !!this.store.conversationLockedBy(h.id);
    let blockedReason: string | null = null;
    if (!p) blockedReason = 'השיחה לא שייכת לפרויקט מורשה';
    else if (!p.phoneEnabled) blockedReason = 'הפרויקט אינו זמין בטלפון';
    else if (!this.opts.resumeSources.includes(h.source)) blockedReason = h.source === 'unknown'
      ? 'השיחה נוצרה בכלי לא מוכר, ולכן לא ממשיכים אותה מהטלפון' : 'המשך שיחות מהמקור הזה כבוי בהגדרות';
    else if (active) blockedReason = 'השיחה פתוחה כרגע במחשב';
    return {
      id: h.id, projectId: p?.id ?? null, projectName: p?.spokenName ?? null, title: h.title, source: h.source,
      createdAt: h.createdAt, lastActiveAt: h.lastActiveAt, active, canContinue: blockedReason === null, blockedReason, inHistory: true,
      folder: h.cwd ?? null,
    };
  }
}

function maxIso(a: string, b?: string): string { return b && b > a ? b : a; }
