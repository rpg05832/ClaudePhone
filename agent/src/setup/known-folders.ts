// תיקיות שכבר עבדו בהן עם Claude במחשב הזה, להצעה כפרויקטים באשף:
// שיחות Claude Code (טרמינל ו-Desktop), פרויקטים של Cowork (spaces.json), ותיקיות שנבחרו בשיחות Cowork.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import type { ClaudeHistory } from '../history/claude-history.ts';

export type FolderSource = 'code' | 'desktop' | 'cowork';

export interface KnownFolder {
  path: string;
  name: string;                 // שם מוצע לפרויקט (שם פרויקט Cowork אם יש, אחרת שם התיקייה)
  sources: FolderSource[];
  coworkProjects: string[];     // שמות פרויקטי Cowork שהתיקייה שייכת להם
  conversations: number;
  lastUsed: string | null;
}

const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)).replace(/[\\/]+$/, '');

export function knownFolders(opts: { history?: ClaudeHistory; appData?: string; exclude?: string[]; keepTemp?: boolean }): KnownFolder[] {
  const map = new Map<string, KnownFolder>();
  const add = (path: string | null | undefined, source: FolderSource, at: number | string | null, cowork?: string, count = 1) => {
    if (!path || typeof path !== 'string' || path.startsWith('/sessions/') || (process.platform === 'win32' && path.startsWith('/'))) return;     // נתיבי המכונה הווירטואלית של Cowork לא קיימים במחשב
    const k = key(path);
    let f = map.get(k);
    if (!f) { f = { path: resolve(path), name: basename(resolve(path)), sources: [], coworkProjects: [], conversations: 0, lastUsed: null }; map.set(k, f); }
    if (!f.sources.includes(source)) f.sources.push(source);
    if (cowork && !f.coworkProjects.includes(cowork)) { f.coworkProjects.push(cowork); if (f.coworkProjects.length === 1) f.name = cowork; }
    f.conversations += count;
    const iso = at === null ? null : new Date(at).toISOString();
    if (iso && (!f.lastUsed || iso > f.lastUsed)) f.lastUsed = iso;
  };

  // 1. שיחות Claude Code (כולל לשונית Code ב-Desktop)
  for (const s of opts.history?.list() ?? []) add(s.cwd, s.source === 'desktop' ? 'desktop' : 'code', s.lastActiveAt);

  // 2. Cowork: פרויקטים (spaces), שיחות מקומיות ושיחות ענן עם תיקיות מקומיות
  const root = join(opts.appData ?? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions');
  for (const dir of subdirs(root).flatMap(subdirs)) {
    const spaces = readJson(join(dir, 'spaces.json'));
    for (const sp of Array.isArray(spaces?.spaces) ? spaces.spaces : []) {
      for (const f of Array.isArray(sp.folders) ? sp.folders : []) add(f?.path, 'cowork', sp.updatedAt ?? null, String(sp.name ?? ''), 0);
    }
    const remote = readJson(join(dir, 'remote-session-spaces.json'));
    for (const e of Array.isArray(remote?.entries) ? remote.entries : []) for (const p of Array.isArray(e.folders) ? e.folders : []) add(p, 'cowork', null);
    for (const f of safe(() => readdirSync(dir), [] as string[]).filter(f => /^local_.*\.json$/.test(f))) {
      // הקבצים גדולים (פרומפט מלא); שולפים רק את השדות הנחוצים
      const text = safe(() => readFileSync(join(dir, f), 'utf8'), '');
      const m = text.match(/"userSelectedFolders"\s*:\s*(\[[^\]]*\])/);
      const at = text.match(/"lastActivityAt"\s*:\s*(\d+)/);
      for (const p of m ? safe(() => JSON.parse(m[1]) as string[], []) : []) add(p, 'cowork', at ? Number(at[1]) : null);
    }
  }

  const ex = (opts.exclude ?? []).map(key);
  const claudeData = key(join(opts.appData ?? process.env.APPDATA ?? '', 'Claude'));
  const home = key(homedir());
  return [...map.entries()]
    // בלי תיקיות זמניות (בדיקות) ובלי שורש של כונן
    .filter(([k]) => (opts.keepTemp || !/[\\/]temp[\\/]/i.test(k)) && !/^[a-z]:\\?$/i.test(k) && k !== '/')
    .filter(([k]) => k !== home && !k.startsWith(claudeData) && !ex.some(e => k === e || k.startsWith(e + (process.platform === 'win32' ? '\\' : '/'))))
    .map(([, f]) => f)
    .filter(f => safe(() => statSync(f.path).isDirectory(), false))
    .sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''));
}

function subdirs(d: string): string[] {
  return safe(() => readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(d, e.name)), [] as string[]);
}
function readJson(p: string): any { return existsSync(p) ? safe(() => JSON.parse(readFileSync(p, 'utf8')), null) : null; }
function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }
