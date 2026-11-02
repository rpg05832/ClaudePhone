import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wavPcm, looksStuck, readClaudeLogin, ClaudeSpeechToText } from '../src/stt/claude.ts';
import { SmartTranscriber } from '../src/stt/transcriber.ts';
import { GroqSpeechToText, checkGroqKey, describeGroqError, looksLikeGroqKey, readKeyFile } from '../src/stt/groq.ts';

/** WAV של 16 ביט, 8kHz מונו, באורך נתון בשניות (שקט) */
function wav(seconds: number, rate = 8000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('תמלול Claude: פירוק WAV של ימות לחבילות, וזיהוי קובץ לא תקין', () => {
  const w = wavPcm(wav(2));
  assert.equal(w.rate, 8000); assert.equal(w.channels, 1);
  assert.equal(w.packets.length, 10);             // 32000 בתים בחבילות של 3200
  assert.ok(Math.abs(w.seconds - 2) < 0.001);
  assert.throws(() => wavPcm(Buffer.from('not a wav file at all')), /WAV/);
});

test('תמלול Claude: זיהוי תמלול שנתקע על חזרה', () => {
  assert.equal(looksStuck('E-R-7-0-' + Array(40).fill('9').join('-'), 12), true);
  assert.equal(looksStuck('תשלח מייל לדוד עם הסיכום של הפגישה', 4), false);
  assert.equal(looksStuck('אחת שתיים שלוש ארבע', 3), false);
  assert.equal(looksStuck(Array(200).fill('מילה שונה').map((x, i) => x + i).join(' '), 5), true);
});

test('תמלול Claude: קריאת ההתחברות של Claude Code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-cred-'));
  const f = join(dir, '.credentials.json');
  assert.deepEqual(readClaudeLogin(f), { token: null, expired: false });
  writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } }));
  assert.deepEqual(readClaudeLogin(f), { token: 'tok', expired: false });
  writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1000 } }));
  assert.equal(readClaudeLogin(f).expired, true);
});

/** WebSocket מדומה: מחזיר את ההודעות שנתנו לו אחרי שהקליטה נסגרת */
function fakeWs(messages: object[], seen: { url?: string; headers?: Record<string, string>; sent: number }) {
  return (url: string, headers: Record<string, string>) => {
    seen.url = url; seen.headers = headers;
    const ws: any = {
      send(d: unknown) { seen.sent++; if (typeof d === 'string' && d.includes('CloseStream')) setTimeout(() => { for (const m of messages) ws.onmessage({ data: JSON.stringify(m) }); ws.onclose(); }, 1); },
      close() {},
    };
    setTimeout(() => ws.onopen(), 1);
    return ws;
  };
}

test('תמלול Claude: שולח את ההקלטה בעברית עם ההתחברות, מחבר קטעים, ומחדש התחברות שפגה', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-cred-'));
  const f = join(dir, '.credentials.json');
  writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: Date.now() - 1000 } }));
  let renewed = 0;
  const query = async function* () { renewed++; writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'new', expiresAt: Date.now() + 3600_000 } })); yield { type: 'result' }; };
  const seen = { sent: 0 } as any;
  const c = new ClaudeSpeechToText({ credentials: f, query: query as any, ws: fakeWs([
    { type: 'TranscriptInterim', data: 'שלום' }, { type: 'TranscriptText', data: 'שלום עולם' }, { type: 'TranscriptEndpoint' }, { type: 'TranscriptText', data: 'מה נשמע' },
  ], seen) });
  const r = await c.transcribeWav(wav(1));
  assert.equal(r.text, 'שלום עולם מה נשמע');
  assert.equal(renewed, 1);
  assert.equal(seen.headers.Authorization, 'Bearer new');
  assert.match(seen.url, /language=he/);
  assert.match(seen.url, /sample_rate=8000/);
  assert.equal(seen.sent, 1 + 5 + 1);               // KeepAlive, 5 חבילות, CloseStream
  const err = new ClaudeSpeechToText({ credentials: f, ws: fakeWs([{ type: 'TranscriptError', description: 'bad' }], { sent: 0 }) });
  await assert.rejects(err.transcribeWav(wav(1)), /bad/);
});

function smart(opts: { engine: 'groq' | 'claude' | 'local'; claude?: string | Error; claudeAvail?: boolean; local?: string | Error; localInstalled?: boolean; seconds?: number; groq?: string | Error; groqAvail?: boolean }) {
  const calls: string[] = [];
  const t = new SmartTranscriber(
    () => opts.engine,
    { available: () => opts.claudeAvail ?? true, transcribeWav: async () => { calls.push('claude'); if (opts.claude instanceof Error) throw opts.claude; return { text: opts.claude ?? '', seconds: opts.seconds ?? 5 }; } },
    { ready: false, stop() {}, transcribe: async () => { calls.push('local'); if (opts.local instanceof Error) throw opts.local; return opts.local ?? ''; } },
    () => Buffer.alloc(0),
    () => opts.localInstalled ?? true,
    { available: () => opts.groqAvail ?? false, transcribeWav: async () => { calls.push('groq'); if (opts.groq instanceof Error) throw opts.groq; return { text: opts.groq ?? '', seconds: opts.seconds ?? 5 }; } },
  );
  return { t, calls };
}

