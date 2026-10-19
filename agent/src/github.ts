// מאגרי GitHub כפרויקטים: רשימת המאגרים של המשתמש (לטלפון ולדשבורד), שכפול בפעם הראשונה ו-pull בפעמים הבאות.
// הטוקן נשמר רק בקובץ data/github.token. ב-.git/config של המאגר נרשם credential helper שקורא אותו משם, כך שגם git push עובד
// בלי שהטוקן ייכתב בכתובת המאגר.
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import type { Project } from '@claude-phone/shared';
import type { Store } from './store/db.ts';
import { readSecretFile } from './config.ts';
import { log } from './log.ts';

export interface RepoInfo { fullName: string; name: string; spokenName: string; private: boolean }

export class GitHubError extends Error {}

export const REPO_FULL = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface GitHubOptions {
  tokenFile: string;
  /** תיקיית הפרויקטים (נקראת בכל פעם: אפשר להחליף אותה בלוח). */
  parent: () => string;
  store: Store;
  apiBase?: string;
  fetch?: typeof fetch;
  /** מריץ git (נדרס בבדיקות). */
  git?: (args: string[], cwd?: string) => Promise<string>;
}

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((res, rej) => execFile('git', args, { cwd, windowsHide: true, timeout: 10 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, out, errOut) => err ? rej(new Error((errOut || err.message).trim().split('\n').pop())) : res(out)));
}

export function spokenRepoName(name: string): string { return name.replace(/[-_.]+/g, ' ').trim() || name; }

export class GitHubRepos {
  private cache: { at: number; repos: RepoInfo[] } | null = null;
  private fetchFn: typeof fetch;
  private git: (args: string[], cwd?: string) => Promise<string>;
  private opening = new Map<string, Promise<Project>>();

  constructor(private o: GitHubOptions) {
    this.fetchFn = o.fetch ?? fetch;
    this.git = o.git ?? runGit;
  }

  token(): string | null { return readSecretFile(this.o.tokenFile); }
  hasToken(): boolean { return !!this.token(); }

  private async api<T>(path: string, token = this.token()): Promise<T> {
    if (!token) throw new GitHubError('GitHub לא מחובר. הדבק טוקן בלוח הבקרה');
    const base = (this.o.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    const r = await this.fetchFn(base + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudePhone', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 401) throw new GitHubError('הטוקן של GitHub לא תקין או שפג תוקפו');
    if (r.status === 403 || r.status === 429) throw new GitHubError('GitHub הגביל זמנית את הבקשות. נסה שוב עוד מעט');
    if (!r.ok) throw new GitHubError(`GitHub החזיר שגיאה ${r.status}`);
    return r.json() as Promise<T>;
  }

  /** שומר טוקן אחרי שבדק אותו מול GitHub. טוקן ריק מוחק. מחזיר את שם המשתמש. */
  async saveToken(token: string): Promise<string | null> {
    const t = token.trim();
    if (!t) { rmSync(this.o.tokenFile, { force: true }); this.cache = null; return null; }
    if (!/^[A-Za-z0-9_\-]{20,255}$/.test(t)) throw new GitHubError('הטוקן נראה לא תקין');
    const me = await this.api<{ login: string }>('/user', t);
    mkdirSync(dirname(this.o.tokenFile), { recursive: true });
    writeFileSync(this.o.tokenFile, t + '\n', { encoding: 'utf8', mode: 0o600 });
    this.cache = null;
    return me.login;
  }

  async login(): Promise<string | null> {
    if (!this.hasToken()) return null;
    return (await this.api<{ login: string }>('/user')).login;
  }

  /** המאגרים של המשתמש, מהעדכני לישן (עד 100). נשמר בזיכרון דקה. */
  async list(): Promise<RepoInfo[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.repos;
    const rows = await this.api<any[]>('/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member');
    const repos = rows.filter(x => x && !x.archived && REPO_FULL.test(String(x.full_name)))
      .map(x => ({ fullName: String(x.full_name), name: String(x.name), spokenName: spokenRepoName(String(x.name)), private: !!x.private }));
    this.cache = { at: Date.now(), repos };
    return repos;
  }

  /** פותח מאגר כפרויקט: משכפל אם אין, מושך עדכונים אם יש. קריאות במקביל לאותו מאגר חולקות פעולה אחת. */
  open(fullName: string): Promise<Project> {
    if (!REPO_FULL.test(fullName)) return Promise.reject(new GitHubError('שם מאגר לא תקין'));
    const running = this.opening.get(fullName);
    if (running) return running;
    const p = this.doOpen(fullName).finally(() => this.opening.delete(fullName));
    this.opening.set(fullName, p);
    return p;
  }

  private async doOpen(fullName: string): Promise<Project> {
    if (!this.hasToken()) throw new GitHubError('GitHub לא מחובר. הדבק טוקן בלוח הבקרה');
    const [owner, name] = fullName.split('/');
    const parent = resolve(this.o.parent());
    mkdirSync(parent, { recursive: true });
    const dir = await this.chooseDir(parent, owner, name, fullName);
    if (existsSync(join(dir, '.git'))) {
      await this.git(['pull', '--ff-only', '--quiet'], dir).catch(e => log('github', `pull נכשל ב-${fullName} (ממשיכים עם מה שיש):`, e.message));
    } else {
      await this.git(['clone', '--quiet', `https://github.com/${fullName}.git`, dir]);
      await this.configureCredentials(dir);
      log('github', `שוכפל ${fullName}`);
    }
    return this.o.store.getProjectByPath(dir) ?? this.o.store.addProject({ name: name, spokenName: spokenRepoName(name), path: dir });
  }

  /** התיקייה למאגר: <שם>, ואם תפוסה במשהו אחר אז <בעלים>-<שם>. */
  private async chooseDir(parent: string, owner: string, name: string, fullName: string): Promise<string> {
    for (const folder of [name, `${owner}-${name}`]) {
      const dir = join(parent, folder);
      if (!existsSync(dir)) return dir;
      if (existsSync(join(dir, '.git'))) {
        const url = await this.git(['remote', 'get-url', 'origin'], dir).catch(() => '');
        if (url.toLowerCase().includes(fullName.toLowerCase())) return dir;
      }
    }
    throw new GitHubError(`התיקייה ${name} כבר קיימת ואינה המאגר הזה`);
  }

  /** helper מקומי למאגר: git ביקש סיסמה ל-github.com, והטוקן נקרא מהקובץ בזמן ההרצה. */
  private async configureCredentials(dir: string): Promise<void> {
    const file = this.o.tokenFile.replace(/\\/g, '/');
    const helper = `!f() { echo username=x-access-token; echo password=$(cat "${file}"); }; f`;
    await this.git(['config', '--local', 'credential.https://github.com.helper', helper], dir);
  }
}
