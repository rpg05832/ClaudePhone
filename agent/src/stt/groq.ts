// תמלול דרך Groq (גרסה 0.7.8): Whisper של OpenAI על השרתים של Groq, במדרגה החינמית (מפתח API חינמי, בלי כרטיס אשראי).
//
// ה-API תואם ל-OpenAI (POST /audio/transcriptions, multipart). המודל: whisper-large-v3 (המדויק מבין השניים; גם הוא חינמי).
// ההקלטה של ימות (WAV 8kHz מונו) נשלחת כמו שהיא עם language=he. המדרגה החינמית (console.groq.com/docs/rate-limits):
// 20 בקשות בדקה, 2,000 ביום, 7,200 שניות שמע בשעה. חיוב (בתשלום) מינימום 10 שניות לבקשה.
// Groq מריץ את Whisper המקורי ולא את הכיוונון לעברית של ivrit-ai; לכן גם כאן יש גיבוי (transcriber.ts).
import { existsSync, readFileSync } from 'node:fs';
import { wavPcm } from './claude.ts';

export const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'whisper-large-v3';
/** איפה מפיקים מפתח (מוצג באשף ובלוח) */
export const GROQ_KEYS_URL = 'https://console.groq.com/keys';

export type FetchLike = (url: string, init?: any) => Promise<{ status: number; ok: boolean; json(): Promise<any>; text(): Promise<string> }>;

export interface GroqSttOptions {
  /** קובץ המפתח (data/groq.key). נקרא בכל תמלול, כך שמפתח שהוזן בלוח חל מיד. */
  keyFile: string;
  model?: string;
  apiBase?: string;
  language?: string;
  /** מילים שמכוונות את הכתיב (Whisper מקבל "prompt" של טקסט בשפה) */
  prompt?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** קריאת מפתח מקובץ: השורה הראשונה שאינה ריקה. */
export function readKeyFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const s = readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).find(Boolean);
    return s || null;
  } catch { return null; }
}

/** מפתח Groq תקין בצורתו (gsk_ ואחריו אותיות וספרות). */
/** 0.7.9: בלי בדיקת קידומת (הפורמט של המפתחות משתנה); רק אורך סביר ובלי רווחים. האימות האמיתי מול השירות. */
export function looksLikeGroqKey(key: string): boolean { const k = key.trim(); return k.length >= 16 && !/\s/.test(k); }

export class GroqSpeechToText {
  constructor(private o: GroqSttOptions) {}

  /** יש מפתח במחשב. */
  available(): boolean { return !!readKeyFile(this.o.keyFile); }

  private get fetch(): FetchLike { return this.o.fetch ?? (globalThis.fetch as unknown as FetchLike); }

  async transcribeWav(buf: Buffer): Promise<{ text: string; seconds: number }> {
    const key = readKeyFile(this.o.keyFile);
    if (!key) throw new Error('אין מפתח Groq במחשב');
    const w = wavPcm(buf);   // גם אימות שזה WAV תקין
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), 'recording.wav');
    form.append('model', this.o.model ?? GROQ_DEFAULT_MODEL);
    form.append('language', this.o.language ?? 'he');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (this.o.prompt) form.append('prompt', this.o.prompt);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetch(`${this.o.apiBase ?? GROQ_API_BASE}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(this.o.timeoutMs ?? 45_000),
      });
    } catch (e) {
      throw new Error(`החיבור ל-Groq נכשל: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(describeGroqError(res.status, body));
    }
    const j = await res.json();
    return { text: String(j?.text ?? '').trim(), seconds: w.seconds };
  }
}

/** הודעת שגיאה בעברית לפי קוד התשובה (418 = נטפרי). */
export function describeGroqError(status: number, body = ''): string {
  let msg = '';
  try { msg = String(JSON.parse(body)?.error?.message ?? ''); } catch { msg = body.slice(0, 120); }
  if (status === 401) return 'מפתח Groq לא תקין (401)';
  if (status === 403) return 'Groq דחה את הבקשה (403)';
  if (status === 413) return 'ההקלטה גדולה מדי ל-Groq (413)';
  if (status === 418) return 'Groq חסום בסינון האינטרנט (נטפרי): יש לבקש פתיחה של api.groq.com';
  if (status === 429) return 'Groq: המכסה החינמית נגמרה לרגע (429)' + (msg ? ` · ${msg}` : '');
  if (status >= 500) return `Groq לא זמין כרגע (${status})`;
  return `Groq החזיר שגיאה ${status}${msg ? ': ' + msg : ''}`;
}

/** בדיקת מפתח (לאשף): GET /models עם המפתח. */
export async function checkGroqKey(key: string, apiBase = GROQ_API_BASE, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<{ ok: boolean; detail: string }> {
  if (!looksLikeGroqKey(key)) return { ok: false, detail: 'המפתח קצר מדי או מכיל רווחים. העתק את המפתח המלא מהדף של Groq' };
  try {
    const res = await fetchFn(`${apiBase}/models`, { headers: { Authorization: `Bearer ${key.trim()}` }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      const models: string[] = Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id ?? '')) : [];
      const whisper = models.filter(m => m.startsWith('whisper'));
      return { ok: true, detail: whisper.length ? `המפתח התקבל. מודלי תמלול: ${whisper.join(', ')}` : 'המפתח התקבל' };
    }
    return { ok: false, detail: describeGroqError(res.status, await res.text().catch(() => '')) };
  } catch (e) {
    return { ok: false, detail: `החיבור ל-Groq נכשל: ${e instanceof Error ? e.message : String(e)}` };
  }
}