/** fetch מדומה ל-Groq: שומר את הבקשה ומחזיר תשובה לפי הקוד */
function groqFetch(status: number, text = 'שלום עולם', seen: { url?: string; form?: FormData; headers?: any } = {}) {
  return async (url: string, init: any) => {
    seen.url = url; seen.form = init?.body; seen.headers = init?.headers;
    if (status !== 200) return { status, ok: false, json: async () => ({}), text: async () => JSON.stringify({ error: { message: 'limit' } }) };
    const j = url.endsWith('/models') ? { data: [{ id: 'whisper-large-v3' }, { id: 'llama' }] } : { text };
    return { status: 200, ok: true, json: async () => j, text: async () => JSON.stringify(j) };
  };
}

test('תמלול Groq: שולח את ההקלטה בעברית עם המפתח, ומתרגם קודי שגיאה', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-groq-'));
  const keyFile = join(dir, 'groq.key');
  const g = new GroqSpeechToText({ keyFile, fetch: groqFetch(200) as any });
  assert.equal(g.available(), false);
  await assert.rejects(g.transcribeWav(wav(1)), /אין מפתח/);
  writeFileSync(keyFile, '﻿gsk_FAKEFAKEFAKEFAKEFAKEFAKEFAKE\r\n');
  assert.equal(readKeyFile(keyFile), 'gsk_FAKEFAKEFAKEFAKEFAKEFAKEFAKE');
  assert.equal(g.available(), true);
  const seen: any = {};
  const g2 = new GroqSpeechToText({ keyFile, fetch: groqFetch(200, ' שלום עולם ', seen) as any, prompt: 'קלוד' });
  const r = await g2.transcribeWav(wav(2));
  assert.equal(r.text, 'שלום עולם'); assert.ok(Math.abs(r.seconds - 2) < 0.001);
  assert.match(seen.url, /api\.groq\.com\/openai\/v1\/audio\/transcriptions$/);
  assert.equal(seen.headers.Authorization, 'Bearer gsk_FAKEFAKEFAKEFAKEFAKEFAKEFAKE');
  assert.equal(seen.form.get('model'), 'whisper-large-v3');
  assert.equal(seen.form.get('language'), 'he');
  assert.equal(seen.form.get('prompt'), 'קלוד');
  assert.equal((seen.form.get('file') as Blob).size, wav(2).length);
  await assert.rejects(new GroqSpeechToText({ keyFile, fetch: groqFetch(401) as any }).transcribeWav(wav(1)), /מפתח Groq לא תקין/);
  await assert.rejects(new GroqSpeechToText({ keyFile, fetch: groqFetch(429) as any }).transcribeWav(wav(1)), /המכסה/);
  await assert.rejects(new GroqSpeechToText({ keyFile, fetch: async () => { throw new Error('ECONNRESET'); } }).transcribeWav(wav(1)), /החיבור ל-Groq נכשל/);
  assert.match(describeGroqError(418), /נטפרי/);
  assert.equal(looksLikeGroqKey('gsk_FAKEFAKEFAKEFAKEFAKEFAKEFAKE'), true);
  assert.equal(looksLikeGroqKey('AIzaXXXX'), false);
  const ck = await checkGroqKey('gsk_FAKEFAKEFAKEFAKEFAKEFAKEFAKE', 'https://x', groqFetch(200) as any);
  assert.equal(ck.ok, true); assert.match(ck.detail, /whisper-large-v3/);
  assert.equal((await checkGroqKey('gsk_FAKEFAKEFAKEFAKEFAKEFAKEFAKE', 'https://x', groqFetch(401) as any)).ok, false);
  assert.equal((await checkGroqKey('bad')).ok, false);
});

