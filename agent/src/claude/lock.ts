// נעילה תקועה של Claude Code (גרסה 0.7.7).
//
// Claude Code מגן על חידוש ההתחברות (הטוקן ב-~/.claude/.credentials.json) בנעילה: תיקייה ~/.claude.lock שנוצרת לרגע
// ונמחקת. אם משהו שם קובץ בתוכה (נמצא אצל משתמש: קובץ .nomedia מתוכנת גיבוי או סנכרון), המחיקה נכשלת (ENOTEMPTY),
// Claude Code רואה נעילה תפוסה ומדלג על החידוש, וכל הרצה נכשלת ב-"OAuth access token has expired". משימות מהטלפון
// נכשלות אז בשקט. כאן מזהים נעילה כזאת ומזיזים אותה הצידה (שינוי שם, לא מחיקה), והחידוש הבא עובד.
import { existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function claudeLockPath(env: NodeJS.ProcessEnv = process.env): string {
  // הנעילה יושבת ליד תיקיית ההגדרות של Claude Code (ברירת המחדל: ~/.claude), באותו שם עם .lock
  return (env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) + '.lock';
}

export interface StaleLockResult {
  /** יש נעילה תקועה (תיקייה עם תוכן, או ישנה מ-maxAgeMs) */
  stale: boolean;
  /** הוזזה הצידה: הנתיב החדש */
  movedTo: string | null;
  detail: string;
}

/**
 * בודק את תיקיית הנעילה. נעילה אמיתית חיה שניות; תיקייה עם קבצים בפנים, או שגילה מעל maxAgeMs, היא תקועה.
 * עם fix=true מזיזים אותה (שינוי שם ל-<נתיב>.stale-<זמן>), אחרת רק מדווחים.
 */
export function checkStaleClaudeLock(path = claudeLockPath(), opts: { fix?: boolean; maxAgeMs?: number; now?: number } = {}): StaleLockResult {
  const maxAge = opts.maxAgeMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now();
  if (!existsSync(path)) return { stale: false, movedTo: null, detail: 'אין נעילה' };
  let st;
  try { st = statSync(path); } catch { return { stale: false, movedTo: null, detail: 'אין נעילה' }; }
  if (!st.isDirectory()) return { stale: false, movedTo: null, detail: 'הנעילה אינה תיקייה' };
  let entries: string[] = [];
  try { entries = readdirSync(path); } catch { /* נמחקה בינתיים */ return { stale: false, movedTo: null, detail: 'אין נעילה' }; }
  const ageMs = now - st.mtimeMs;
  const stale = entries.length > 0 || ageMs > maxAge;
  if (!stale) return { stale: false, movedTo: null, detail: 'נעילה רגעית' };
  const why = entries.length ? `יש בה קבצים (${entries.slice(0, 3).join(', ')})` : `גילה ${Math.round(ageMs / 60_000)} דקות`;
  if (!opts.fix) return { stale: true, movedTo: null, detail: `נעילה תקועה של Claude Code: ${why}` };
  const dest = `${path}.stale-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  try {
    renameSync(path, dest);
    return { stale: true, movedTo: dest, detail: `נעילה תקועה של Claude Code (${why}) הוזזה ל-${dest}` };
  } catch (e) {
    return { stale: true, movedTo: null, detail: `נעילה תקועה של Claude Code (${why}), ולא ניתן להזיז אותה: ${e instanceof Error ? e.message : String(e)}` };
  }
}
