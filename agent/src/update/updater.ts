// עדכון מתוך התוכנה: בודק ב-GitHub Releases אם יש גרסה חדשה, מוריד את קובץ ההתקנה, מוודא שהוא תקין ומריץ אותו בשקט.
// קובץ ההתקנה עוצר את הסוכן, מחליף את הקבצים (ההגדרות והנתונים נשמרים) ומפעיל אותו מחדש.
//
// מה נחשב גרסה: ה-Release האחרון (לא טיוטה ולא prerelease) במאגר שבהגדרות, עם קובץ ClaudePhone-Setup-<גרסה>.exe.
// אימות: הגודל, ו-SHA-256 כש-GitHub מפרסם אותו (שדה digest) או כשיש לצד הקובץ קובץ .sha256.
import { createWriteStream, mkdirSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { log, logError } from '../log.ts';

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'installing' | 'failed';

export interface UpdateState {
  enabled: boolean;
  disabledReason: string | null;
  repo: string;
  current: string | null;
  latest: string | null;
  available: boolean;
  notes: string | null;
  publishedAt: string | null;
  pageUrl: string | null;
  checkedAt: string | null;
  error: string | null;
  phase: UpdatePhase;
  progress: number | null;      // 0..1 בזמן הורדה
  auto: boolean;
}

export interface UpdaterOptions {
  repo: string;
  apiBase?: string;
  current: string | null;
  checkHours?: number;
  auto?: boolean;
  /** האם מותר להתקין עכשיו לבד (אין משימה רצה ואין שיחת טלפון). */
  canAutoInstall?: () => boolean;
  fetch?: typeof fetch;
  /** מריץ את קובץ ההתקנה (נדרס בבדיקות). */
  launch?: (exe: string, logFile: string) => void;
  downloadDir?: string;
  disabledReason?: string | null;
}

const ASSET = /^ClaudePhone-Setup-(\d+\.\d+\.\d+)\.exe$/i;
const HEADERS = { 'User-Agent': 'ClaudePhone-updater', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

export function parseVersion(v: string | null | undefined): number[] | null {
  const m = String(v ?? '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** חיובי אם a חדשה מ-b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** הרצת קובץ ההתקנה בלי לקשור אותו לתהליך הסוכן (ההתקנה עוצרת את הסוכן ואת כל התהליכים שהוא הפעיל). */
export function launchInstaller(exe: string, logFile: string): void {
  const line = `/d /s /c "start "" "${exe}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="${logFile}""`;
  spawn(process.env.ComSpec || 'cmd.exe', [line], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export class Updater {
  readonly state: UpdateState;
  private asset: { url: string; name: string; size: number; sha256: string | null } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private fetchFn: typeof fetch;

  constructor(private o: UpdaterOptions) {
    this.fetchFn = o.fetch ?? fetch;
    const reason = o.disabledReason ?? (o.current ? null : 'גרסת פיתוח: העדכון האוטומטי פועל רק בתוכנה המותקנת');
    this.state = {
      enabled: !reason, disabledReason: reason, repo: o.repo, current: o.current, latest: null, available: false,
      notes: null, publishedAt: null, pageUrl: null, checkedAt: null, error: null, phase: 'idle', progress: null, auto: !!o.auto,
    };
  }

  setRepo(repo: string): void {
    if (!REPO_RE.test(repo)) throw new Error('שם המאגר צריך להיות בצורה owner/repo');
    this.o.repo = repo; this.state.repo = repo;
    this.state.latest = null; this.state.available = false; this.state.error = null; this.asset = null;
  }

  setAuto(auto: boolean): void { this.o.auto = auto; this.state.auto = auto; }

  /** בדיקה ראשונה אחרי דקה, ואחר כך כל כמה שעות. */
  start(): void {
    if (!this.state.enabled || this.timer) return;
    const tick = () => this.check().then(() => this.maybeAuto()).catch(() => { /* נרשם במצב */ });
    setTimeout(tick, 60_000).unref();
    this.timer = setInterval(tick, Math.max(1, this.o.checkHours ?? 6) * 3600_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async check(): Promise<UpdateState> {
    const s = this.state;
    if (!s.enabled) return s;
    if (s.phase === 'downloading' || s.phase === 'installing') return s;
    s.phase = 'checking'; s.error = null;
    try {
      const api = (this.o.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
      const r = await this.fetchFn(`${api}/repos/${this.o.repo}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (r.status === 404) throw new Error('לא נמצאה גרסה מפורסמת במאגר. ייתכן שהמאגר פרטי או שעוד לא פורסמה גרסה');
      if (r.status === 403 || r.status === 429) throw new Error('GitHub הגביל זמנית את מספר הבדיקות. ננסה שוב מאוחר יותר');
      if (!r.ok) throw new Error(`GitHub החזיר שגיאה ${r.status}`);
      const j: any = await r.json();
      const assets: any[] = Array.isArray(j.assets) ? j.assets : [];
      const exe = assets.find(a => ASSET.test(String(a.name)));
      const version = exe ? String(exe.name).match(ASSET)![1] : (parseVersion(j.tag_name) ? String(j.tag_name).replace(/^v/i, '') : null);
      s.latest = version;
      s.notes = typeof j.body === 'string' ? j.body.slice(0, 4000) : null;
      s.publishedAt = j.published_at ?? null;
      s.pageUrl = typeof j.html_url === 'string' ? j.html_url : null;
      this.asset = null;
      if (exe) {
        let sha = typeof exe.digest === 'string' && exe.digest.startsWith('sha256:') ? exe.digest.slice(7).toLowerCase() : null;
        if (!sha) {
          const side = assets.find(a => String(a.name).toLowerCase() === `${String(exe.name).toLowerCase()}.sha256`);
          if (side) {
            const t = await (await this.fetchFn(side.browser_download_url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(20_000) })).text();
            sha = t.match(/\b[a-fA-F0-9]{64}\b/)?.[0]?.toLowerCase() ?? null;
          }
        }
        this.asset = { url: String(exe.browser_download_url), name: String(exe.name), size: Number(exe.size) || 0, sha256: sha };
      }
      s.available = !!(this.asset && version && s.current && compareVersions(version, s.current) > 0);
      s.phase = 'idle';
      if (s.available) log('update', `גרסה חדשה זמינה: ${version} (מותקנת ${s.current})`);
    } catch (e) {
      s.error = e instanceof Error ? (e.name === 'TimeoutError' ? 'אין תשובה מ-GitHub. בדוק את החיבור לאינטרנט' : e.message) : String(e);
      s.phase = 'idle';
    }
    s.checkedAt = new Date().toISOString();
    return s;
  }

  private async maybeAuto(): Promise<void> {
    if (!this.state.auto || !this.state.available || this.state.phase !== 'idle') return;
    if (this.o.canAutoInstall && !this.o.canAutoInstall()) return;
    log('update', 'עדכון אוטומטי מתחיל');
    await this.install().catch(e => logError('update', e, 'auto'));
  }

  /** הורדה, אימות והרצת ההתקנה. הסוכן ייעצר על ידי ההתקנה תוך כמה שניות. */
  async install(): Promise<void> {
    const s = this.state;
    if (!s.enabled) throw new Error(s.disabledReason ?? 'העדכון לא זמין');
    if (s.phase === 'downloading' || s.phase === 'installing') throw new Error('עדכון כבר מתבצע');
    if (!s.available || !this.asset) await this.check();
    if (!s.available || !this.asset) throw new Error(s.error ?? 'אין גרסה חדשה');
    const a = this.asset;
    const dir = this.o.downloadDir ?? join(tmpdir(), 'ClaudePhone-update');
    mkdirSync(dir, { recursive: true });
    const part = join(dir, a.name + '.part');
    const exe = join(dir, a.name);
    s.phase = 'downloading'; s.progress = 0; s.error = null;
    try {
      const r = await this.fetchFn(a.url, { headers: { 'User-Agent': HEADERS['User-Agent'], Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30 * 60_000) });
      if (!r.ok || !r.body) throw new Error(`ההורדה נכשלה (${r.status})`);
      const total = a.size || Number(r.headers.get('content-length')) || 0;
      const hash = createHash('sha256');
      const out = createWriteStream(part);
      let got = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value); got += value.length;
        if (!out.write(value)) await new Promise(res => out.once('drain', res));
        if (total) s.progress = Math.min(1, got / total);
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => e ? rej(e) : res()));
      if (a.size && got !== a.size) throw new Error('הקובץ שהורד לא שלם');
      const digest = hash.digest('hex');
      if (a.sha256 && digest !== a.sha256) throw new Error('הקובץ שהורד לא תואם לחתימה שפורסמה');
      if (existsSync(exe)) rmSync(exe, { force: true });
      renameSync(part, exe);
      s.progress = 1;
      s.phase = 'installing';
      log('update', `מתקין את גרסה ${s.latest}`);
      (this.o.launch ?? launchInstaller)(exe, join(dir, 'install.log'));
    } catch (e) {
      rmSync(part, { force: true });
      s.phase = 'failed'; s.progress = null;
      s.error = e instanceof Error ? (e.name === 'TimeoutError' ? 'ההורדה ארכה יותר מדי' : e.message) : String(e);
      logError('update', e, 'install');
      throw new Error(s.error);
    }
  }
}

/** הגרסה המותקנת: version.txt בתיקיית האפליקציה (רק בהתקנה). */
export function installedVersion(appDir: string): string | null {
  const f = join(appDir, 'version.txt');
  if (!existsSync(f)) return null;
  const v = readFileSync(f, 'utf8').replace(/^﻿/, '').trim();
  return parseVersion(v) ? v : null;
}
