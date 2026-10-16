// שיחות Cowork ששמורות במחשב (שלב 3ג). Claude Desktop שומר אותן ב-%APPDATA%\Claude\local-agent-mode-sessions:
//   <חשבון>\<ארגון>\local_<id>.json             פרטי השיחה (כותרת, תיקייה, תיקיות שנבחרו, פרויקט Cowork)
//   <חשבון>\<ארגון>\local_<id>\.claude\projects\<תיקייה מקודדת>\<cliSessionId>.jsonl   התמליל (אותו פורמט כמו Claude Code)
//   <חשבון>\<ארגון>\spaces.json                  פרויקטי Cowork (שם ותיקיות)
// קריאה בלבד. המשך שיחה נעשה דרך קישור קשיח זמני לתמליל (ראה linkForRun), כך ש-Desktop רואה את ההודעות החדשות.
// שיחות שרצו במכונה הווירטואלית של Cowork (תיקייה /sessions/...) אפשר רק לקרוא. שיחות ענן לא שמורות כאן בכלל.
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, linkSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parseMessages, defaultProjectsDir, type HistoryMessage } from './claude-history.ts';
import { claudeDesktopDataDir } from '../platform.ts';

export interface CoworkSession {
  id: string;                  // cliSessionId: המזהה שאיתו ממשיכים את השיחה
  localId: string;             // local_<uuid> של Desktop
  title: string;
  cwd: string;                 // תיקיית העבודה של השיחה (outputs של Cowork)
  folders: string[];           // התיקיות שנבחרו בשיחה
  spaceName: string | null;    // פרויקט Cowork
  hostMode: boolean;           // רצה על המחשב (ולא במכונה הווירטואלית): אפשר להמשיך
  archived: boolean;
  createdAt: string | null;
  lastActiveAt: string;
  transcript: string | null;
  projDir: string | null;      // שם התיקייה המקודדת של התמליל
  mtimeMs: number;             // זמן השינוי של התמליל (לזיהוי שיחה פתוחה ב-Desktop)
}

export function defaultCoworkRoot(): string {
  // בלינוקס אין Claude Desktop רשמי: התיקייה בדרך כלל לא קיימת, והרשימה פשוט ריקה
  return join(claudeDesktopDataDir(), 'local-agent-mode-sessions');
}

interface Cached { metaKey: string; tr: { file: string; projDir: string } | null; base: CoworkSession | null; lastMeta: number }

export class CoworkHistory {
  private cache = new Map<string, Cached>();
  private spaces = new Map<string, { key: string; names: Map<string, string> }>();

  constructor(private root = defaultCoworkRoot(), private claudeProjectsDir = defaultProjectsDir()) {}

