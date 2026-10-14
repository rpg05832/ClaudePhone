// אשף ההגדרה: בדיקת המחשב (אפיון 7). קריאה בלבד: שום דבר לא מותקן כאן.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statfsSync, statSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, release } from 'node:os';
import { AGENT_ROOT } from '../config.ts';

export type CheckState = 'ok' | 'missing' | 'old' | 'blocked' | 'error' | 'optional';

export interface CheckItem {
  id: string;
  name: string;           // מוצג למשתמש
  state: CheckState;
  detail: string;         // מה נמצא / מה חסר
  installable?: boolean;  // האשף יודע להוריד ולהתקין
  sizeMb?: number;        // גודל משוער להורדה
  required: boolean;
}

export interface NetCheck { host: string; purpose: string; state: 'ok' | 'blocked' | 'unreachable'; status?: number }

export const MODEL_ID = 'ivrit-ai/whisper-large-v3-turbo-ct2';
export const PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe';
export const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

/** הכתובות שהמערכת צריכה (לבקשת פתיחה בנטפרי אם חסומות). */
export const HOSTS: { host: string; purpose: string }[] = [
  { host: 'api.anthropic.com', purpose: 'Claude' },
  { host: 'claude.ai', purpose: 'התחברות ל-Claude' },
  { host: 'www.call2all.co.il', purpose: 'ימות המשיח' },
  { host: 'huggingface.co', purpose: 'הורדת מודל התמלול' },
  { host: 'github.com', purpose: 'הורדת רכיב המנהרה' },
  { host: 'www.python.org', purpose: 'הורדת Python' },
  { host: 'pypi.org', purpose: 'התקנת רכיב התמלול' },
  { host: 'files.pythonhosted.org', purpose: 'התקנת רכיב התמלול' },
];

export function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise(res => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (e: any, out, err) => {
      res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out ?? '').trim(), err: String(err ?? '').trim() });
    });
  });
}

/** תיקיית חבילה ב-node_modules, בחיפוש כלפי מעלה מתיקיית הסוכן (פיתוח: workspaces בשורש; התקנה: agent/node_modules). */
export function packageDir(name: string): string | null {
  let dir = AGENT_ROOT;
  for (let i = 0; i < 5; i++) {
    const p = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(p, 'package.json'))) return p;
    const up = dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}

/** קובץ ההרצה של Claude Code שמגיע עם ה-Agent SDK (לא צריך התקנה נפרדת). */
export function sdkClaudeExe(): string | null {
  const d = packageDir('@anthropic-ai/claude-agent-sdk-win32-x64');
  const exe = d ? join(d, 'claude.exe') : null;
  return exe && existsSync(exe) ? exe : null;
}

export async function claudeAuth(): Promise<{ loggedIn: boolean; method: string | null; detail: string }> {
  const exe = sdkClaudeExe();
  if (!exe) return { loggedIn: false, method: null, detail: 'רכיב Claude לא נמצא בהתקנה' };
  const r = await run(exe, ['auth', 'status'], 30_000);
  try {
    const j = JSON.parse(r.out);
    const method = j.authMethod ?? null;
    const loggedIn = r.code === 0 && method && method !== 'none';
    return { loggedIn: !!loggedIn, method, detail: loggedIn ? (method === 'claude.ai' ? 'מחובר עם מנוי Claude' : `מחובר (${method})`) : 'לא מחובר' };
  } catch {
    return { loggedIn: r.code === 0, method: null, detail: r.code === 0 ? 'מחובר' : 'לא מחובר' };
  }
}

/**
 * מוצא Python שמתאים (3.10 ומעלה) ובודק אם faster-whisper מותקן. מעדיף Python שכבר יש בו faster-whisper.
 * לא סומך רק על PATH: אצל חלק מהמשתמשים עם שם משתמש בעברית, PATH שמור עם ????? במקום השם, ו-"python" לא נמצא.
 */
export async function findPython(configured?: string): Promise<{ path: string | null; version: string | null; fasterWhisper: string | null }> {
  const cands: [string, string[]][] = [];
  if (configured && configured !== 'python') cands.push([configured, []]);
  const roots = [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python'), process.env.ProgramFiles ?? 'C:\\Program Files', 'C:\\'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[] = [];
    try { dirs = readdirSync(root).filter(d => /^Python3\d+$/i.test(d)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7))); } catch { /* */ }
    for (const d of dirs) { const exe = join(root, d, 'python.exe'); if (existsSync(exe)) cands.push([exe, []]); }
  }
  cands.push(['python', []], ['py', ['-3']]);
  let first: { path: string; version: string; fasterWhisper: string | null } | null = null;
  const seen = new Set<string>();
  for (const [cmd, pre] of cands) {
    const r = await run(cmd, [...pre, '-c', 'import sys;print(sys.executable);print("%d.%d.%d"%sys.version_info[:3])'], 15_000);
    if (r.code !== 0 || !r.out) continue;
    const [exe, ver] = r.out.split(/\r?\n/);
    if (!exe || seen.has(exe.toLowerCase())) continue;
    seen.add(exe.toLowerCase());
    const [maj, min] = (ver ?? '').split('.').map(Number);
    if (maj !== 3 || min < 10) continue;
    const fw = await run(exe, ['-c', 'import faster_whisper;print(faster_whisper.__version__)'], 30_000);
    const found = { path: exe, version: ver, fasterWhisper: fw.code === 0 ? fw.out : null };
    if (found.fasterWhisper) return found;
    first ??= found;
  }
  return first ?? { path: null, version: null, fasterWhisper: null };
}

export function modelDir(): string {
  const hfHome = process.env.HF_HOME ? join(process.env.HF_HOME, 'hub') : join(homedir(), '.cache', 'huggingface', 'hub');
  return join(hfHome, 'models--' + MODEL_ID.replace('/', '--'));
}

export function modelPresent(): boolean {
  const snaps = join(modelDir(), 'snapshots');
  if (!existsSync(snaps)) return false;
  // model.bin במטמון הוא קישור סמלי; בודקים את הקישור עצמו (lstat), בלי לעבור דרכו
  const has = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  return readdirSync(snaps).some(s => has(join(snaps, s, 'model.bin')));
}

export function dirSizeMb(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of (() => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) { try { total += statSync(p).size; } catch { /* */ } }
    }
  };
  walk(dir);
  return Math.round(total / 1_048_576);
}

export async function checkNetwork(): Promise<NetCheck[]> {
  return Promise.all(HOSTS.map(async h => {
    try {
      const r = await fetch(`https://${h.host}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      // נטפרי מחזיר 418 לאתר חסום
      return { ...h, state: r.status === 418 ? 'blocked' : 'ok', status: r.status } as NetCheck;
    } catch { return { ...h, state: 'unreachable' } as NetCheck; }
  }));
}

export interface SystemReport { items: CheckItem[]; network: NetCheck[]; python: { path: string | null; version: string | null; fasterWhisper: string | null } }

export async function systemReport(opts: { dataDir: string; cloudflaredPath: string; pythonConfigured?: string }): Promise<SystemReport> {
  const items: CheckItem[] = [];
  const winVer = release();   // למשל 10.0.26300
  const build = Number(winVer.split('.')[2] ?? 0);
  items.push({ id: 'windows', name: 'Windows', required: true, state: process.platform !== 'win32' ? 'error' : build >= 17763 ? 'ok' : 'old', detail: process.platform === 'win32' ? `גרסה ${winVer}` : 'המערכת נתמכת רק ב-Windows' });

  let freeGb = 0;
  try { const s = statfsSync(opts.dataDir); freeGb = Math.round((s.bavail * s.bsize) / 1e9 * 10) / 10; } catch { /* */ }
  items.push({ id: 'disk', name: 'מקום פנוי בדיסק', required: true, state: freeGb >= 4 ? 'ok' : 'old', detail: `${freeGb} GB פנויים (נדרשים כ-4 GB למודל התמלול ולרכיבים)` });

  items.push({ id: 'node', name: 'Node.js', required: true, state: 'ok', detail: `${process.version} (כלול בהתקנה)` });

  const auth = await claudeAuth();
  items.push({ id: 'claude', name: 'Claude Code', required: true, state: sdkClaudeExe() ? 'ok' : 'missing', detail: sdkClaudeExe() ? 'כלול בהתקנה' : 'רכיב Claude חסר; התקן מחדש' });
  items.push({ id: 'claudeAuth', name: 'התחברות ל-Claude', required: true, state: auth.loggedIn ? 'ok' : 'missing', detail: auth.detail });

  const py = await findPython(opts.pythonConfigured);
  items.push({ id: 'python', name: 'Python (לתמלול)', required: true, state: py.path ? 'ok' : 'missing', detail: py.path ? `גרסה ${py.version}` : 'לא נמצא Python 3.10 ומעלה', installable: !py.path, sizeMb: 26 });
  items.push({ id: 'fasterWhisper', name: 'רכיב התמלול faster-whisper', required: true, state: py.fasterWhisper ? 'ok' : 'missing', detail: py.fasterWhisper ? `גרסה ${py.fasterWhisper}` : 'לא מותקן', installable: !py.fasterWhisper, sizeMb: 120 });
  const model = modelPresent();
  items.push({ id: 'model', name: 'מודל תמלול עברית (ivrit-ai)', required: true, state: model ? 'ok' : 'missing', detail: model ? 'הורד' : 'לא הורד', installable: !model, sizeMb: 1600 });
  const cf = existsSync(opts.cloudflaredPath);
  items.push({ id: 'cloudflared', name: 'רכיב המנהרה (cloudflared)', required: true, state: cf ? 'ok' : 'missing', detail: cf ? 'קיים' : 'חסר', installable: !cf, sizeMb: 60 });

  const git = await run('git', ['--version'], 10_000);
  items.push({ id: 'git', name: 'Git (לא חובה)', required: false, state: git.code === 0 ? 'ok' : 'optional', detail: git.code === 0 ? git.out : 'לא מותקן. מומלץ, כדי ש-Claude ינהל היסטוריית שינויים בפרויקטים' });

  return { items, network: await checkNetwork(), python: py };
}
