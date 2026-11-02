// הקראה בקול של Gemini (גרסה 0.7.8): טקסט לקובץ שמע דרך Gemini API, במדרגה החינמית (מפתח API חינמי מ-AI Studio).
//
// המודלים gemini-3.8-flash-tts ו-gemini-3.8-flash-lite-tts תומכים בעברית ומזהים את השפה לבד. לכל מודל מכסה יומית נפרדת
// של בקשות במדרגה החינמית, ולכן מנסים אותם לפי הסדר: כשהראשון מחזיר 429 עוברים לשני. הפלט מבוקש כ-WAV ב-8000 הרץ
// (הפורמט של ימות); אם חוזר קצב אחר, audio.ts ממיר. הבקשה לפי ai.google.dev/gemini-api/docs/speech-generation
// (ממשק Interactions: POST /v1beta/interactions, והשמע חוזר ב-steps[].content[] כ-base64).
import { readKeyFile, type FetchLike } from '../stt/groq.ts';
import { toYemotWav } from './audio.ts';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
/** איפה מפיקים מפתח (מוצג באשף ובלוח) */
export const GEMINI_KEYS_URL = 'https://aistudio.google.com/apikey';

export interface GeminiSpeechOptions {
  /** קובץ המפתח (data/gemini.key). נקרא בכל הפקה, כך שמפתח שהוזן בלוח חל מיד. */
  keyFile: string;
  apiBase?: string;
  models?: string[];
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** שגיאה שמצדיקה מעבר למודל הבא (מכסה, מודל לא קיים, שרת). */
export class GeminiModelError extends Error {
  constructor(message: string, readonly status: number, readonly model: string) { super(message); }
}

/** 0.7.9: בלי בדיקת קידומת (למפתחות של Google יש כמה פורמטים); רק אורך סביר ובלי רווחים. האימות האמיתי מול השירות. */
export function looksLikeGeminiKey(key: string): boolean { const k = key.trim(); return k.length >= 16 && !/\s/.test(k); }

/** הודעת שגיאה בעברית לפי קוד התשובה (418 = נטפרי). */
export function describeGeminiError(status: number, body = '', model = ''): string {
  let msg = '';
  try { msg = String(JSON.parse(body)?.error?.message ?? ''); } catch { msg = body.slice(0, 160); }
  const m = model ? ` (${model})` : '';
  if (status === 400) return `Gemini דחה את הבקשה${m}: ${msg || '400'}`;
  if (status === 401 || status === 403) return `מפתח Gemini לא תקין או בלי הרשאה (${status})`;
  if (status === 404) return `המודל ${model || ''} לא נמצא ב-Gemini (404)`;
  if (status === 418) return 'Gemini חסום בסינון האינטרנט (נטפרי): יש לבקש פתיחה של generativelanguage.googleapis.com';
  if (status === 429) return `Gemini${m}: המכסה החינמית להיום נגמרה (429)`;
  if (status >= 500) return `Gemini לא זמין כרגע (${status})${m}`;
  return `Gemini החזיר שגיאה ${status}${m}${msg ? ': ' + msg : ''}`;
}

/** בניית גוף הבקשה (מיוצא לבדיקות). */
export function buildRequest(model: string, text: string, voice: string, style?: string): Record<string, unknown> {
  const content: Record<string, unknown> = { type: 'text', text };
  if (style) content.annotations = [{ type: 'speech_metadata', style }];
  return {
    model,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 8000 },
    generation_config: { speech_config: [{ voice }] },
  };
}

/** מוצא את השמע בתשובה: האובייקט האחרון עם type=audio ו-data (base64), בכל עומק. */
export function extractAudio(json: unknown): { data: string; mimeType: string } | null {
  let found: { data: string; mimeType: string } | null = null;
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 12) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (o.type === 'audio' && typeof o.data === 'string' && o.data) found = { data: o.data, mimeType: String(o.mime_type ?? o.mimeType ?? '') };
    if (typeof o.data === 'string' && typeof (o.mimeType ?? o.mime_type) === 'string' && String(o.mimeType ?? o.mime_type).startsWith('audio/')) found = { data: o.data as string, mimeType: String(o.mimeType ?? o.mime_type) };
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(json, 0);
  return found;
}

