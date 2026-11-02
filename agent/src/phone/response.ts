// בניית תשובות לשלוחת API של ימות המשיח. הדפוסים אומתו בשלב 0 (phase0/yemot-smoke*.mjs).
// תשובה היא מחרוזת אחת: פעולות מופרדות ב-&, טקסט להקראה מסומן t-, וקליטה בפקודת read.
// 0.7.8: עם הקול המשופר (render עם Speaker) טקסט מושמע מקובץ שהופק מראש (f-/שלוחה/תיקייה/קובץ) במקום t-.

/** ניקוי טקסט להקראה: תווים ששוברים את פרוטוקול ימות מוחלפים ברווח. */
export function san(text: unknown): string {
  return String(text ?? '').replace(/[,\-=&|"'.\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** חלוקת טקסט ארוך למקטעי הקראה (מגבלת אורך של ימות למקטע t- אחד). */
export function ttsSegments(text: string, maxLen = 220): string[] {
  const words = san(text).split(' ').filter(Boolean);
  const segs: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > maxLen) { segs.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) segs.push(cur);
  return segs;
}

export function tts(text: string): string { return ttsSegments(text).join('.t-'); }

/** הערך שימות שולחת כשהמשתמש לחץ סולמית בלי ספרות (במסכים שמאפשרים זאת). */
export const EMPTY_VALUE = 'EMPTY';

/**
 * הקול המשופר (0.7.8): מקבל טקסט להקראה ומחזיר נתיב של קובץ בימות (בלי ivr2: ובלי .wav, למשל /9/tts/ab12),
 * שיושמע עם f- במקום t-. null: ימות מקריאים בעצמם.
 */
export type Speaker = (text: string) => Promise<string | null>;

/**
 * חלקי התשובה: הקראה (say), קליטה עם הודעות לפניה (read), ופקודה גולמית. הטקסט נשמר כמו שהוא (עם הפיסוק, לקול המשופר);
 * לקול של ימות הוא מנוקה ומחולק למקטעים בזמן הבנייה.
 */
type Part = { kind: 'say'; text: string } | { kind: 'read'; prompts: string[]; tail: string; split: boolean } | { kind: 'raw'; s: string };

/** טקסט ארוך לקול המשופר: חלוקה לקטעים של עד maxLen תווים, בגבולות משפטים (כל קטע קובץ אחד). */
export function speechChunks(text: string, maxLen = 2500): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  const out: string[] = [];
  let cur = '';
  for (const s of t.split(/(?<=[.!?:;])\s+/)) {
    if (cur && cur.length + 1 + s.length > maxLen) { out.push(cur); cur = s; }
    else cur = (cur + ' ' + s).trim();
    // משפט בודד ארוך מהמגבלה: חותכים במילים
    while (cur.length > maxLen) { const cut = cur.lastIndexOf(' ', maxLen); const at = cut > 0 ? cut : maxLen; out.push(cur.slice(0, at)); cur = cur.slice(at).trim(); }
  }
  if (cur) out.push(cur);
  return out;
}

export class YemotResponse {
  private parts: Part[] = [];

  /** הקראת טקסט (ארוך ככל שצריך). */
  say(text: string): this { if (san(text)) this.parts.push({ kind: 'say', text: String(text ?? '') }); return this; }

  /**
   * קליטת ספרות, בלי שימות תקריא את ההקשה ובלי "לאישור הקישו אחת" אחריה.
   * סדר הערכים (https://f2.freeivr.co.il/topic/56): שם, שימוש בערך קיים, מקסימום, מינימום, זמן המתנה,
   * צורת השמעה (NO), חסימת כוכבית, חסימת אפס, החלפת תו, מקשים מותרים, ניסיונות, ריק מותר (Ok), ערך לריק,
   * נעילת שפת מקלדת, בקשת אישור (no).
   * min=0: אפשר ללחוץ סולמית בלי ספרות, והערך שיגיע הוא EMPTY_VALUE.
   */
  readDigits(prompt: string, name: string, opts: { max?: number; min?: number; timeout?: number } = {}): this {
    const { max = 1, min = 1, timeout = 15 } = opts;
    const allowEmpty = min === 0 ? `Ok,${EMPTY_VALUE}` : ',';
    this.parts.push({ kind: 'read', prompts: [prompt], tail: `=${name},no,${max},${Math.max(min, 1)},${timeout},NO,no,no,,,,${allowEmpty},,no`, split: false });
    return this;
  }

  /**
   * הקראה ארוכה שאפשר לקטוע בהקשה: הטקסט כולו נכנס לתוך פקודת read (כמה מקטעי t- ברצף, כמו ב-id_list_message,
   * ראה https://f2.freeivr.co.il/post/78283), ולכן הקשה באמצע ההקראה נקלטת מיד במקום לחכות לסוף.
   * המקטע האחרון הוא תפריט המקשים. min=0: אם לא הוקש כלום עד תום ההמתנה מגיע EMPTY_VALUE, ולא הקראה חוזרת של הכל.
   */
  readAfter(texts: string[], name: string, opts: { max?: number; min?: number; timeout?: number } = {}): this {
    const { max = 1, min = 1, timeout = 15 } = opts;
    const allowEmpty = min === 0 ? `Ok,${EMPTY_VALUE}` : ',';
    this.parts.push({ kind: 'read', prompts: texts.filter(t => san(t)), tail: `=${name},no,${max},${Math.max(min, 1)},${timeout},NO,no,no,,,,${allowEmpty},,no`, split: true });
    return this;
  }

  /** הקלדה במקלדת העברית של הטלפון (סיום ב-#). */
  readText(prompt: string, name: string, opts: { max?: number; timeout?: number } = {}): this {
    const { max = 30, timeout = 90 } = opts;
    this.parts.push({ kind: 'read', prompts: [prompt], tail: `=${name},no,${max},1,${timeout},HebrewKeyboard,no,no,,,,,,,no`, split: false });
    return this;
  }

  /** הקלטה לקובץ בשלוחה: נשמר כ-<folder>/<file>.wav; הנתיב חוזר בפרמטר name. */
  record(prompt: string, name: string, folder: string, file: string): this {
    this.parts.push({ kind: 'read', prompts: [prompt], tail: `=${name},no,record,${folder},${file},no,yes`, split: false });
    return this;
  }

  /** חזרה לשלוחה (לולאת המתנה עם מוזיקה; ימות קוראת שוב ל-api_link). */
  goto(folder: string): this { this.parts.push({ kind: 'raw', s: `go_to_folder=${folder}` }); return this; }

  hangup(): this { this.parts.push({ kind: 'raw', s: 'go_to_folder=hangup' }); return this; }

  /** הודעות ההקראה של read: מקטעי t- (הודעה בודדת לא מחולקת; ריק: רווח, כדי שהפקודה תישאר תקינה). */
  private static yemotMsgs(p: { prompts: string[]; split: boolean }): string {
    return 't-' + (p.prompts.map(t => p.split ? tts(t) : san(t)).filter(Boolean).join('.t-') || ' ');
  }

  /** התשובה עם הקול של ימות בלבד (t-). */
  toString(): string {
    return this.parts.map(p => p.kind === 'raw' ? p.s : p.kind === 'say' ? 'id_list_message=t-' + tts(p.text) : 'read=' + YemotResponse.yemotMsgs(p) + p.tail).join('&');
  }

  /**
   * התשובה עם הקול המשופר: כל טקסט מופק לקובץ (f-) דרך speak; כשאין קובץ (null) ימות מקריאים אותו (t-).
   * טקסט ארוך מחולק לכמה קבצים. כל הטקסטים של התשובה מופקים במקביל.
   */
  async render(speak?: Speaker): Promise<string> {
    if (!speak) return this.toString();
    const one = async (text: string, split = true): Promise<string> => {
      const chunks = speechChunks(text);
      const files = await Promise.all(chunks.map(c => speak(c).catch(() => null)));
      return chunks.map((c, i) => files[i] ? 'f-' + files[i] : 't-' + (split ? tts(c) : san(c))).join('.');
    };
    const out = await Promise.all(this.parts.map(async p => {
      if (p.kind === 'raw') return p.s;
      if (p.kind === 'say') return 'id_list_message=' + await one(p.text);
      const msgs = (await Promise.all(p.prompts.map(t => one(t, p.split)))).filter(Boolean).join('.') || 't- ';
      return 'read=' + msgs + p.tail;
    }));
    return out.join('&');
  }
}

export function r(): YemotResponse { return new YemotResponse(); }

/** פרמטרים שמגיעים מימות בכל קריאה. */
export interface YemotQuery {
  ApiCallId?: string; ApiPhone?: string; ApiExtension?: string; ApiDID?: string; hangup?: string;
  [key: string]: string | undefined;
}
