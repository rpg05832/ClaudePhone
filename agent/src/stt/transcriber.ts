// תמלול מקומי: תהליך Python קבוע עם faster-whisper + ivrit-ai (נמדד בשלב 0: פי 5 מזמן אמת).
// ההקלטות לא יוצאות מהמחשב. ממשק אחד, כך שאפשר להחליף בעתיד לספק אחר.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { log } from '../log.ts';

export interface Transcriber { transcribe(path: string): Promise<string>; stop(): void; }

export class WhisperTranscriber implements Transcriber {
  private child: ChildProcess | null = null;
  /** המודל טעון ומוכן (לשורת המצב בלוח הבקרה). */
  ready = false;
  private readyP: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private python: string, private script: string, private model: string, private timeoutSeconds = 180) {}

  private start(): Promise<void> {
    if (this.readyP) return this.readyP;
    this.readyP = new Promise((resolve, reject) => {
      log('stt', 'מפעיל תהליך תמלול', this.model);
      const child = spawn(this.python, [this.script, this.model], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      this.child = child;
      let gotReady = false;
      const rl = createInterface({ input: child.stdout! });
      rl.on('line', line => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return log('stt', 'פלט:', line.slice(0, 200)); }
        if ('ready' in msg) {
          gotReady = true;
          if (msg.ready) { this.ready = true; log('stt', `המודל נטען (${msg.load_seconds} שניות)`); resolve(); }
          else reject(new Error('טעינת מודל התמלול נכשלה: ' + msg.error));
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else { log('stt', `תומלל: ${msg.duration} שניות אודיו ב-${msg.seconds} שניות`); p.resolve(msg.text || ''); }
      });
      child.stderr?.on('data', d => { const s = d.toString().trim(); if (s && !/UserWarning|warn/i.test(s)) log('stt', 'stderr:', s.slice(0, 300)); });
      child.on('error', e => { if (!gotReady) reject(e); });
      child.on('exit', code => {
        log('stt', 'תהליך התמלול יצא, קוד', String(code));
        if (!gotReady) reject(new Error('תהליך התמלול יצא לפני שנטען'));
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('תהליך התמלול נעצר')); }
        this.pending.clear();
        this.child = null; this.ready = false; this.readyP = null;   // הפעלה מחדש בבקשה הבאה
      });
    });
    return this.readyP;
  }

  /** טעינה מוקדמת בהפעלת הסוכן, כדי שהשיחה הראשונה לא תחכה לטעינת המודל. */
  async warmup(): Promise<void> { await this.start(); }

  async transcribe(path: string): Promise<string> {
    await this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('התמלול חרג מהזמן')); }, this.timeoutSeconds * 1000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, path }) + '\n');
    });
  }

  stop(): void { this.child?.kill(); }
}