export class GeminiSpeech {
  constructor(private o: GeminiSpeechOptions) {}

  available(): boolean { return !!readKeyFile(this.o.keyFile); }
  get models(): string[] { return this.o.models?.length ? this.o.models : GEMINI_DEFAULT_MODELS; }
  private get fetch(): FetchLike { return this.o.fetch ?? (globalThis.fetch as unknown as FetchLike); }

  /** הפקה במודל אחד. זורק GeminiModelError כשכדאי לנסות מודל אחר. */
  async synthesizeWith(model: string, text: string, voice: string, style?: string): Promise<{ wav: Buffer; seconds: number }> {
    const key = readKeyFile(this.o.keyFile);
    if (!key) throw new Error('אין מפתח Gemini במחשב');
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetch(`${this.o.apiBase ?? GEMINI_API_BASE}/interactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(buildRequest(model, text, voice, style)), signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new GeminiModelError(`החיבור ל-Gemini נכשל: ${e instanceof Error ? e.message : String(e)}`, 0, model);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = describeGeminiError(res.status, body, model);
      if (res.status === 404 || res.status === 429 || res.status >= 500 || res.status === 400) throw new GeminiModelError(msg, res.status, model);
      throw new Error(msg);
    }
    const j = await res.json();
    const audio = extractAudio(j);
    if (!audio) throw new GeminiModelError(`Gemini (${model}) לא החזיר שמע`, 204, model);
    const raw = Buffer.from(audio.data, 'base64');
    const rawRate = Number(audio.mimeType.match(/rate=(\d+)/)?.[1] ?? 24000);
    return toYemotWav(raw, rawRate);
  }

  /** הפקה: המודלים לפי הסדר, כל אחד גיבוי לקודם. */
  async synthesize(text: string, voice: string, style?: string): Promise<{ wav: Buffer; seconds: number; model: string }> {
    let lastErr: Error | null = null;
    for (const model of this.models) {
      try { return { ...(await this.synthesizeWith(model, text, voice, style)), model }; }
      catch (e) {
        if (!(e instanceof GeminiModelError)) throw e;
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('אין מודל הקראה');
  }
}

/** בדיקת מפתח (לאשף): רשימת המודלים, ואילו ממודלי ההקראה המוגדרים קיימים. */
export async function checkGeminiKey(key: string, models = GEMINI_DEFAULT_MODELS, apiBase = GEMINI_API_BASE, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<{ ok: boolean; detail: string }> {
  if (!looksLikeGeminiKey(key)) return { ok: false, detail: 'המפתח קצר מדי או מכיל רווחים. העתק את המפתח המלא מ-AI Studio' };
  try {
    const res = await fetchFn(`${apiBase}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key.trim() }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, detail: describeGeminiError(res.status, await res.text().catch(() => '')) };
    const j = await res.json().catch(() => ({}));
    const names: string[] = Array.isArray(j?.models) ? j.models.map((m: any) => String(m?.name ?? '').replace(/^models\//, '')) : [];
    const have = models.filter(m => names.includes(m));
    if (!names.length) return { ok: true, detail: 'המפתח התקבל' };
    if (!have.length) return { ok: true, detail: `המפתח התקבל, אבל מודלי ההקראה ${models.join(', ')} לא ברשימה. אולי שמם השתנה; בדוק את ההגדרה speech.models` };
    return { ok: true, detail: `המפתח התקבל. מודלי הקראה זמינים: ${have.join(', ')}` };
  } catch (e) {
    return { ok: false, detail: `החיבור ל-Gemini נכשל: ${e instanceof Error ? e.message : String(e)}` };
  }
}
