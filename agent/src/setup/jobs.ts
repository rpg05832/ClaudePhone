// אשף ההגדרה: הורדה והתקנה של רכיבים חסרים, רק אחרי אישור המשתמש (אפיון 7). כל עבודה מדווחת התקדמות.
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, chmodSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PYTHON_URL, CLOUDFLARED_URL, MODEL_ID, STANDALONE_PYTHON_API, findPython, modelDir, dirSizeMb, modelPresent, sdkClaudeExe, claudeAuth, run, privatePythonDir, privatePythonExe } from './checks.ts';
import { isWin } from '../platform.ts';
import { log } from '../log.ts';

export type InstallItem = 'python' | 'fasterWhisper' | 'model' | 'cloudflared';

export interface JobStep { id: string; name: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; progress: number | null; detail: string }
export interface Job {
  id: string; kind: 'install' | 'claudeLogin'; state: 'running' | 'done' | 'failed'; steps: JobStep[]; error: string | null; startedAt: string;
  /** לינוקס: כתובת ההתחברות ל-Claude, לפתיחה בכל מחשב (גם כשהסוכן רץ על שרת בלי מסך), והאם מחכים לקוד. */
  loginUrl?: string | null;
  needsCode?: boolean;
}

const NAMES: Record<InstallItem, string> = {
  python: 'Python 3.12', fasterWhisper: 'רכיב התמלול faster-whisper', model: 'מודל תמלול עברית (כ-1.6 GB)', cloudflared: 'רכיב המנהרה',
};
const ORDER: InstallItem[] = ['cloudflared', 'python', 'fasterWhisper', 'model'];

export interface JobContext {
  cloudflaredPath: string;
  /** נקרא כשנמצא Python מתאים, כדי לשמור את הנתיב בהגדרות. */
  onPython: (path: string) => void;
  pythonConfigured?: string;
  /** תיקיית הסוכן (בבדיקות: תיקייה זמנית). */
  root?: string;
}

export class SetupJobs {
  private jobs = new Map<string, Job>();
  private loginChild = new Map<string, import('node:child_process').ChildProcess>();

  get(id: string): Job | null { return this.jobs.get(id) ?? null; }

  /** אין שתי התקנות במקביל. */
  running(): Job | null { return [...this.jobs.values()].find(j => j.state === 'running') ?? null; }

  startInstall(items: InstallItem[], ctx: JobContext): Job {
    const existing = this.running();
    if (existing) return existing;
    const list = ORDER.filter(i => items.includes(i));
    const job: Job = { id: randomUUID(), kind: 'install', state: 'running', error: null, startedAt: new Date().toISOString(),
      steps: list.map(i => ({ id: i, name: NAMES[i], state: 'pending', progress: null, detail: '' })) };
    this.jobs.set(job.id, job);
    void this.runInstall(job, ctx);
    return job;
  }

