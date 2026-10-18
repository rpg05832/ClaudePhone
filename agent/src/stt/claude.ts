// תמלול דרך שירות ההכתבה של Claude (גרסה 0.7.4, 18.10.2026).
//
// אותו שירות שכפתור המיקרופון של Claude Code משתמש בו, עם ההתחברות של Claude Code שכבר שמורה במחשב (claude.ai).
// ההקלטה של ימות היא WAV של 16 ביט (8kHz מונו), והדגימות נשלחות כמו שהן (linear16), בשפה עברית.
// הרעיון והפרוטוקול מ-claude-code-yemot-hooks של zevisvei (vscode-extension/hooks/chat.js).
//
// השירות לא מתועד לשימוש מתוכנה אחרת ויכול להשתנות; לכן תמיד יש גיבוי: ivrit-ai במחשב, אם הותקן (transcriber.ts).
// נבדק 18.10 על הקלטות אמיתיות מהטלפון: עברית מדויקת, 7 עד 10 שניות להקלטה. בהקלטה עם איות ספרות השירות נתקע
// וחזר על אותה ספרה עשרות פעמים, ולכן תמלול שחוזר על עצמו נחשב כישלון (looksStuck).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { QueryFn } from '../claude/runner.ts';

export const CLAUDE_STT_URL = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
}

/** ההתחברות של Claude Code במחשב: הטוקן, והאם הוא פג (או יפוג בדקה הקרובה). */
export function readClaudeLogin(path = credentialsPath(), now = Date.now()): { token: string | null; expired: boolean } {
  try {
    if (!existsSync(path)) return { token: null, expired: false };
    const o = JSON.parse(readFileSync(path, 'utf8'))?.claudeAiOauth;
    const token = typeof o?.accessToken === 'string' && o.accessToken ? o.accessToken : null;
    return { token, expired: !!(o?.expiresAt && Number(o.expiresAt) < now + 60_000) };
  } catch { return { token: null, expired: false }; }
}

/** פירוק WAV: הדגימות (PCM של 16 ביט) בחבילות, קצב הדגימה ומספר הערוצים. */
export function wavPcm(buf: Buffer): { packets: Buffer[]; channels: number; rate: number; seconds: number } {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('ההקלטה אינה קובץ WAV');
  let p = 12;
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const n = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = buf.subarray(p + 8, p + 8 + n);
    else if (id === 'data') data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + n));
    p += 8 + n + (n & 1);
  }
  if (!fmt || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16) throw new Error('ההקלטה אינה WAV של 16 ביט');
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const packets: Buffer[] = [];
  for (let i = 0; i < data.length; i += 3200) packets.push(data.subarray(i, i + 3200));
  return { packets, channels, rate, seconds: data.length / (rate * channels * 2) };
}

/**
 * תמלול שנתקע: אותה מילה או ספרה חוזרת ברצף פעמים רבות ("9-9-9-9..."), או טקסט ארוך בהרבה ממה שאפשר לומר
 * בזמן ההקלטה. במקרה כזה עוברים לגיבוי.
 */
export function looksStuck(text: string, seconds: number): boolean {
  const tokens = text.split(/[\s\-–,.]+/).filter(Boolean);
  let run = 1;
  for (let i = 1; i < tokens.length; i++) {
    run = tokens[i] === tokens[i - 1] ? run + 1 : 1;
    if (run >= 8) return true;
  }
  // דיבור מהיר: כ-4 מילים בשנייה. הרבה מעבר לזה הוא חזרה של המודל.
  return seconds > 0 && tokens.length > Math.max(20, seconds * 6);
}

type WsLike = { onopen: any; onmessage: any; onerror: any; onclose: any; send(d: unknown): void; close(): void };
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

const defaultWs: WsFactory = (url, headers) => {
  const W = (globalThis as any).WebSocket;
  if (typeof W !== 'function') throw new Error('התמלול של Claude דורש Node 22 ומעלה');
  return new W(url, { headers });
};

export interface ClaudeSttOptions {
  /** הרצה קצרה של Claude Code: מחדשת התחברות שפגה (כמו כל הרצה של Claude Code). */
  query?: QueryFn;
  credentials?: string;
  url?: string;
  ws?: WsFactory;
  timeoutMs?: number;
  language?: string;
}

export class ClaudeSpeechToText {
  private renewing: Promise<void> | null = null;
  constructor(private o: ClaudeSttOptions = {}) {}

  /** יש התחברות של Claude Code במחשב (גם אם הטוקן פג: הוא יחודש בתמלול הבא). */
  available(): boolean { return !!readClaudeLogin(this.o.credentials ?? credentialsPath()).token; }

  private async renew(): Promise<void> {
    if (!this.o.query) return;
    if (!this.renewing) {
      this.renewing = (async () => {
        const q = this.o.query!({ prompt: 'ok', options: { maxTurns: 1, model: 'haiku', cwd: tmpdir(), settingSources: [], extraArgs: { 'no-session-persistence': null } } });
        for await (const _ of q) { /* מספיק שההרצה תסתיים */ }
      })().finally(() => { this.renewing = null; });
    }
    await this.renewing;
  }

  async transcribeWav(buf: Buffer): Promise<{ text: string; seconds: number }> {
    const cred = this.o.credentials ?? credentialsPath();
    if (readClaudeLogin(cred).expired) await this.renew().catch(() => {});
    const { token, expired } = readClaudeLogin(cred);
    if (!token) throw new Error('אין התחברות של Claude Code במחשב');
    if (expired) throw new Error('ההתחברות של Claude Code פגה ולא חודשה');
    const w = wavPcm(buf);
    const q = new URLSearchParams({
      encoding: 'linear16', sample_rate: String(w.rate), channels: String(w.channels),
      endpointing_ms: '300', utterance_end_ms: '1000', language: this.o.language ?? 'he', use_conversation_engine: 'true',
    });
    const text = await new Promise<string>((resolve, reject) => {
      let ws: WsLike;
      try { ws = (this.o.ws ?? defaultWs)(`${this.o.url ?? CLAUDE_STT_URL}?${q}`, { Authorization: `Bearer ${token}`, 'x-app': 'cli' }); }
      catch (e) { reject(e); return; }
      const done: string[] = [];
      let last = '';
      let error = '';
      const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('התמלול של Claude חרג מהזמן')); }, this.o.timeoutMs ?? 60_000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
        for (const p of w.packets) ws.send(p);
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      };
      ws.onmessage = (e: { data: unknown }) => {
        let m: any;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if ((m.type === 'TranscriptText' || m.type === 'TranscriptInterim') && m.data) last = String(m.data);
        else if (m.type === 'TranscriptEndpoint' && last) { done.push(last); last = ''; }
        else if (m.type === 'TranscriptError' || m.type === 'error') error = String(m.description || m.message || 'שגיאת תמלול');
      };
      ws.onerror = (e: any) => { if (!error) error = e?.message || 'החיבור לשירות התמלול של Claude נכשל'; };
      ws.onclose = () => {
        clearTimeout(timer);
        if (last) done.push(last);
        if (!done.length && error) reject(new Error(`תמלול Claude: ${error}`));
        else resolve(done.join(' ').trim());
      };
    });
    return { text, seconds: w.seconds };
  }
}