  list(): CoworkSession[] {
    const out: CoworkSession[] = [];
    const seen = new Set<string>();
    for (const dir of subdirs(this.root).flatMap(subdirs)) {
      const spaceNames = this.spaceNames(dir);
      for (const f of safe(() => readdirSync(dir), [] as string[])) {
        if (!/^local_[\w-]+\.json$/.test(f)) continue;
        const meta = join(dir, f);
        seen.add(meta);
        const localDir = meta.slice(0, -5);
        const st = safe(() => statSync(meta), null);
        if (!st) continue;
        // קובץ הפרטים גדול (כולל הנחיות מלאות): נקרא מחדש רק כשהשתנה. התמליל נבדק בכל פעם (רק stat).
        const metaKey = `${st.mtimeMs}:${st.size}:${[...spaceNames.values()].join('|')}`;
        let c = this.cache.get(meta);
        if (!c || c.metaKey !== metaKey) {
          const tr = this.findTranscript(localDir, meta);
          const parsed = parseMeta(meta, tr, spaceNames);
          c = { metaKey, tr, base: parsed?.s ?? null, lastMeta: parsed?.lastMeta ?? 0 };
          this.cache.set(meta, c);
        }
        if (!c.base) continue;
        const trMtime = c.tr ? safe(() => statSync(c!.tr!.file).mtimeMs, 0) : 0;
        out.push({ ...c.base, mtimeMs: trMtime, lastActiveAt: new Date(Math.max(c.lastMeta, trMtime) || Date.now()).toISOString() });
      }
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return out.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  get(id: string): CoworkSession | null { return this.list().find(s => s.id === id) ?? null; }

  messages(id: string, limit = 500): HistoryMessage[] {
    const s = this.get(id);
    return s?.transcript ? parseMessages(s.transcript).slice(-limit) : [];
  }

  /** נכתבה בדקות האחרונות: כנראה פתוחה עכשיו ב-Desktop. */
  isActive(s: CoworkSession, now = Date.now(), minutes = 3): boolean { return now - s.mtimeMs < minutes * 60_000; }

  /**
   * הכנה להמשך: קישור קשיח לתמליל בתוך ~/.claude/projects, כדי ש-Claude Code ימצא את השיחה (resume) ויכתוב
   * ישירות לקובץ של Desktop. מחזיר פונקציה שמסירה את הקישור בלבד (הקובץ עצמו נשאר).
   */
  linkForRun(s: CoworkSession): () => void {
    if (!s.transcript || !s.projDir) throw new Error('התמליל של השיחה לא נמצא');
    const dir = join(this.claudeProjectsDir, s.projDir);
    const madeDir = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    const link = join(dir, `${s.id}.jsonl`);
    if (existsSync(link)) {
      // נשאר קישור מהרצה קודמת (למשל אחרי נפילה): בסדר אם זה אותו קובץ
      const a = statSync(link), b = statSync(s.transcript);
      if (a.ino !== b.ino || a.dev !== b.dev) throw new Error('קיים כבר קובץ שיחה אחר באותו שם');
      return () => { /* לא אנחנו יצרנו אותו */ };
    }
    linkSync(s.transcript, link);
    return () => {
      try { unlinkSync(link); } catch { /* */ }
      if (madeDir) { try { rmdirSync(dir); } catch { /* נשארו קבצים */ } }
    };
  }

  private findTranscript(localDir: string, meta: string): { file: string; projDir: string } | null {
    const cli = safe(() => /"cliSessionId"\s*:\s*"([\w-]+)"/.exec(readFileSync(meta, 'utf8'))?.[1] ?? null, null);
    if (!cli) return null;
    const pdir = join(localDir, '.claude', 'projects');
    for (const d of safe(() => readdirSync(pdir), [] as string[])) {
      const f = join(pdir, d, `${cli}.jsonl`);
      if (existsSync(f)) return { file: f, projDir: d };
    }
    return null;
  }

  private spaceNames(dir: string): Map<string, string> {
    const p = join(dir, 'spaces.json');
    const st = safe(() => statSync(p), null);
    const key = st ? `${st.mtimeMs}:${st.size}` : 'none';
    const c = this.spaces.get(dir);
    if (c && c.key === key) return c.names;
    const names = new Map<string, string>();
    const j = st ? safe(() => JSON.parse(readFileSync(p, 'utf8')), null) : null;
    for (const sp of Array.isArray(j?.spaces) ? j.spaces : []) if (sp?.id && sp?.name) names.set(String(sp.id), String(sp.name));
    this.spaces.set(dir, { key, names });
    return names;
  }
}

function parseMeta(meta: string, tr: { file: string; projDir: string } | null, spaceNames: Map<string, string>): { s: CoworkSession; lastMeta: number } | null {
  const j = safe(() => JSON.parse(readFileSync(meta, 'utf8')), null);
  if (!j || typeof j.cliSessionId !== 'string') return null;
  const cwd = String(j.cwd ?? '');
  const folders = Array.isArray(j.userSelectedFolders) ? j.userSelectedFolders.map(String) : [];
  const hostMode = !!cwd && !cwd.startsWith('/sessions/') && isAbsolute(cwd) && existsSync(cwd);
  const lastMeta = Number(j.lastActivityAt) || 0;
  const first = typeof j.initialMessage === 'string' ? j.initialMessage.replace(/\s+/g, ' ').trim() : '';
  const title = String(j.title ?? '').trim() || first.slice(0, 80) || 'שיחת Cowork ללא כותרת';
  const s: CoworkSession = {
    id: j.cliSessionId, localId: String(j.sessionId ?? ''), title: title.slice(0, 80), cwd, folders,
    spaceName: j.spaceId ? spaceNames.get(String(j.spaceId)) ?? null : null,
    hostMode, archived: !!j.isArchived,
    createdAt: j.createdAt ? new Date(Number(j.createdAt)).toISOString() : null,
    lastActiveAt: new Date(lastMeta || Date.now()).toISOString(),
    transcript: tr?.file ?? null, projDir: tr?.projDir ?? null, mtimeMs: 0,
  };
  return { s, lastMeta };
}

function subdirs(d: string): string[] {
  return safe(() => readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(d, e.name)), [] as string[]);
}
function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }
