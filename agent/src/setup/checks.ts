// אשף ההגדרה: בדיקת המחשב (אפיון 7). קריאה בלבד: שום דבר לא מותקן כאן.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statfsSync, statSync, lstatSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, release } from 'node:os';
import { AGENT_ROOT } from '../config.ts';
import { isWin, isLinux, osName, sdkBinaryPackage, cloudflaredUrl, windowsPythonDirs } from '../platform.ts';

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
export const CLOUDFLARED_URL = cloudflaredUrl();
/** לינוקס: Python נייד (python-build-standalone) שמותקן בתוך תיקיית הנתונים, בלי sudo ובלי תלות בהפצה. */
export const STANDALONE_PYTHON_API = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';
export function privatePythonDir(root = AGENT_ROOT): string { return join(root, 'data', 'python'); }
export function privatePythonExe(root = AGENT_ROOT): string { return isWin ? join(privatePythonDir(root), 'python.exe') : join(privatePythonDir(root), 'bin', 'python3'); }

/** הכתובות שהמערכת צריכה (לבקשת פתיחה בנטפרי אם חסומות). */
export const HOSTS: { host: string; purpose: string }[] = [
  { host: 'api.anthropic.com', purpose: 'Claude' },
  { host: 'claude.ai', purpose: 'התחברות ל-Claude' },
  { host: 'www.call2all.co.il', purpose: 'ימות המשיח' },
  { host: 'huggingface.co', purpose: 'הורדת מודל התמלול' },
  { host: 'github.com', purpose: 'הורדת רכיב המנהרה' },
  ...(isWin ? [{ host: 'www.python.org', purpose: 'הורדת Python' }] : [{ host: 'api.github.com', purpose: 'הורדת Python' }]),
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
  const b = sdkBinaryPackage();
  const d = packageDir(b.pkg);
  const exe = d ? join(d, b.file) : null;
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
  if (existsSync(privatePythonExe())) cands.push([privatePythonExe(), []]);
  if (isWin) {
    for (const exe of windowsPythonDirs()) cands.push([exe, []]);
    cands.push(['python', []], ['py', ['-3']]);
  } else {
    cands.push(['python3', []], ['python', []]);
  }
  let first: { path: string; version: string; fasterWhisper: string | null } | null = null;
  const seen = new Set<string>();
  for (const [cmd, pre] of cands) {
    const r = await run(cmd, [...pre, '-c', 'import sys;print(sys.executable);print("%d.%d.%d"%sys.version_info[:3])'], 15_000);
    if (r.code !== 0 || !r.out) continue;
    const [exe, ver] = r.out.split(/\r?\n/);
    const k = isWin ? exe.toLowerCase() : exe;
    if (!exe || seen.has(k)) continue;
    seen.add(k);
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
  items.push(osCheck());

  let freeGb = 0;
  try { const s = statfsSync(opts.dataDir); freeGb = Math.round((s.bavail * s.bsize) / 1e9 * 10) / 10; } catch { /* */ }
  items.push({ id: 'disk', name: 'מקום פנוי בדיסק', required: true, state: freeGb >= 1 ? 'ok' : 'old', detail: `${freeGb} GB פנויים (נדרש כ-1 GB; עוד כ-2 GB אם מתקינים את גיבוי התמלול ivrit-ai)` });

  items.push({ id: 'node', name: 'Node.js', required: true, state: 'ok', detail: `${process.version} (כלול בהתקנה)` });

  const auth = await claudeAuth();
  items.push({ id: 'claude', name: 'Claude Code', required: true, state: sdkClaudeExe() ? 'ok' : 'missing', detail: sdkClaudeExe() ? 'כלול בהתקנה' : 'רכיב Claude חסר; התקן מחדש' });
  items.push({ id: 'claudeAuth', name: 'התחברות ל-Claude', required: true, state: auth.loggedIn ? 'ok' : 'missing', detail: auth.detail });

  const py = await findPython(opts.pythonConfigured);
  // 0.7.4: התמלול נעשה דרך Claude (ההתחברות של Claude Code). ivrit-ai במחשב הוא גיבוי, ולכן שלושת הרכיבים שלו רשות.
  items.push({ id: 'python', name: 'Python (לגיבוי התמלול, רשות)', required: false, state: py.path ? 'ok' : 'missing', detail: py.path ? `גרסה ${py.version}` : 'לא נמצא Python 3.10 ומעלה', installable: !py.path, sizeMb: isWin ? 26 : 32 });
  items.push({ id: 'fasterWhisper', name: 'רכיב התמלול faster-whisper (גיבוי, רשות)', required: false, state: py.fasterWhisper ? 'ok' : 'missing', detail: py.fasterWhisper ? `גרסה ${py.fasterWhisper}` : 'לא מותקן', installable: !py.fasterWhisper, sizeMb: 120 });
  const model = modelPresent();
  items.push({ id: 'model', name: 'מודל תמלול עברית ivrit-ai (גיבוי, רשות)', required: false, state: model ? 'ok' : 'missing', detail: model ? 'הורד' : 'לא הורד', installable: !model, sizeMb: 1600 });
  const cf = existsSync(opts.cloudflaredPath);
  items.push({ id: 'cloudflared', name: 'רכיב המנהרה (cloudflared)', required: true, state: cf ? 'ok' : 'missing', detail: cf ? 'קיים' : 'חסר', installable: !cf, sizeMb: 60 });

  const git = await run('git', ['--version'], 10_000);
  items.push({ id: 'git', name: 'Git (לא חובה)', required: false, state: git.code === 0 ? 'ok' : 'optional', detail: git.code === 0 ? git.out : 'לא מותקן. מומלץ, כדי ש-Claude ינהל היסטוריית שינויים בפרויקטים' });

  return { items, network: await checkNetwork(), python: py };
}

/** בדיקת מערכת ההפעלה: Windows 10 1809 ומעלה, או לינוקס 64 ביט (x64/arm64) עם glibc. */
export function osCheck(platform = process.platform, rel = release(), arch = process.arch, musl?: boolean): CheckItem {
  if (platform === 'win32') {
    const build = Number(rel.split('.')[2] ?? 0);
    return { id: 'os', name: 'Windows', required: true, state: build >= 17763 ? 'ok' : 'old', detail: `גרסה ${rel}` };
  }
  if (platform === 'linux') {
    const okArch = arch === 'x64' || arch === 'arm64';
    const m = musl ?? (() => { try { return !(process.report?.getReport() as any)?.header?.glibcVersionRuntime; } catch { return false; } })();
    if (!okArch) return { id: 'os', name: 'לינוקס', required: true, state: 'error', detail: `מעבד ${arch} לא נתמך (נדרש x64 או arm64)` };
    if (m) return { id: 'os', name: 'לינוקס', required: true, state: 'error', detail: 'הפצה מבוססת musl (כמו Alpine) לא נתמכת. נדרשת הפצה רגילה (Ubuntu, Debian, Fedora וכו\')' };
    return { id: 'os', name: 'לינוקס', required: true, state: 'ok', detail: `${linuxDistro() ?? 'לינוקס'} · ${arch}` };
  }
  return { id: 'os', name: osName(), required: true, state: 'error', detail: 'המערכת נתמכת ב-Windows ובלינוקס' };
}

/** שם ההפצה מ-/etc/os-release. */
export function linuxDistro(): string | null {
  if (!isLinux) return null;
  try { return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? null; } catch { return null; }
}
