// צינתוקים חינמיים (גרסה 0.7.5, לפי הצעה בפורום). לפי התיעוד של ימות (f2.freeivr.co.il/post/64941): צינתוק למספר מפורש
// ב-RunTzintuk עולה 0.1 יחידה למספר, וצינתוק ל"רשימת צינתוקים חינמיים" (phones=tzl:<שם>) הוא ללא עלות.
//
// רשימה כזו היא שלוחה מסוג tzintuk (f2.freeivr.co.il/post/121). אי אפשר להוסיף אליה מספרים דרך האתר או ה-API: מי שרוצה
// להיות בה מתקשר לשלוחה ממספר מזוהה ומקיש 1. התוכנה יוצרת את השלוחה כתת-שלוחה של שלוחת ה-API (למשל 9/1), ומהטלפון
// מגיעים אליה דרך תפריט ההגדרות (7 ואז 9).
//
// לפני כל צינתוק: אם כל הטלפונים שצריכים לצלצל רשומים ברשימה, וברשימה אין מספר שאינו ברשימת המורשים, הצינתוק יוצא
// לרשימה (חינם). אחרת, למספרים ישירות (בתשלום). צינתוק לרשימה מצלצל לכל הרשומים בה.
import { normalizePhone } from '../setup/routes.ts';

export interface FreeTzintukDeps {
  listName: string;
  /** המספרים הרשומים ברשימה (TzintukimListManagement getlistEnteres) */
  entries: () => Promise<string[]>;
  allowed: () => string[];
  cacheMs?: number;
  now?: () => number;
}

export interface FreeTzintukCheck {
  ok: boolean;
  /** הרשומים (מנורמלים) */
  members: string[];
  /** טלפונים שצריכים לצלצל ואינם רשומים */
  missing: string[];
  /** רשומים שאינם ברשימת המורשים (אז הרשימה לא בשימוש, כדי לא לצנתק לזרים) */
  foreign: string[];
  checkedAt: number | null;
  error: string | null;
}

export class FreeTzintuk {
  private cache: { at: number; members: string[] } | null = null;
  private lastError: string | null = null;
  private refreshing: Promise<string[]> | null = null;
  constructor(private d: FreeTzintukDeps) {}

  get listName(): string { return this.d.listName; }
  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  /** הרישום שלנו: המספרים כפי שהתוכנה משווה אותם (0501234567). */
  async members(force = false): Promise<string[]> {
    const ttl = this.d.cacheMs ?? 5 * 60_000;
    if (!force && this.cache && this.now() - this.cache.at < ttl) return this.cache.members;
    if (!this.refreshing) {
      this.refreshing = this.d.entries()
        .then(list => {
          const members = [...new Set(list.map(p => normalizePhone(p)).filter((p): p is string => !!p))];
          this.cache = { at: this.now(), members };
          this.lastError = null;
          return members;
        })
        .catch(e => { this.lastError = e instanceof Error ? e.message : String(e); return this.cache?.members ?? []; })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** אחרי שהמשתמש הופנה להרשמה: הבדיקה הבאה תקרא את הרשימה מחדש. */
  invalidate(): void { this.cache = null; }

  /** האם אפשר לצנתק לטלפונים האלה דרך הרשימה. */
  async check(targets: string[], force = false): Promise<FreeTzintukCheck> {
    const members = await this.members(force);
    const allowed = new Set(this.d.allowed().map(p => normalizePhone(p) ?? p));
    const want = [...new Set(targets.map(p => normalizePhone(p) ?? p))];
    const missing = want.filter(p => !members.includes(p));
    const foreign = members.filter(p => !allowed.has(p));
    return { ok: want.length > 0 && !missing.length && !foreign.length, members, missing, foreign, checkedAt: this.cache?.at ?? null, error: this.lastError };
  }

  /** מצב לתצוגה (לוח הבקרה): מתוך המטמון, בלי להמתין לרשת. רענון ברקע אם המטמון ישן. */
  status(): { listName: string; members: string[]; missing: string[]; foreign: string[]; free: boolean; checkedAt: string | null; error: string | null } {
    const ttl = this.d.cacheMs ?? 5 * 60_000;
    if (!this.cache || this.now() - this.cache.at >= ttl) void this.members(true).catch(() => {});
    const members = this.cache?.members ?? [];
    const allowed = this.d.allowed().map(p => normalizePhone(p) ?? p);
    const missing = allowed.filter(p => !members.includes(p));
    const foreign = members.filter(p => !allowed.includes(p));
    return { listName: this.d.listName, members, missing, foreign, free: members.length > 0 && !foreign.length, checkedAt: this.cache ? new Date(this.cache.at).toISOString() : null, error: this.lastError };
  }
}
