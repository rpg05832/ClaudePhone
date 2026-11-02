// 0.7.8: הקול המשופר (Gemini), עיבוד השמע, המטמון והנפילה לקול של ימות, ובניית התשובה עם f-.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseWav, writeWav, resample, toMono, toYemotWav, YEMOT_RATE } from '../src/tts/audio.ts';
import { GeminiSpeech, GeminiModelError, buildRequest, extractAudio, checkGeminiKey, describeGeminiError } from '../src/tts/gemini.ts';
import { ImprovedVoice, speechStyle } from '../src/tts/speech.ts';
import { r, speechChunks } from '../src/phone/response.ts';

/** WAV של סינוס (16 ביט) בקצב ובאורך נתונים */
function sine(seconds: number, rate: number, channels = 1, hz = 440): Buffer {
  const n = Math.round(seconds * rate);
  const samples = new Int16Array(n * channels);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) samples[i * channels + c] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 10000);
  return writeWav({ samples, rate, channels });
}

test('שמע: WAV של 24kHz סטריאו הופך ל-8kHz מונו באורך זהה, ו-PCM גולמי מקבל כותרת', () => {
  const src = sine(1.5, 24000, 2);
  const out = toYemotWav(src);
  const p = parseWav(out.wav);
  assert.equal(p.rate, YEMOT_RATE); assert.equal(p.channels, 1);
  assert.ok(Math.abs(out.seconds - 1.5) < 0.01);
  assert.equal(p.samples.length, 12000);
  // האות נשמר (לא שקט אחרי המסנן): 440 הרץ מתחת לתדר החיתוך
  let peak = 0; for (const s of p.samples) peak = Math.max(peak, Math.abs(s));
  assert.ok(peak > 6000, `peak ${peak}`);
  // גולמי: 24000 הרץ מונו בלי כותרת
  const raw = sine(0.5, 24000).subarray(44);
  const o2 = toYemotWav(raw, 24000);
  assert.ok(Math.abs(o2.seconds - 0.5) < 0.01);
  // כבר בפורמט: לא משתנה
  const same = toYemotWav(sine(0.25, 8000));
  assert.equal(parseWav(same.wav).samples.length, 2000);
  assert.equal(toMono(parseWav(sine(0.1, 8000, 2))).samples.length, 800);
  assert.equal(resample({ samples: new Int16Array(16000), rate: 16000, channels: 1 }, 8000).samples.length, 8000);
  assert.throws(() => parseWav(Buffer.from('nope')), /WAV/);
});

function geminiFetch(opts: { status?: number | ((model: string) => number); audio?: Buffer; calls?: { url: string; body: any; headers: any }[] }) {
  return async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    opts.calls?.push({ url, body, headers: init?.headers });
    const status = typeof opts.status === 'function' ? opts.status(body?.model) : (opts.status ?? 200);
    if (status !== 200) return { status, ok: false, json: async () => ({}), text: async () => JSON.stringify({ error: { message: 'quota' } }) };
    const data = (opts.audio ?? sine(0.3, 24000)).toString('base64');
    const j = url.endsWith('/models?pageSize=1000')
      ? { models: [{ name: 'models/gemini-3.8-flash-tts' }, { name: 'models/gemini-2.5-pro' }] }
      : { steps: [{ type: 'model_output', content: [{ type: 'audio', data, mime_type: 'audio/wav' }] }] };
    return { status: 200, ok: true, json: async () => j, text: async () => JSON.stringify(j) };
  };
}

test('Gemini: הבקשה בפורמט Interactions עם המפתח, הקול והסגנון; השמע מומר לפורמט של ימות', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-tts-'));
  const keyFile = join(dir, 'gemini.key');
  const g = new GeminiSpeech({ keyFile, fetch: geminiFetch({}) as any });
  assert.equal(g.available(), false);
  await assert.rejects(g.synthesize('שלום', 'Charon'), /אין מפתח/);
  writeFileSync(keyFile, 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1\n');
  assert.equal(g.available(), true);
  const calls: any[] = [];
  const g2 = new GeminiSpeech({ keyFile, fetch: geminiFetch({ calls }) as any });
  const out = await g2.synthesize('שלום עולם', 'Charon', 'Speak slowly.');
  assert.equal(out.model, 'gemini-3.8-flash-tts');
  assert.ok(Math.abs(out.seconds - 0.3) < 0.01);
  assert.equal(parseWav(out.wav).rate, 8000);
  assert.match(calls[0].url, /\/interactions$/);
  assert.equal(calls[0].headers['x-goog-api-key'], 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1');
  assert.deepEqual(calls[0].body, buildRequest('gemini-3.8-flash-tts', 'שלום עולם', 'Charon', 'Speak slowly.'));
  assert.equal(calls[0].body.response_format.sample_rate, 8000);
  assert.equal(calls[0].body.generation_config.speech_config[0].voice, 'Charon');
  assert.equal(calls[0].body.input[0].content[0].annotations[0].style, 'Speak slowly.');
  // בלי סגנון: בלי annotations
  assert.equal('annotations' in buildRequest('m', 'x', 'Kore').input[0].content[0], false);
  // extractAudio מוצא גם מבנה של generateContent
  assert.equal(extractAudio({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: 'QUJD' } }] } }] })?.data, 'QUJD');
  assert.equal(extractAudio({ steps: [] }), null);
});