test('בחירת מנוע תמלול: Groq ראשון (0.7.8), והגיבוי לפי הסדר Groq, Claude, ivrit-ai', async () => {
  let s = smart({ engine: 'groq', groqAvail: true, groq: 'גרוק' });
  assert.equal(await s.t.transcribe('x'), 'גרוק'); assert.deepEqual(s.calls, ['groq']); assert.equal(s.t.lastEngine, 'groq');
  assert.match(s.t.status().detail, /^Groq · גיבוי: Claude, ivrit-ai/);
  // Groq נכשל: Claude, ואז ivrit-ai
  s = smart({ engine: 'groq', groqAvail: true, groq: new Error('429'), claude: new Error('ws'), local: 'מקומי' });
  assert.equal(await s.t.transcribe('x'), 'מקומי'); assert.deepEqual(s.calls, ['groq', 'claude', 'local']);
  // Groq לא זיהה דיבור או נתקע: הבא
  s = smart({ engine: 'groq', groqAvail: true, groq: '', claude: 'קלוד' });
  assert.equal(await s.t.transcribe('x'), 'קלוד');
  s = smart({ engine: 'groq', groqAvail: true, groq: Array(30).fill('7').join(' '), claude: 'קלוד' });
  assert.equal(await s.t.transcribe('x'), 'קלוד');
  // נבחר Groq אבל אין מפתח: Claude מתמלל, והמצב מסביר
  s = smart({ engine: 'groq', claude: 'קלוד' });
  assert.equal(await s.t.transcribe('x'), 'קלוד'); assert.deepEqual(s.calls, ['claude']);
  assert.match(s.t.status().detail, /Groq: אין מפתח · מתמלל ב-Claude · גיבוי: ivrit-ai/);
  assert.equal(s.t.status().ok, true);
  // נבחר Claude: Groq הוא הגיבוי הראשון
  s = smart({ engine: 'claude', groqAvail: true, claude: new Error('ws'), groq: 'גרוק' });
  assert.equal(await s.t.transcribe('x'), 'גרוק'); assert.deepEqual(s.calls, ['claude', 'groq']);
  // שום מנוע
  s = smart({ engine: 'groq', claudeAvail: false, localInstalled: false });
  await assert.rejects(s.t.transcribe('x'), /אין מנוע תמלול זמין/);
  assert.match(s.t.status().detail, /אין מנוע תמלול/);
});

test('בחירת מנוע תמלול וגיבוי', async () => {
  let s = smart({ engine: 'claude', claude: 'שלום' });
  assert.equal(await s.t.transcribe('x'), 'שלום'); assert.deepEqual(s.calls, ['claude']); assert.equal(s.t.lastEngine, 'claude');
  // Claude נכשל, נתקע או לא זיהה דיבור: ivrit-ai
  s = smart({ engine: 'claude', claude: new Error('net'), local: 'מקומי' });
  assert.equal(await s.t.transcribe('x'), 'מקומי'); assert.deepEqual(s.calls, ['claude', 'local']); assert.equal(s.t.lastEngine, 'local');
  s = smart({ engine: 'claude', claude: Array(30).fill('9').join('-'), local: 'מקומי' });
  assert.equal(await s.t.transcribe('x'), 'מקומי');
  s = smart({ engine: 'claude', claude: '', local: 'מקומי' });
  assert.equal(await s.t.transcribe('x'), 'מקומי');
  // אין ivrit-ai: הטקסט של Claude כמו שהוא, או השגיאה
  s = smart({ engine: 'claude', claude: Array(30).fill('9').join('-'), localInstalled: false });
  assert.match(await s.t.transcribe('x'), /^9/); assert.deepEqual(s.calls, ['claude']);
  s = smart({ engine: 'claude', claude: new Error('net'), localInstalled: false });
  await assert.rejects(s.t.transcribe('x'), /net/);
  // ivrit-ai נכשל אחרי ש-Claude נתקע: הטקסט של Claude
  s = smart({ engine: 'claude', claude: Array(30).fill('9').join('-'), local: new Error('py') });
  assert.match(await s.t.transcribe('x'), /^9/);
  // מנוע מקומי, ו-Claude כגיבוי
  s = smart({ engine: 'local', local: 'מקומי' });
  assert.equal(await s.t.transcribe('x'), 'מקומי'); assert.deepEqual(s.calls, ['local']);
  s = smart({ engine: 'local', local: new Error('py'), claude: 'שלום' });
  assert.equal(await s.t.transcribe('x'), 'שלום'); assert.deepEqual(s.calls, ['local', 'claude']);
  s = smart({ engine: 'local', localInstalled: false, claude: 'שלום' });
  assert.equal(await s.t.transcribe('x'), 'שלום'); assert.deepEqual(s.calls, ['claude']);
  // אין שום מנוע
  s = smart({ engine: 'claude', claudeAvail: false, localInstalled: false });
  await assert.rejects(s.t.transcribe('x'), /אין מנוע תמלול/);
  assert.equal(s.t.status().ok, false);
  // איותים מנורמלים גם בתמלול של Claude
  s = smart({ engine: 'claude', claude: 'איי בי אחת שתיים שטרודל ג\'ימייל נקודה קום' });
  assert.match(await s.t.transcribe('x'), /@gmail\.com/);
});
