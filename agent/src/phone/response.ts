// בניית תשובות לשלוחת API של ימות המשיח. הדפוסים אומתו בשלב 0 (phase0/yemot-smoke*.mjs).
// תשובה היא מחרוזת אחת: פעולות מופרדות ב-&, טקסט להקראה מסומן t-, וקליטה בפקודת read.

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

export class YemotResponse {
  private parts: string[] = [];

  /** הקראת טקסט (ארוך ככל שצריך). */
  say(text: string): this { if (san(text)) this.parts.push('id_list_message=t-' + tts(text)); return this; }

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
    this.parts.push(`read=t-${san(prompt)}=${name},no,${max},${Math.max(min, 1)},${timeout},NO,no,no,,,,${allowEmpty},,no`);
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
    const msgs = texts.map(t => tts(t)).filter(Boolean).join('.t-') || ' ';
    this.parts.push(`read=t-${msgs}=${name},no,${max},${Math.max(min, 1)},${timeout},NO,no,no,,,,${allowEmpty},,no`);
    return this;
  }

  /** הקלדה במקלדת העברית של הטלפון (סיום ב-#). */
  readText(prompt: string, name: string, opts: { max?: number; timeout?: number } = {}): this {
    const { max = 30, timeout = 90 } = opts;
    this.parts.push(`read=t-${san(prompt)}=${name},no,${max},1,${timeout},HebrewKeyboard,no,no,,,,,,,no`);
    return this;
  }

  /** זיהוי דיבור מובנה של ימות: הטקסט חוזר בפרמטר name. */
  readVoice(prompt: string, name: string): this {
    this.parts.push(`read=t-${san(prompt)}=${name},no,voice`);
    return this;
  }

  /** הקלטה לקובץ בשלוחה: נשמר כ-<folder>/<file>.wav; הנתיב חוזר בפרמטר name. */
  record(prompt: string, name: string, folder: string, file: string): this {
    this.parts.push(`read=t-${san(prompt)}=${name},no,record,${folder},${file},no,yes`);
    return this;
  }

  /** חזרה לשלוחה (לולאת המתנה עם מוזיקה; ימות קוראת שוב ל-api_link). */
  goto(folder: string): this { this.parts.push(`go_to_folder=${folder}`); return this; }

  hangup(): this { this.parts.push('go_to_folder=hangup'); return this; }

  toString(): string { return this.parts.join('&'); }
}

export function r(): YemotResponse { return new YemotResponse(); }

/** פרמטרים שמגיעים מימות בכל קריאה. */
export interface YemotQuery {
  ApiCallId?: string; ApiPhone?: string; ApiExtension?: string; ApiDID?: string; hangup?: string;
  [key: string]: string | undefined;
}