test('Gemini: מכסה (429) במודל הראשון עוברת לשני; כשכולם נכשלים נזרקת שגיאה; מפתח לא תקין לא מנסה מודל אחר', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-tts-'));
  const keyFile = join(dir, 'gemini.key');
  writeFileSync(keyFile, 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1');
  const calls: any[] = [];
  const g = new GeminiSpeech({ keyFile, fetch: geminiFetch({ calls, status: m => m === 'gemini-3.8-flash-tts' ? 429 : 200 }) as any });
  const out = await g.synthesize('שלום', 'Charon');
  assert.equal(out.model, 'gemini-3.8-flash-lite-tts');
  assert.deepEqual(calls.map(c => c.body.model), ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
  const all = new GeminiSpeech({ keyFile, fetch: geminiFetch({ status: 429 }) as any });
  await assert.rejects(all.synthesize('שלום', 'Charon'), (e: any) => e instanceof GeminiModelError && e.status === 429 && /המכסה/.test(e.message));
  const bad = new GeminiSpeech({ keyFile, fetch: geminiFetch({ calls: [], status: 403 }) as any });
  await assert.rejects(bad.synthesize('שלום', 'Charon'), (e: any) => !(e instanceof GeminiModelError) && /מפתח Gemini/.test(e.message));
  assert.match(describeGeminiError(418), /נטפרי/);
  // בדיקת מפתח: צורה, ורשימת המודלים
  assert.equal((await checkGeminiKey('short')).ok, false);
  const ck = await checkGeminiKey('AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1', ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'], 'https://x', geminiFetch({}) as any);
  assert.equal(ck.ok, true); assert.match(ck.detail, /gemini-3.8-flash-tts/);
  const ck2 = await checkGeminiKey('AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1', ['x'], 'https://x', geminiFetch({ status: 403 }) as any);
  assert.equal(ck2.ok, false);
});

function voice(over: Partial<ConstructorParameters<typeof ImprovedVoice>[0]> = {}, state: { uploads: string[]; deletes: string[]; folders: string[]; synth: number; fail?: Error; delayMs?: number } = { uploads: [], deletes: [], folders: [], synth: 0 }) {
  let now = 1_000_000;
  const v = new ImprovedVoice({
    enabled: () => true, voice: () => 'Charon', style: () => '',
    gemini: {
      available: () => true,
      synthesize: async (text) => {
        state.synth++;
        if (state.delayMs) await new Promise(res => setTimeout(res, state.delayMs));
        if (state.fail) throw state.fail;
        return { wav: Buffer.alloc(100), seconds: 1, model: 'm' };
      },
    },
    yemot: { uploadFile: async (p) => { state.uploads.push(p); }, deleteFile: async (p) => { state.deletes.push(p); }, ensureFolder: async (f) => { state.folders.push(f); } },
    extension: () => '9', folder: 'tts', maxFiles: 3, timeoutMs: 200, now: () => now, cooldownMinutes: { quota: 15, error: 2 },
    ...over,
  });
  return { v, state, tick: (ms: number) => { now += ms; } };
}

test('הקול המשופר: הפקה פעם אחת לכל טקסט, תיקייה נוצרת פעם אחת, מחיקת הישנים מעבר למכסה, ומטמון בקובץ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-voice-'));
  const cacheFile = join(dir, 'tts-cache.json');
  const { v, state, tick } = voice({ cacheFile });
  const p1 = await v.speak('שלום. הקש את הקוד');
  assert.match(p1!, /^\/9\/tts\/[0-9a-f]{20}$/);
  assert.equal(state.uploads[0], `ivr2:${p1}.wav`);
  assert.deepEqual(state.folders, ['9/tts']);
  tick(1000);
  assert.equal(await v.speak('שלום.  הקש את הקוד'), p1);       // רווחים לא משנים: מהמטמון
  assert.equal(state.synth, 1);
  tick(1000); await v.speak('ב'); tick(1000); await v.speak('ג'); tick(1000); await v.speak('ד');
  assert.equal(state.synth, 4);
  await new Promise(res => setTimeout(res, 10));
  assert.equal(state.deletes.length, 1);                        // מעבר ל-3 קבצים: הישן ביותר (הראשון) נמחק
  assert.equal(state.deletes[0], `ivr2:${p1}.wav`);
  assert.equal(v.status().files, 3);
  v.flush();
  assert.ok(existsSync(cacheFile));
  // מופע חדש קורא את המטמון ולא מפיק מחדש
  const again = voice({ cacheFile }, { uploads: [], deletes: [], folders: [], synth: 0 });
  assert.equal(again.v.status().files, 3);
  assert.ok(await again.v.speak('ד'));
  assert.equal(again.state.synth, 0);
  // טקסט ריק או קול כבוי: null
  assert.equal(await v.speak('   '), null);
  const off = voice({ enabled: () => false });
  assert.equal(await off.v.speak('שלום'), null);
  // קובץ ישן מ-refreshDays מופק מחדש
  const old = voice({ cacheFile, refreshDays: 1 }, { uploads: [], deletes: [], folders: [], synth: 0 });
  old.tick(2 * 86_400_000);
  assert.ok(await old.v.speak('ד'));
  assert.equal(old.state.synth, 1);
});

