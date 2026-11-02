// הקול המשופר (0.7.8): במקום שימות יקריאו טקסט במנוע שלהם (t-), הטקסט מופק בקול של Gemini לקובץ WAV, מועלה לתת-תיקייה
// של השלוחה, ומושמע כקובץ (f-). הכל חינמי, ולכן חסכוני במכסה:
// - מטמון: לכל טקסט (לפי hash של הקול+הטקסט) קובץ אחד בימות. הודעות קבועות (תפריטים) מופקות פעם אחת.
// - הקבצים הישנים ביותר נמחקים מימות כשעוברים את המכסה (maxFiles), כי בימות מותר לשמור רק קבצים שמושמעים בפועל
//   (f2.freeivr.co.il/post/121900: עד 3,000 קבצים בתיקייה; קבצים שלא בשימוש נמחקים).
// - נפילה לקול של ימות: אין מפתח, Gemini נכשל, המכסה נגמרה (ואז הפסקה של כמה דקות), או שההפקה איטית מדי
//   (timeoutMs): התשובה לימות חוזרת עם t- והטקסט מופק ברקע לפעם הבאה.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { log, logError } from '../log.ts';
import { GeminiModelError } from './gemini.ts';

export interface SpeechDeps {
  /** האם הקול המשופר מופעל (הגדרה; נקראת בכל הקראה). */
  enabled: () => boolean;
  /** הקול של Gemini (הגדרה). */
  voice: () => string;
  /** סגנון ההקראה (מהירות, למשל), או ריק. */
  style?: () => string;
  gemini: { available(): boolean; synthesize(text: string, voice: string, style?: string): Promise<{ wav: Buffer; seconds: number; model: string }> };
  yemot: {
    /** מעלה קובץ לנתיב ivr2:... */
    uploadFile(path: string, wav: Buffer): Promise<void>;
    deleteFile(path: string): Promise<void>;
    /** יוצר את תת-התיקייה אם אינה קיימת */
    ensureFolder(folder: string): Promise<void>;
  };
  /** השלוחה (למשל "9") ושם תת-התיקייה (למשל "tts"): הקבצים ב-/9/tts/<hash>.wav */
  extension: () => string;
  folder: string;
  /** קובץ המטמון במחשב (data/tts-cache.json), כדי לא להפיק מחדש אחרי הפעלה */
  cacheFile?: string;
  maxFiles?: number;
  /** כמה זמן מחכים להפקה לפני שחוזרים לקול של ימות (ברירת מחדל 7 שניות) */
  timeoutMs?: number;
  /** קובץ שהועלה לפני יותר מזה מופק מחדש (ימות מוחקים קבצים שלא בשימוש) */
  refreshDays?: number;
  /** הפסקה אחרי כישלון: מכסה (429) או שגיאה אחרת, בדקות */
  cooldownMinutes?: { quota: number; error: number };
  now?: () => number;
}

interface Entry { path: string; text: string; voice: string; uploadedAt: number; lastUsed: number; seconds: number; model: string }

/** מהירות ההקראה (ההגדרה של ימות, מ-10- עד 10) כהנחיית סגנון ל-Gemini. באנגלית: כך המודל מבין הכי טוב. */
export function speechStyle(rate: number): string {
  if (rate <= -3) return 'Speak slowly and clearly, with calm pacing.';
  if (rate >= 6) return 'Speak quickly and efficiently.';
  if (rate >= 3) return 'Speak at a brisk, lively pace.';
  return '';
}

export interface SpeechStatus {
  configured: boolean; enabled: boolean; active: boolean; voice: string; files: number;
  lastModel: string | null; lastError: string | null; pausedUntil: string | null; generated: number; fallbacks: number;
}

export class ImprovedVoice {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry | null>>();
  private pausedUntil = 0;
  private lastError: string | null = null;
  private lastModel: string | null = null;
  private generated = 0;
  private fallbacks = 0;
  private folderReady: Promise<void> | null = null;
  constructor(private d: SpeechDeps) { this.load(); }

  private get now(): number { return (this.d.now ?? Date.now)(); }

  /** מופעל ויש מפתח (בלי קשר להפסקה זמנית). */
  get active(): boolean { return this.d.enabled() && this.d.gemini.available(); }

  status(): SpeechStatus {
    return {
      configured: this.d.gemini.available(), enabled: this.d.enabled(), active: this.active, voice: this.d.voice(), files: this.cache.size,
      lastModel: this.lastModel, lastError: this.lastError, pausedUntil: this.pausedUntil > this.now ? new Date(this.pausedUntil).toISOString() : null,
      generated: this.generated, fallbacks: this.fallbacks,
    };
  }

  private key(text: string, voice: string, style: string): string { return createHash('sha1').update(voice + '\n' + style + '\n' + text).digest('hex').slice(0, 20); }