  private async runInstall(job: Job, ctx: JobContext) {
    let python = ctx.pythonConfigured;
    for (const step of job.steps) {
      step.state = 'running';
      try {
        switch (step.id as InstallItem) {
          case 'cloudflared': {
            mkdirSync(dirname(ctx.cloudflaredPath), { recursive: true });
            await download(CLOUDFLARED_URL, ctx.cloudflaredPath, p => { step.progress = p; });
            if (!isWin) chmodSync(ctx.cloudflaredPath, 0o755);
            step.detail = 'הורד';
            break;
          }
          case 'python': {
            if (!isWin) {
              const found = await installStandalonePython(step, ctx.root);
              python = found; ctx.onPython(found);
              break;
            }
            const exe = join(tmpdir(), 'python-3.12-setup.exe');
            step.detail = 'מוריד';
            await download(PYTHON_URL, exe, p => { step.progress = p * 0.6; });
            step.detail = 'מתקין (התקנה למשתמש הנוכחי, בלי הרשאות מנהל)';
            step.progress = 0.7;
            const r = await run(exe, ['/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=0', 'Include_test=0', 'Include_doc=0'], 15 * 60_000);
            try { unlinkSync(exe); } catch { /* */ }
            if (r.code !== 0) throw new Error(`התקנת Python נכשלה (קוד ${r.code})`);
            const found = await findPython();
            if (!found.path) throw new Error('Python הותקן אבל לא נמצא');
            python = found.path; ctx.onPython(found.path);
            step.detail = `הותקן: ${found.version}`; step.progress = 1;
            break;
          }
          case 'fasterWhisper': {
            let found = await findPython(python);
            // לינוקס: מתקינים רק לתוך ה-Python הפרטי (ב-Python של ההפצה pip חסום, PEP 668). אם אין, מתקינים אותו קודם.
            if (!isWin && found.path !== privatePythonExe(ctx.root)) {
              if (!existsSync(privatePythonExe(ctx.root))) await installStandalonePython(step, ctx.root);
              found = { path: privatePythonExe(ctx.root), version: null, fasterWhisper: null };
            }
            if (!found.path) throw new Error('צריך קודם את Python');
            python = found.path; ctx.onPython(found.path);
            // av<19: גרסה 19 של PyAV (רכיב של faster-whisper) שוברת את פענוח השמע בהתקנות חדשות (נמצא 16.10.2026)
            step.detail = 'מתקין דרך pip'; step.progress = null;
            const userFlag = isWin && found.path !== privatePythonExe(ctx.root) ? ['--user'] : [];
            const r = await runStreaming(found.path, ['-m', 'pip', 'install', ...userFlag, '--disable-pip-version-check', 'faster-whisper', 'av<19', 'truststore'], line => {
              const m = line.match(/(Collecting|Downloading|Installing collected packages)\s*(\S+)?/);
              if (m) step.detail = m[0].slice(0, 80);
            }, 30 * 60_000);
            if (r !== 0) throw new Error('התקנת faster-whisper נכשלה. ייתכן שנטפרי חוסם את pypi.org');
            step.detail = 'הותקן';
            break;
          }
          case 'model': {
            const found = await findPython(python);
            if (!found.path || !found.fasterWhisper) throw new Error('צריך קודם את רכיב התמלול');
            const dir = modelDir();
            const expected = 1600;
            const timer = setInterval(() => { step.progress = Math.min(0.99, dirSizeMb(dir) / expected); step.detail = `${dirSizeMb(dir)} MB מתוך כ-${expected}`; }, 2000);
            try {
              // truststore: אישורי האבטחה של Windows (נדרש מאחורי סינון כמו נטפרי)
              const code = `try:\n    import truststore; truststore.inject_into_ssl()\nexcept Exception:\n    pass\nfrom huggingface_hub import snapshot_download\nsnapshot_download("${MODEL_ID}")\nprint("ok")`;
              const r = await runStreaming(found.path, ['-c', code], () => {}, 60 * 60_000);
              if (r !== 0 || !modelPresent()) throw new Error('הורדת המודל נכשלה. ייתכן שנטפרי חוסם את huggingface.co');
            } finally { clearInterval(timer); }
            step.detail = 'הורד'; step.progress = 1;
            break;
          }
        }
        step.state = 'done'; step.progress = 1;
        log('setup', `הותקן: ${step.name}`);
      } catch (e) {
        step.state = 'failed';
        step.detail = e instanceof Error ? e.message : String(e);
        job.state = 'failed'; job.error = step.detail;
        for (const s of job.steps) if (s.state === 'pending') s.state = 'skipped';
        log('setup', `נכשל: ${step.name}: ${step.detail}`);
        return;
      }
    }
    job.state = 'done';
  }

  /** לינוקס: הקוד שהמשתמש העתיק מדף האישור של Claude. */
  submitLoginCode(jobId: string, code: string): boolean {
    const child = this.loginChild.get(jobId);
    const clean = code.trim();
    if (!child || !child.stdin || !clean || clean.length > 400 || /\s/.test(clean)) return false;
    child.stdin.write(clean + '\n');
    const job = this.jobs.get(jobId);
    if (job) job.steps[0].detail = 'בודק את הקוד…';
    return true;
  }

