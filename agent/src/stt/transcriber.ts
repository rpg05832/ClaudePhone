// תמלול. שלושה מנועים מאחורי ממשק אחד (SmartTranscriber):
// - Groq (ברירת המחדל מ-0.7.8): Whisper על השרתים של Groq, במדרגה החינמית, עם מפתח API (groq.ts). ההקלטה נשלחת ל-Groq.
// - Claude (ברירת המחדל מ-0.7.4 עד 0.7.7): שירות ההכתבה של Claude, עם ההתחברות של Claude Code (claude.ts). ההקלטה נשלחת ל-Anthropic.
// - ivrit-ai במחשב: תהליך Python קבוע עם faster-whisper (נמדד בשלב 0: פי 5 מזמן אמת). ההקלטה לא יוצאת מהמחשב.
// המנוע שנבחר ראשון, והשאר גיבוי לפי הסדר Groq, Claude, ivrit-ai.
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

/** 'groq': Whisper ב-Groq (חינמי, ברירת המחדל מ-0.7.8). 'claude': שירות ההכתבה של Claude. 'local': ivrit-ai במחשב. השאר גיבוי. */
export type SttEngine = 'groq' | 'claude' | 'local';
const ENGINE_NAMES: Record<SttEngine, string> = { groq: 'Groq', claude: 'Claude', local: 'ivrit-ai' };
/** סדר הגיבויים (אחרי המנוע שנבחר): Groq, Claude, ivrit-ai */
const ENGINE_ORDER: SttEngine[] = ['groq', 'claude', 'local'];

type CloudStt = { available(): boolean; transcribeWav(buf: Buffer): Promise<{ text: string; seconds: number }> };

/**
 * בוחר מנוע תמלול לפי ההגדרה (נקראת בכל תמלול, כך ששינוי בלוח חל מיד), ועובר לבא בתור כשהראשון נכשל,
 * מחזיר טקסט ריק, או נתקע על חזרה. כשאין עוד גיבוי: שגיאה, או הטקסט שהתקבל כמו שהוא (המשתמש שומע אותו לאישור).
 */
export class SmartTranscriber implements Transcriber {
  /** המנוע שתמלל לאחרונה (ללוח הבקרה) */
  lastEngine: SttEngine | null = null;
  constructor(
    private engine: () => SttEngine,
    private claude: CloudStt,
    private local: { transcribe(path: string): Promise<string>; warmup?(): Promise<void>; stop(): void; ready: boolean },
    private readFile: (path: string) => Buffer,
    private localInstalled: () => boolean,
    private groq: CloudStt | null = null,
  ) {}

  private availableOf(e: SttEngine): boolean {
    if (e === 'groq') return !!this.groq?.available();
    if (e === 'claude') return this.claude.available();
    return this.localInstalled();
  }

  /** המנועים הזמינים, לפי הסדר: הנבחר ראשון, ואחריו הגיבויים. */
  order(): SttEngine[] {
    const first = this.engine();
    return [first, ...ENGINE_ORDER.filter(e => e !== first)].filter(e => this.availableOf(e));
  }

  /** מוכן לתמלל: יש מנוע ענן עם התחברות או מפתח, או ivrit-ai טעון. */
  get ready(): boolean { return this.order().some(e => e !== 'local' || this.local.ready); }

  status(): { ok: boolean; engine: SttEngine; detail: string } {
    const e = this.engine();
    const order = this.order();
    const name = (x: SttEngine) => x === 'local' ? (this.local.ready ? 'ivrit-ai טעון' : 'ivrit-ai מותקן') : ENGINE_NAMES[x];
    const missing = (x: SttEngine) => x === 'groq' ? 'Groq: אין מפתח' : x === 'claude' ? 'אין התחברות של Claude Code' : 'ivrit-ai לא מותקן';
    const backups = order.filter(x => x !== e).map(name);
    if (!order.length) return { ok: false, engine: e, detail: `אין מנוע תמלול: ${ENGINE_ORDER.map(missing).join(' · ')}` };
    if (order[0] === e) return { ok: true, engine: e, detail: `${name(e)}${backups.length ? ' · גיבוי: ' + backups.join(', ') : ' · אין גיבוי'}` };
    return { ok: true, engine: e, detail: `${missing(e)} · מתמלל ב-${name(order[0])}${backups.length > 1 ? ' · גיבוי: ' + backups.slice(1).join(', ') : ''}` };
  }

  async warmup(): Promise<void> { if (this.engine() === 'local' && this.localInstalled()) await this.local.warmup?.(); }

  /** תמלול במנוע אחד. stuck: חזרה אינסופית (מנועי ענן) שנחשבת כישלון אם יש גיבוי. */
  private async run(e: SttEngine, path: string): Promise<{ text: string; stuck: boolean }> {
    if (e === 'local') return { text: await this.local.transcribe(path), stuck: false };
    const t0 = Date.now();
    const r = await (e === 'groq' ? this.groq! : this.claude).transcribeWav(this.readFile(path));
    const stuck = looksStuck(r.text, r.seconds);
    log('stt', `${ENGINE_NAMES[e]} תמלל ${r.seconds.toFixed(1)} שניות אודיו ב-${((Date.now() - t0) / 1000).toFixed(1)} שניות${stuck ? ' (נתקע על חזרה)' : ''}`);
    return { text: r.text, stuck };
  }

  async transcribe(path: string): Promise<string> {
    const order = this.order();
    if (!order.length) throw new Error('אין מנוע תמלול זמין: אין מפתח Groq, אין התחברות של Claude Code, ו-ivrit-ai לא מותקן');
    let stuckText = '';
    for (let i = 0; i < order.length; i++) {
      const e = order[i];
      const last = i === order.length - 1;
      try {
        const r = await this.run(e, path);
        if (r.text && !r.stuck) { this.lastEngine = e; return normalizeSpelled(r.text); }
        if (r.stuck && !stuckText) stuckText = r.text;
        if (last) { this.lastEngine = e; return normalizeSpelled(stuckText || r.text); }
        log('stt', `עובר ל-${ENGINE_NAMES[order[i + 1]]} (${r.text ? `התמלול של ${ENGINE_NAMES[e]} נתקע` : `${ENGINE_NAMES[e]} לא זיהה דיבור`})`);
      } catch (err) {
        if (last) {
          if (stuckText) { this.lastEngine = order.find(x => x !== 'local') ?? e; return normalizeSpelled(stuckText); }
          throw err;
        }
        log('stt', `עובר ל-${ENGINE_NAMES[order[i + 1]]}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error('התמלול נכשל');
  }

  stop(): void { this.local.stop(); }
}
