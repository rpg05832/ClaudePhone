// אשף ההגדרה: הורדה והתקנה של רכיבים חסרים, רק אחרי אישור המשתמש (אפיון 7). כל עבודה מדווחת התקדמות.
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PYTHON_URL, CLOUDFLARED_URL, MODEL_ID, findPython, modelDir, dirSizeMb, modelPresent, sdkClaudeExe, claudeAuth, run } from './checks.ts';
import { log } from '../log.ts';

export type InstallItem = 'python' | 'fasterWhisper' | 'model' | 'cloudflared';

export interface JobStep { id: string; name: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; progress: number | null; detail: string }
export interface Job { id: string; kind: 'install' | 'claudeLogin'; state: 'running' | 'done' | 'failed'; steps: JobStep[]; error: string | null; startedAt: string }

const NAMES: Record<InstallItem, string> = {
  python: 'Python 3.12', fasterWhisper: 'רכיב התמלול faster-whisper', model: 'מודל תמלול עברית (כ-1.6 GB)', cloudflared: 'רכיב המנהרה',
};
const ORDER: InstallItem[] = ['cloudflared', 'python', 'fasterWhisper', 'model'];

export interface JobContext {
  cloudflaredPath: string;
  /** נקרא כשנמצא Python מתאים, כדי לשמור את הנתיב בהגדרות. */
  onPython: (path: string) => void;
  pythonConfigured?: string;
}

export class SetupJobs {
  private jobs = new Map<string, Job>();

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
            step.detail = 'הורד';
            break;
          }
          case 'python': {
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
            const found = await findPython(python);
            if (!found.path) throw new Error('צריך קודם את Python');
            python = found.path; ctx.onPython(found.path);
            step.detail = 'מתקין דרך pip';
            const r = await runStreaming(found.path, ['-m', 'pip', 'install', '--user', '--disable-pip-version-check', 'faster-whisper', 'truststore'], line => {
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

  /** התחברות ל-Claude: פותח את דף ההתחברות בדפדפן, והמשתמש מאשר בעצמו. האשף לא רואה סיסמה. */
  startClaudeLogin(): Job {
    const existing = [...this.jobs.values()].find(j => j.kind === 'claudeLogin' && j.state === 'running');
    if (existing) return existing;
    const job: Job = { id: randomUUID(), kind: 'claudeLogin', state: 'running', error: null, startedAt: new Date().toISOString(),
      steps: [{ id: 'login', name: 'התחברות ל-Claude', state: 'running', progress: null, detail: 'נפתח דף התחברות בדפדפן. אשר שם את החיבור' }] };
    this.jobs.set(job.id, job);
    const exe = sdkClaudeExe();
    if (!exe) { job.state = 'failed'; job.error = 'רכיב Claude לא נמצא'; job.steps[0].state = 'failed'; return job; }
    const child = spawn(exe, ['auth', 'login'], { windowsHide: false, detached: false, stdio: 'ignore' });
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