  /** התחברות ל-Claude: פותח את דף ההתחברות בדפדפן, והמשתמש מאשר בעצמו. האשף לא רואה סיסמה. */
  startClaudeLogin(): Job {
    const existing = [...this.jobs.values()].find(j => j.kind === 'claudeLogin' && j.state === 'running');
    if (existing) return existing;
    const job: Job = { id: randomUUID(), kind: 'claudeLogin', state: 'running', error: null, startedAt: new Date().toISOString(),
      steps: [{ id: 'login', name: 'התחברות ל-Claude', state: 'running', progress: null, detail: 'נפתח דף התחברות בדפדפן. אשר שם את החיבור' }] };
    this.jobs.set(job.id, job);
    const exe = sdkClaudeExe();
    if (!exe) { job.state = 'failed'; job.error = 'רכיב Claude לא נמצא'; job.steps[0].state = 'failed'; return job; }
    // Windows: כמו קודם (הדפדפן נפתח לבד). לינוקס: קוראים את הכתובת מהפלט ומציגים אותה בלוח, ואת הקוד שהמשתמש מעתיק
    // מדף האישור מעבירים ל-Claude. כך ההתחברות עובדת גם בשרת בלי מסך (הלוח נפתח ממחשב אחר).
    const child = isWin
      ? spawn(exe, ['auth', 'login'], { windowsHide: false, detached: false, stdio: 'ignore' })
      : spawn(exe, ['auth', 'login'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BROWSER: process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? process.env.BROWSER ?? '' : 'false' } });
    if (!isWin) {
      this.loginChild.set(job.id, child);
      job.loginUrl = null; job.needsCode = false;
      let buf = '';
      const onOut = (b: Buffer) => {
        buf += b.toString();
        const url = buf.match(/https:\/\/\S+\/oauth\/authorize\?\S+/)?.[0];
        if (url && !job.loginUrl) { job.loginUrl = url; job.steps[0].detail = 'פתח את הקישור (בכל מחשב או טלפון), אשר, והדבק כאן את הקוד שמוצג'; }
        if (/paste code/i.test(buf)) job.needsCode = true;
        if (/invalid code/i.test(b.toString())) job.steps[0].detail = 'הקוד לא התקבל. העתק אותו שוב במלואו';
      };
      child.stdout!.on('data', onOut); child.stderr!.on('data', onOut);
      child.on('close', () => this.loginChild.delete(job.id));
    }
    const deadline = Date.now() + 10 * 60_000;
    const poll = setInterval(async () => {
      const a = await claudeAuth();
      if (a.loggedIn) {
        clearInterval(poll); job.state = 'done'; job.steps[0].state = 'done'; job.steps[0].detail = a.detail;
        try { child.kill(); } catch { /* */ }
      } else if (Date.now() > deadline) {
        clearInterval(poll); job.state = 'failed'; job.error = 'ההתחברות לא הושלמה בתוך 10 דקות'; job.steps[0].state = 'failed';
        try { child.kill(); } catch { /* */ }
      }
    }, 3000);
    return job;
  }
}