test('הקול המשופר: כישלון או מכסה עוברים לקול של ימות עם הפסקה, והפקה איטית לא מעכבת את השיחה', async () => {
  const quota = voice({}, { uploads: [], deletes: [], folders: [], synth: 0, fail: new GeminiModelError('quota', 429, 'm') });
  assert.equal(await quota.v.speak('שלום'), null);
  assert.equal(await quota.v.speak('עוד'), null);
  assert.equal(quota.state.synth, 1);                           // בהפסקה: לא מנסים שוב
  assert.ok(quota.v.status().pausedUntil);
  assert.match(quota.v.status().lastError!, /quota/);
  quota.tick(16 * 60_000); quota.state.fail = undefined;
  assert.ok(await quota.v.speak('עוד'));                        // אחרי ההפסקה: שוב מופק
  const err = voice({}, { uploads: [], deletes: [], folders: [], synth: 0, fail: new Error('net') });
  assert.equal(await err.v.speak('שלום'), null);
  err.tick(3 * 60_000); err.state.fail = undefined;
  assert.ok(await err.v.speak('שלום'));
  // איטי: הפעם null, וההפקה ממשיכה ברקע ונכנסת למטמון
  const slow = voice({ timeoutMs: 30 }, { uploads: [], deletes: [], folders: [], synth: 0, delayMs: 80 });
  assert.equal(await slow.v.speak('איטי'), null);
  assert.equal(slow.v.status().fallbacks, 1);
  await new Promise(res => setTimeout(res, 120));
  slow.state.delayMs = 0;
  assert.ok(await slow.v.speak('איטי'));
  assert.equal(slow.state.synth, 1);
  assert.equal(speechStyle(-4).length > 0, true); assert.equal(speechStyle(0), ''); assert.match(speechStyle(8), /quickly/);
});

test('תשובה לימות: render עם קבצים (f-), נפילה ל-t- כשאין קובץ, וחלוקת טקסט ארוך לקבצים', async () => {
  const files: Record<string, string> = { 'שלום, מה שלומך?': '/9/tts/aaa', 'הקש 1 להמשך': '/9/tts/bbb' };
  const speak = async (t: string) => files[t] ?? null;
  const res = r().say('שלום, מה שלומך?').readDigits('הקש 1 להמשך', 'v1').readAfter(['טקסט ראשון', 'שלום, מה שלומך?'], 'v2', { min: 0 }).goto('/9');
  assert.equal(res.toString(), 'id_list_message=t-שלום מה שלומך?&read=t-הקש 1 להמשך=v1,no,1,1,15,NO,no,no,,,,,,,no&read=t-טקסט ראשון.t-שלום מה שלומך?=v2,no,1,1,15,NO,no,no,,,,Ok,EMPTY,,no&go_to_folder=/9');
  assert.equal(await res.render(speak), 'id_list_message=f-/9/tts/aaa&read=f-/9/tts/bbb=v1,no,1,1,15,NO,no,no,,,,,,,no&read=t-טקסט ראשון.f-/9/tts/aaa=v2,no,1,1,15,NO,no,no,,,,Ok,EMPTY,,no&go_to_folder=/9');
  assert.equal(await res.render(), res.toString());
  // speak שזורק: כמו null
  assert.equal(await r().say('x').render(async () => { throw new Error('boom'); }), 'id_list_message=t-x');
  // טקסט ארוך: כמה קטעים, כל אחד קובץ (או t-)
  const long = Array(120).fill('משפט ארוך למדי שנגמר בנקודה.').join(' ');
  const chunks = speechChunks(long, 300);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every(c => c.length <= 300 && c.endsWith('.')));
  assert.equal(chunks.join(' '), long);
  const rendered = await r().say(long).render(async (t) => '/9/tts/' + t.length);
  assert.match(rendered, /^id_list_message=f-\/9\/tts\/\d+(\.f-\/9\/tts\/\d+)+$/);      // יותר מ-2500 תווים: כמה קבצים
  const mixed = await r().say(long).render(async (t) => t.length > 2000 ? null : '/9/tts/x');
  assert.match(mixed, /^id_list_message=t-.*\.f-\/9\/tts\/x$/);                          // הקטע הארוך בקול של ימות, הקצר מקובץ
  assert.deepEqual(speechChunks('   '), []);
  assert.deepEqual(speechChunks('a'.repeat(50), 20).map(c => c.length), [20, 20, 10]);
});
