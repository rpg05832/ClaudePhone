// עיבוד שמע בסיסי לקול המשופר (0.7.8), בלי ffmpeg: קריאת WAV, המרה למונו, שינוי קצב דגימה, וכתיבת WAV
// בפורמט של ימות המשיח: PCM של 16 ביט, 8000 הרץ, מונו (f2.freeivr.co.il/post/62514).

export const YEMOT_RATE = 8000;

export interface Pcm { samples: Int16Array; rate: number; channels: number }

/** קריאת WAV של PCM 16 ביט (כל קצב, מונו או סטריאו). */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('לא קובץ WAV');
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
  if (!fmt || !data) throw new Error('WAV בלי fmt או data');
  const format = fmt.readUInt16LE(0);
  const bits = fmt.readUInt16LE(14);
  if ((format !== 1 && format !== 0xFFFE) || bits !== 16) throw new Error(`WAV לא נתמך (פורמט ${format}, ${bits} ביט)`);
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const even = data.length - (data.length % 2);
  const samples = new Int16Array(even / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { samples, rate, channels };
}

/** PCM גולמי (l16, בלי כותרת) של 16 ביט little-endian. */
export function rawPcm(buf: Buffer, rate: number, channels = 1): Pcm {
  const even = buf.length - (buf.length % 2);
  const samples = new Int16Array(even / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2);
  return { samples, rate, channels };
}

/** סטריאו (או יותר) למונו: ממוצע הערוצים. */
export function toMono(p: Pcm): Pcm {
  if (p.channels <= 1) return p;
  const n = Math.floor(p.samples.length / p.channels);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < p.channels; c++) s += p.samples[i * p.channels + c];
    out[i] = Math.round(s / p.channels);
  }
  return { samples: out, rate: p.rate, channels: 1 };
}

/**
 * שינוי קצב דגימה (מונו). להורדת קצב: מסנן מעביר-נמוכים (FIR עם חלון Hamming) ואז דגימה בנקודות חדשות עם אינטרפולציה
 * ליניארית. לעליית קצב: אינטרפולציה בלבד. מספיק לדיבור בטלפון (8kHz).
 */
export function resample(p: Pcm, toRate: number): Pcm {
  if (p.channels !== 1) p = toMono(p);
  if (p.rate === toRate) return p;
  let src: Float32Array = Float32Array.from(p.samples);
  if (toRate < p.rate) {
    // תדר חיתוך קצת מתחת לניקוויסט של הקצב החדש, יחסית לקצב המקור
    const fc = 0.45 * (toRate / p.rate);
    const half = 24;
    const taps = new Float32Array(half * 2 + 1);
    let sum = 0;
    for (let i = -half; i <= half; i++) {
      const x = i === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * i) / (Math.PI * i);
      const w = 0.54 + 0.46 * Math.cos((Math.PI * i) / half);
      taps[i + half] = x * w; sum += x * w;
    }
    for (let i = 0; i < taps.length; i++) taps[i] /= sum;
    const filtered = new Float32Array(src.length);
    for (let n = 0; n < src.length; n++) {
      let acc = 0;
      for (let k = -half; k <= half; k++) {
        const j = n + k;
        if (j >= 0 && j < src.length) acc += src[j] * taps[k + half];
      }
      filtered[n] = acc;
    }
    src = filtered;
  }
  const ratio = p.rate / toRate;
  const outLen = Math.max(0, Math.floor(src.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const t = pos - i0;
    const v = src[i0] * (1 - t) + src[i1] * t;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return { samples: out, rate: toRate, channels: 1 };
}

/** כתיבת WAV (PCM 16 ביט). */
export function writeWav(p: Pcm): Buffer {
  const data = Buffer.alloc(p.samples.length * 2);
  for (let i = 0; i < p.samples.length; i++) data.writeInt16LE(p.samples[i], i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(p.channels, 22);
  h.writeUInt32LE(p.rate, 24); h.writeUInt32LE(p.rate * p.channels * 2, 28); h.writeUInt16LE(p.channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** כל קלט (WAV בכל קצב, או PCM גולמי בקצב נתון) לקובץ WAV בפורמט של ימות. */
export function toYemotWav(buf: Buffer, rawRate = 24000): { wav: Buffer; seconds: number } {
  const pcm = buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' ? parseWav(buf) : rawPcm(buf, rawRate);
  const out = resample(toMono(pcm), YEMOT_RATE);
  return { wav: writeWav(out), seconds: out.samples.length / YEMOT_RATE };
}
