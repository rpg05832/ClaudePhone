// תמלול. שני מנועים מאחורי ממשק אחד (SmartTranscriber):
// - Claude (ברירת המחדל מ-0.7.4): שירות ההכתבה של Claude, עם ההתחברות של Claude Code (claude.ts). ההקלטה נשלחת ל-Anthropic.
// - ivrit-ai במחשב: תהליך Python קבוע עם faster-whisper (נמדד בשלב 0: פי 5 מזמן אמת). ההקלטה לא יוצאת מהמחשב.
// כל אחד הוא הגיבוי של השני.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { log } from '../log.ts';
import { normalizeSpelled } from './normalize.ts';
import { looksStuck } from './claude.ts';

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
        else {
          const raw = String(msg.text || '');
          const text = normalizeSpelled(raw);
          log('stt', `תומלל: ${msg.duration} שניות אודיו ב-${msg.seconds} שניות`);
          // איותים (מייל, קוד) מומרים לכתיב; המקור נשמר ביומן כדי לכוון את הכללים
          if (text !== raw) log('stt', `איות זוהה. מקור: "${raw}" | מנורמל: "${text}"`);
          p.resolve(text);
        }
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

/** 'claude': שירות ההכתבה של Claude, ו-ivrit-ai כגיבוי. 'local': ivrit-ai במחשב, ו-Claude כגיבוי. */
export type SttEngine = 'claude' | 'local';

/**
 * בוחר מנוע תמלול לפי ההגדרה (נקראת בכל תמלול, כך ששינוי בלוח חל מיד), ועובר לשני כשהראשון נכשל,
 * מחזיר טקסט ריק, או (ב-Claude) נתקע על חזרה. כשאין גיבוי: שגיאה, או הטקסט של Claude כמו שהוא (המשתמש שומע אותו לאישור).
 */
export class SmartTranscriber implements Transcriber {
  /** המנוע שתמלל לאחרונה (ללוח הבקרה) */
  lastEngine: SttEngine | null = null;
  constructor(
    private engine: () => SttEngine,
    private claude: { available(): boolean; transcribeWav(buf: Buffer): Promise<{ text: string; seconds: number }> },
    private local: { transcribe(path: string): Promise<string>; warmup?(): Promise<void>; stop(): void; ready: boolean },
    private readFile: (path: string) => Buffer,
    private localInstalled: () => boolean,
  ) {}

  /** מוכן לתמלל: Claude מחובר, או ivrit-ai טעון. */
  get ready(): boolean { return this.engine() === 'claude' ? this.claude.available() || this.local.ready : this.local.ready || this.claude.available(); }

  status(): { ok: boolean; engine: SttEngine; detail: string } {
    const e = this.engine();
    const claudeOk = this.claude.available();
    const local = this.local.ready ? 'ivrit-ai טעון' : this.localInstalled() ? 'ivrit-ai מותקן' : 'ivrit-ai לא מותקן';
    if (e === 'claude') return { ok: claudeOk || this.local.ready, engine: e, detail: claudeOk ? `Claude מחובר · גיבוי: ${local}` : `אין התחברות של Claude Code · ${local}` };
    return { ok: this.local.ready || claudeOk, engine: e, detail: this.local.ready ? `ivrit-ai טעון · גיבוי: ${claudeOk ? 'Claude' : 'אין'}` : `${local}${claudeOk ? ' · גיבוי: Claude' : ''}` };
  }

  async warmup(): Promise<void> { if (this.engine() === 'local' && this.localInstalled()) await this.local.warmup?.(); }

  private async viaClaude(path: string): Promise<{ text: string; stuck: boolean }> {
    const t0 = Date.now();
    const r = await this.claude.transcribeWav(this.readFile(path));
    const stuck = looksStuck(r.text, r.seconds);
    log('stt', `Claude תמלל ${r.seconds.toFixed(1)} שניות אודיו ב-${((Date.now() - t0) / 1000).toFixed(1)} שניות${stuck ? ' (נתקע על חזרה)' : ''}`);
    return { text: r.text, stuck };
  }

  async transcribe(path: string): Promise<string> {
    const first = this.engine();
    const localOk = this.localInstalled();
    if (first === 'claude' && this.claude.available()) {
      let fallbackText = '';
      try {
        const r = await this.viaClaude(path);
        if (r.text && !r.stuck) { this.lastEngine = 'claude'; return normalizeSpelled(r.text); }
        fallbackText = r.stuck ? r.text : '';
        if (!localOk) { this.lastEngine = 'claude'; return normalizeSpelled(r.text); }
        log('stt', r.text ? 'עובר ל-ivrit-ai (התמלול של Claude נתקע)' : 'עובר ל-ivrit-ai (Claude לא זיהה דיבור)');
      } catch (e) {
        if (!localOk) throw e;
        log('stt', `עובר ל-ivrit-ai: ${e instanceof Error ? e.message : String(e)}`);
      }
      try { const t = await this.local.transcribe(path); this.lastEngine = 'local'; return t; }
      catch (e) { if (fallbackText) { this.lastEngine = 'claude'; return normalizeSpelled(fallbackText); } throw e; }
    }
    if (localOk) {
      try { const t = await this.local.transcribe(path); this.lastEngine = 'local'; return t; }
      catch (e) {
        if (!this.claude.available()) throw e;
        log('stt', `עובר לתמלול של Claude: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!this.claude.available()) throw new Error('אין מנוע תמלול זמין: אין התחברות של Claude Code, ו-ivrit-ai לא מותקן');
    const r = await this.viaClaude(path);
    this.lastEngine = 'claude';
    return normalizeSpelled(r.text);
  }

  stop(): void { this.local.stop(); }
}
