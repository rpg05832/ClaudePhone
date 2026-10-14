// פרויקט חדש מהטלפון (אפיון 3): תיקייה רק בתוך תיקיית-האם, שם קיים או לא תקין נדחה, git init אוטומטי.
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import type { Project } from '@claude-phone/shared';
import type { Store } from './store/db.ts';
import { log } from './log.ts';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export class ProjectNameError extends Error {}

/** מנקה ובודק שם תיקייה. זורק ProjectNameError עם הודעה להקראה. */
export function folderNameFor(raw: string): string {
  const name = raw.replace(/[֑-ׇ]/g, '')     // ניקוד
    .replace(/[.,!?;:"'״׳]+$/g, '')                      // פיסוק בסוף (מזיהוי דיבור)
    .replace(/\s+/g, ' ').trim();
  if (!name) throw new ProjectNameError('שם ריק');
  if (name.length > 60) throw new ProjectNameError('השם ארוך מדי');
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || name.includes('..')) throw new ProjectNameError('השם מכיל תווים אסורים');
  if (RESERVED.test(name) || /[. ]$/.test(name)) throw new ProjectNameError('השם אינו תקין לתיקייה');
  return name;
}

export async function createProjectFromPhone(store: Store, parent: string, rawName: string, initGit: boolean): Promise<Project> {
  const name = folderNameFor(rawName);
  const parentAbs = resolve(parent);
  const dir = resolve(join(parentAbs, name));
  const rel = relative(parentAbs, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ProjectNameError('השם יוצא מתיקיית הפרויקטים');
  if (existsSync(dir) || store.getProjectByPath(dir)) throw new ProjectNameError('כבר קיים פרויקט בשם הזה');
  mkdirSync(parentAbs, { recursive: true });
  mkdirSync(dir);
  if (initGit) {
    await new Promise<void>(res => execFile('git', ['init', '-q'], { cwd: dir, windowsHide: true }, err => {
      if (err) log('projects', 'git init נכשל (ממשיכים בלי git):', err.message);
      res();
    }));
  }
  const proj = store.addProject({ name, spokenName: name, path: dir });
  log('projects', `פרויקט חדש מהטלפון: ${name}`);
  return proj;
}
