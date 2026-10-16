// תיקיית הפרויקטים: איפה נוצרים פרויקטים חדשים, ושינוי המיקום, עם העברה של הפרויקטים הקיימים (לבחירת המשתמש).
//
// בהעברה זזות רק תיקיות שנמצאות ישירות בתוך תיקיית הפרויקטים הנוכחית. יחד עם כל תיקייה זזים גם התמלילים של
// Claude Code (~/.claude/projects/<נתיב מקודד>), כדי שאפשר יהיה להמשיך את השיחות הישנות בתיקייה החדשה,
// והנתיב הקודם נשמר בפרויקט, כדי שהשיחות הישנות יישארו משויכות אליו.
import { existsSync, mkdirSync, readdirSync, renameSync, cpSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './config.ts';
import { saveUserConfig } from './config.ts';
import type { Store } from './store/db.ts';
import { samePath, defaultProjectsDir, parseSessionMeta } from './history/claude-history.ts';
import { log } from './log.ts';
import { linuxDesktopDir } from './platform.ts';

/** התיקייה שבה Claude (Desktop/Cowork) שומר פרויקטים, אם קיימת במחשב. */
export function claudeProjectsDir(home = homedir()): string | null {
  const c = [join(home, 'Documents', 'Claude', 'Projects'), join(home, 'OneDrive', 'Documents', 'Claude', 'Projects'), join(home, 'OneDrive', 'מסמכים', 'Claude', 'Projects')];
  return c.find(p => existsSync(p)) ?? null;
}

/** ברירת המחדל להתקנה חדשה: התיקייה של Claude אם יש, אחרת ClaudeProjects בשולחן העבודה. */
export function defaultProjectsParent(home = homedir()): string {
  return claudeProjectsDir(home) ?? desktopProjectsDir(home);
}

/** ClaudeProjects בשולחן העבודה. בלינוקס בלי שולחן עבודה (שרת): בתיקיית הבית. */
export function desktopProjectsDir(home = homedir()): string {
  if (process.platform === 'linux') return join(linuxDesktopDir(home) ?? home, 'ClaudeProjects');
  return join(home, 'Desktop', 'ClaudeProjects');
}

/** איך Claude Code קורא לתיקיית התמלילים של תיקיית עבודה. */
export function encodeCwd(p: string): string { return resolve(p).replace(/[^a-zA-Z0-9]/g, '-'); }

const isInside = (root: string, p: string) => { const r = relative(resolve(root), resolve(p)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

export interface LocationInfo {
  parent: string;
  exists: boolean;
  /** פרויקטים שנמצאים ישירות בתוך תיקיית הפרויקטים (הם אלה שיעברו בהעברה). */
  inside: { id: string; name: string; path: string }[];
  suggestions: { path: string; label: string; exists: boolean; current: boolean }[];
}

export interface MoveResult {
  parent: string;
  moved: { name: string; from: string; to: string; transcripts: number }[];
  skipped: { name: string; reason: string }[];
  added: number;
}

export interface LocationDeps {
  cfg: Config;
  store: Store;
  /** סיבה לא להעביר פרויקט עכשיו (משימה רצה, שיחה פתוחה), או null. */
  busy: (projectId: string, path: string) => string | null;
  root?: string;
  claudeHome?: string;              // בבדיקות: במקום ~/.claude/projects
  home?: string;
}

export class ProjectsLocation {
  constructor(private d: LocationDeps) {}

  private projectsDir(): string { return this.d.claudeHome ?? defaultProjectsDir(); }

  private insideParent(parent: string) {
    return this.d.store.listProjects().filter(p => samePath(dirname(resolve(p.path)), parent) && existsSync(p.path));
  }

  info(): LocationInfo {
    const parent = this.d.cfg.projects.newProjectsParent;
    const home = this.d.home ?? homedir();
    const claude = claudeProjectsDir(home);
    const sugg = [
      ...(claude ? [{ path: claude, label: 'התיקייה של Claude (שם נמצאים הפרויקטים של Cowork)' }] : []),
      { path: desktopProjectsDir(home), label: process.platform === 'linux' && !linuxDesktopDir(home) ? 'ClaudeProjects בתיקיית הבית' : 'ClaudeProjects בשולחן העבודה' },
      { path: join(home, 'Documents', 'ClaudeProjects'), label: 'ClaudeProjects במסמכים' },
    ];
    return {
      parent, exists: existsSync(parent),
      inside: this.insideParent(parent).map(p => ({ id: p.id, name: p.spokenName, path: p.path })),
      suggestions: sugg.map(s => ({ ...s, exists: existsSync(s.path), current: samePath(s.path, parent) })),
    };
  }

  /** קובע תיקיית פרויקטים חדשה. move: להעביר אליה גם את הפרויקטים שבתיקייה הנוכחית. */
  change(rawParent: string, move: boolean): MoveResult {
    const next = resolve(String(rawParent ?? '').trim());
    if (!rawParent || !isAbsolute(String(rawParent).trim())) throw new Error('יש לבחור נתיב מלא של תיקייה');
    if (/^[a-zA-Z]:\\?$/.test(next)) throw new Error('אי אפשר לבחור כונן שלם. בחר תיקייה בתוכו');
    const old = resolve(this.d.cfg.projects.newProjectsParent);
    const result: MoveResult = { parent: next, moved: [], skipped: [], added: 0 };
    const toMove = move && !samePath(old, next) ? this.insideParent(old) : [];
    for (const p of toMove) if (isInside(p.path, next)) throw new Error(`התיקייה החדשה נמצאת בתוך הפרויקט ${p.name}. בחר מקום אחר`);
    try { mkdirSync(next, { recursive: true }); } catch { throw new Error('לא ניתן ליצור את התיקייה במקום הזה'); }

    for (const p of toMove) {
      const to = join(next, basename(p.path));
      const why = this.d.busy(p.id, p.path);
      if (why) { result.skipped.push({ name: p.spokenName, reason: why }); continue; }
      if (existsSync(to)) { result.skipped.push({ name: p.spokenName, reason: 'בתיקייה החדשה כבר יש תיקייה בשם הזה' }); continue; }
      try { moveDir(p.path, to); }
      catch (e: any) {
        result.skipped.push({ name: p.spokenName, reason: e?.code === 'EBUSY' || e?.code === 'EPERM' ? 'קובץ בתיקייה פתוח בתוכנה אחרת. סגור אותו ונסה שוב' : 'ההעברה נכשלה' });
        continue;
      }
      const transcripts = this.moveTranscripts(p.path, to);
      this.d.store.moveProject(p.id, to);
      for (const e of this.d.cfg.projects.list) if (samePath(e.path, p.path)) e.path = to;
      result.moved.push({ name: p.spokenName, from: p.path, to, transcripts });
      log('projects', `הפרויקט ${p.name} הועבר ל-${to} (${transcripts} שיחות)`);
    }

    this.d.cfg.projects.newProjectsParent = next;
    saveUserConfig({ projects: { newProjectsParent: next, list: this.d.cfg.projects.list } }, this.d.root);
    // כל תיקייה בתיקיית הפרויקטים החדשה היא פרויקט (כמו בהפעלה)
    const before = this.d.store.listProjects().length;
    for (const e of readdirSync(next, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) this.d.store.addProject({ name: e.name, path: join(next, e.name) });
    }
    result.added = this.d.store.listProjects().length - before;
    log('projects', `תיקיית הפרויקטים: ${next}`);
    return result;
  }

  /** מעביר את תמלילי Claude Code של התיקייה (ושל תיקיות בתוכה) למקום שמתאים לנתיב החדש. */
  private moveTranscripts(from: string, to: string): number {
    const root = this.projectsDir();
    if (!existsSync(root)) return 0;
    let n = 0;
    for (const d of readdirSync(root)) {
      const dir = join(root, d);
      let files: string[];
      try { if (!statSync(dir).isDirectory()) continue; files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = join(dir, f);
        const meta = parseSessionMeta(file, f.slice(0, -6), 0);
        if (!meta?.cwd || !isInside(from, meta.cwd)) continue;
        const newCwd = join(to, relative(resolve(from), resolve(meta.cwd)));
        const destDir = join(root, encodeCwd(newCwd));
        if (samePath(destDir, dir)) continue;
        const dest = join(destDir, f);
        if (existsSync(dest)) continue;
        try {
          mkdirSync(destDir, { recursive: true });
          renameSync(file, dest);
          const side = join(dir, f.slice(0, -6));          // תיקיית הלוואי של השיחה (סוכני משנה, תוצאות כלים)
          if (existsSync(side) && !existsSync(join(destDir, f.slice(0, -6)))) renameSync(side, join(destDir, f.slice(0, -6)));
          n++;
        } catch { /* שיחה פתוחה כרגע: נשארת במקום */ }
      }
    }
    return n;
  }
}

/** העברת תיקייה, גם בין כוננים (העתקה ואז מחיקה). */
function moveDir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); return; }
  catch (e: any) { if (e?.code !== 'EXDEV') throw e; }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  rmSync(from, { recursive: true, force: true });
}