  /** הנתיב להשמעה (f-), או null: ימות יקריאו בעצמם. אף פעם לא זורק. */
  async speak(text: string): Promise<string | null> {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || !this.active) return null;
    if (this.pausedUntil > this.now) { this.fallbacks++; return null; }
    const voice = this.d.voice();
    const k = this.key(t, voice, this.d.style?.() ?? '');
    const hit = this.cache.get(k);
    const fresh = hit && this.now - hit.uploadedAt < (this.d.refreshDays ?? 7) * 86_400_000;
    if (hit && fresh) { hit.lastUsed = this.now; this.save(); return this.playPath(hit); }
    const p = this.inflight.get(k) ?? this.generate(k, t, voice).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    // מחכים עד timeoutMs; אם ההפקה איטית, ימות מקריאים הפעם בעצמם וההפקה ממשיכה ברקע למטמון
    const timeout = this.d.timeoutMs ?? 7000;
    const e = await Promise.race([p, new Promise<'timeout'>(res => setTimeout(() => res('timeout'), timeout).unref?.())]);
    if (e === 'timeout') { this.fallbacks++; log('tts', `ההפקה איטית (מעל ${timeout} אלפיות); הפעם בקול של ימות`); return hit ? this.playPath(hit) : null; }
    if (!e) { this.fallbacks++; return hit ? this.playPath(hit) : null; }
    return this.playPath(e);
  }

  private playPath(e: Entry): string { return e.path.replace(/^ivr2:/, '').replace(/\.wav$/, ''); }

  private async generate(k: string, text: string, voice: string): Promise<Entry | null> {
    const t0 = this.now;
    try {
      const r = await this.d.gemini.synthesize(text, voice, this.d.style?.() || undefined);
      await (this.folderReady ??= this.d.yemot.ensureFolder(`${this.d.extension()}/${this.d.folder}`).catch(e => { this.folderReady = null; throw e; }));
      const path = `ivr2:/${this.d.extension()}/${this.d.folder}/${k}.wav`;
      await this.d.yemot.uploadFile(path, r.wav);
      const entry: Entry = { path, text: text.slice(0, 80), voice, uploadedAt: this.now, lastUsed: this.now, seconds: r.seconds, model: r.model };
      this.cache.set(k, entry);
      this.generated++; this.lastModel = r.model; this.lastError = null;
      log('tts', `הופק "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}" (${r.seconds.toFixed(1)} שניות, ${r.model}) ב-${((this.now - t0) / 1000).toFixed(1)} שניות`);
      void this.evict();
      this.save();
      return entry;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      const cd = this.d.cooldownMinutes ?? { quota: 15, error: 2 };
      const quota = e instanceof GeminiModelError && e.status === 429;
      this.pausedUntil = this.now + (quota ? cd.quota : cd.error) * 60_000;
      logError('tts', e, `הקול המשופר נכשל; ${quota ? `המכסה נגמרה, ` : ''}בקול של ימות ל-${quota ? cd.quota : cd.error} דקות`);
      return null;
    }
  }

  /** מחיקת הקבצים הישנים ביותר מימות כשעוברים את המכסה. */
  private async evict(): Promise<void> {
    const max = this.d.maxFiles ?? 200;
    if (this.cache.size <= max) return;
    const victims = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed).slice(0, this.cache.size - max);
    for (const [k, e] of victims) {
      this.cache.delete(k);
      try { await this.d.yemot.deleteFile(e.path); } catch (err) { log('tts', `מחיקת ${e.path} מימות נכשלה: ${err instanceof Error ? err.message : err}`); }
    }
    this.save();
  }

  /** מוחק את כל הקבצים מימות (למשל כשמכבים את הקול המשופר מהלוח). */
  async clear(): Promise<number> {
    const n = this.cache.size;
    for (const [k, e] of [...this.cache.entries()]) {
      this.cache.delete(k);
      try { await this.d.yemot.deleteFile(e.path); } catch { /* נמשיך */ }
    }
    this.save();
    return n;
  }

  private load(): void {
    if (!this.d.cacheFile || !existsSync(this.d.cacheFile)) return;
    try {
      const j = JSON.parse(readFileSync(this.d.cacheFile, 'utf8'));
      for (const [k, e] of Object.entries(j?.entries ?? {})) if (e && typeof (e as any).path === 'string') this.cache.set(k, e as Entry);
    } catch (e) { logError('tts', e, 'קריאת מטמון הקול'); }
  }

  private saveTimer: NodeJS.Timeout | null = null;
  /** שמירה מאוחדת (כמה שינויים ברצף נכתבים פעם אחת). */
  private save(): void {
    if (!this.d.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 500);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (!this.d.cacheFile) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try { writeFileSync(this.d.cacheFile, JSON.stringify({ entries: Object.fromEntries(this.cache) })); }
    catch (e) { logError('tts', e, 'שמירת מטמון הקול'); }
  }
}