async function download(url: string, dest: string, onProgress: (p: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (res.status === 418) throw new Error(`הכתובת חסומה בנטפרי: ${new URL(url).host}`);
  if (!res.ok || !res.body) throw new Error(`ההורדה נכשלה (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let got = 0;
  const tmp = dest + '.part';
  const body = Readable.fromWeb(res.body as any);
  body.on('data', (c: Buffer) => { got += c.length; if (total) onProgress(got / total); });
  await pipeline(body, createWriteStream(tmp));
  if (existsSync(dest)) unlinkSync(dest);
  renameSync(tmp, dest);
}

function runStreaming(cmd: string, args: string[], onLine: (l: string) => void, timeoutMs: number): Promise<number> {
  return new Promise(res => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const handle = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    child.stdout.on('data', handle); child.stderr.on('data', handle);
    child.on('close', code => { clearTimeout(timer); res(code ?? 1); });
    child.on('error', () => { clearTimeout(timer); res(1); });
  });
}

/** לינוקס: הורדת Python נייד (python-build-standalone) לתוך data/python. מחזיר את הנתיב לקובץ ההרצה. */
async function installStandalonePython(step: JobStep, root?: string): Promise<string> {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`אין Python נייד למעבד ${process.arch}`);
  step.detail = 'מחפש את הגרסה העדכנית';
  const asset = await resolveStandalonePython(arch);
  const tgz = join(tmpdir(), asset.name);
  step.detail = 'מוריד';
  await download(asset.browser_download_url, tgz, p => { step.progress = p * 0.8; });
  step.detail = 'פורס'; step.progress = 0.85;
  const dir = privatePythonDir(root);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const t = await run('tar', ['-xzf', tgz, '-C', dirname(dir)], 5 * 60_000);
  try { unlinkSync(tgz); } catch { /* */ }
  if (t.code !== 0 || !existsSync(privatePythonExe(root))) throw new Error('פריסת Python נכשלה' + (t.err ? `: ${t.err.slice(0, 120)}` : ''));
  const v = await run(privatePythonExe(root), ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], 30_000);
  step.detail = `הותקן: ${v.out || 'Python 3.12'}`; step.progress = 1;
  return privatePythonExe(root);
}

const PBS = 'https://github.com/astral-sh/python-build-standalone/releases';
/** גרסה ידועה (נבדקה 16.10.2026), אם אי אפשר לברר את העדכנית. */
const PBS_PINNED = { tag: '20261013', py: '3.12.15' };

/**
 * הקובץ להורדה: דף ה-Releases ב-github.com (בלי מגבלת הבדיקות של ה-API), ואם לא הצליח ה-API, ואם גם הוא לא:
 * הגרסה הידועה. ההורדה עצמה תמיד מ-github.com.
 */
async function resolveStandalonePython(arch: string): Promise<{ name: string; browser_download_url: string }> {
  const ua = { 'User-Agent': 'ClaudePhone-setup' };
  const url = (tag: string, name: string) => `${PBS}/download/${tag}/${encodeURIComponent(name)}`;
  try {
    const r = await fetch(`${PBS}/latest`, { redirect: 'manual', headers: ua, signal: AbortSignal.timeout(20_000) });
    if (r.status === 418) throw new Error('הכתובת חסומה בנטפרי: github.com');
    const tag = r.headers.get('location')?.match(/\/tag\/([\w.-]+)$/)?.[1];
    if (tag) {
      const html = await (await fetch(`${PBS}/expanded_assets/${tag}`, { headers: ua, signal: AbortSignal.timeout(30_000) })).text();
      const names = [...new Set(html.match(/cpython-3\.12\.\d+\+\d+-[\w]+-unknown-linux-gnu-install_only(?:_stripped)?\.tar\.gz/g) ?? [])];
      const a = pickStandaloneAsset(names.map(n => ({ name: n, browser_download_url: url(tag, n) })), arch);
      if (a) return a;
    }
  } catch (e) { if (e instanceof Error && e.message.includes('נטפרי')) throw e; }
  try {
    const r = await fetch(STANDALONE_PYTHON_API, { headers: { ...ua, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
    if (r.ok) { const j: any = await r.json(); const a = pickStandaloneAsset(Array.isArray(j.assets) ? j.assets : [], arch); if (a) return a; }
  } catch { /* הגרסה הידועה */ }
  const name = `cpython-${PBS_PINNED.py}+${PBS_PINNED.tag}-${arch}-unknown-linux-gnu-install_only_stripped.tar.gz`;
  return { name, browser_download_url: url(PBS_PINNED.tag, name) };
}

/** בחירת הקובץ המתאים מתוך ה-Release של python-build-standalone: 3.12, install_only, glibc, עדיף stripped. */
export function pickStandaloneAsset(assets: { name: string; browser_download_url: string }[], arch: string): { name: string; browser_download_url: string } | null {
  const re = (stripped: boolean) => new RegExp(`^cpython-3\\.12\\.\\d+\\+\\d+-${arch}-unknown-linux-gnu-install_only${stripped ? '_stripped' : ''}\\.tar\\.gz$`);
  return assets.find(a => re(true).test(a.name)) ?? assets.find(a => re(false).test(a.name)) ?? null;
}
