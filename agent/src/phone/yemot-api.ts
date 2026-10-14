// לקוח ל-API של ימות המשיח. חיבור בטוקן בלבד (החלטה 14.10), לעולם לא בסיסמה.
// הקריאות אומתו בשלב 0: UpdateExtension, DownloadFile, RunTzintuk.

export class YemotApi {
  constructor(private token: string, private base = 'https://www.call2all.co.il/ym/api') {}

  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.token, ...body }),
    });
    const json = await res.json().catch(() => ({ responseStatus: 'HTTP_' + res.status }));
    if (json.responseStatus !== 'OK') {
      const err = new Error(`ימות ${method}: ${json.responseStatus}${json.message ? ' — ' + json.message : ''}`);
      (err as any).yemotStatus = json.responseStatus;
      throw err;
    }
    return json;
  }

  /** מגדיר את השלוחה כשלוחת API שמפנה לכתובת המנהרה. */
  /** קול ומהירות ההקראה נשלחים בשני השמות, כי בחלק מהמודולים המפתח הוא tts_voice/tts_rate (https://f2.freeivr.co.il/post/78553). */
  async setApiExtension(extension: string, apiLink: string, tts?: { voice: string; rate: number }): Promise<void> {
    await this.call('UpdateExtension', {
      path: `ivr2:${extension}`, type: 'api', api_link: apiLink,
      api_wait_answer_music_on_hold: 'yes', api_wait_answer_music_on_hold_continue_all_sends: 'yes',
      api_hangup_send: 'yes',
      ...(tts ? { voice: tts.voice, tts_voice: tts.voice, rate: String(tts.rate), tts_rate: String(tts.rate) } : {}),
    });
  }

  /** מוריד קובץ (הקלטה) מהמערכת. */
  async downloadFile(path: string): Promise<Buffer> {
    const full = path.startsWith('ivr2:') ? path : `ivr2:${path.replace(/^\/?/, '/')}`;
    const res = await fetch(`${this.base}/DownloadFile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.token, path: full }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || buf.toString('latin1', 0, 4) !== 'RIFF') {
      throw new Error(`ימות DownloadFile נכשל (${res.status}, ${buf.length} בתים)`);
    }
    return buf;
  }

  /** מוחק קובץ אחרי הורדה תקינה (אפיון 5: הקלטה נמחקת מימות רק אחרי קליטה). */
  async deleteFile(path: string): Promise<void> {
    const full = path.startsWith('ivr2:') ? path : `ivr2:${path.replace(/^\/?/, '/')}`;
    await this.call('FileAction', { action: 'delete', what: full });
  }

  /** פרטי המערכת לבדיקת הטוקן באשף. מחזיר רק מספר מערכת ויחידות; שדות רגישים (סיסמאות) לא יוצאים מכאן. */
  async getSession(): Promise<{ systemNumber: string; units: number | null; name: string | null }> {
    const j = await this.call('GetSession', {});
    return { systemNumber: String(j.username ?? ''), units: typeof j.units === 'number' ? j.units : null, name: j.name ? String(j.name) : null };
  }

  /** תוכן קובץ טקסט במערכת (למשל ext.ini של שלוחה), או null אם אינו קיים. */
  async getTextFile(path: string): Promise<string | null> {
    try {
      const j = await this.call('GetTextFile', { what: path.startsWith('ivr2:') ? path : `ivr2:${path}` });
      return typeof j.contents === 'string' ? j.contents : null;
    } catch { return null; }
  }

  async tzintuk(phones: string[], timeoutSeconds = 9): Promise<void> {
    await this.call('RunTzintuk', { phones, TzintukTimeOut: timeoutSeconds });
  }
}
