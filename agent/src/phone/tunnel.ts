// מנהרת Cloudflare מהירה (נבדקה בשלב 0): נותנת כתובת https ציבורית לשרת המקומי, בלי שרת חיצוני.
// הכתובת מתחלפת בכל הפעלה, ולכן אחרי כל חיבור הסוכן מעדכן את api_link של השלוחה בימות.
import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../log.ts';

export interface Tunnel { url: string; stop: () => void; onExit: (cb: (code: number | null) => void) => void; }

export function startQuickTunnel(cloudflaredPath: string, localPort: number, timeoutMs = 60_000): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cloudflaredPath, ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'], { windowsHide: true });
    let done = false;
    const exitCbs: ((code: number | null) => void)[] = [];
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new Error('המנהרה לא נפתחה בזמן')); } }, timeoutMs);
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) {
        done = true; clearTimeout(timer);
        log('tunnel', 'מנהרה פתוחה:', m[0]);
        resolve({ url: m[0], stop: () => child.kill(), onExit: cb => exitCbs.push(cb) });
      }
      if (/Registered tunnel connection/.test(s)) log('tunnel', 'חיבור נרשם');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('exit', code => {
      log('tunnel', 'cloudflared יצא, קוד', String(code));
      if (!done) { done = true; clearTimeout(timer); reject(new Error('cloudflared יצא לפני שנפתחה מנהרה')); }
      for (const cb of exitCbs) cb(code);
    });
  });
}
