// 0.7.8: מפתחות של השירותים החינמיים: Groq (תמלול) ו-Gemini (הקול המשופר). משמש גם באשף וגם בלוח ("הגדרות ותקינות").
// המפתחות נשלחים לסוכן, נבדקים מול השירות, ונשמרים בקבצים במחשב; לא חוזרים ללוח.
import { useEffect, useState } from 'react';

async function setupGet<T>(path: string): Promise<T> {
  const r = await fetch('/api/setup' + path, { credentials: 'same-origin' });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `שגיאה ${r.status}`);
  return b as T;
}
async function setupPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch('/api/setup' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-cp': '1' }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `שגיאה ${r.status}`);
  return b as T;
}

export interface KeysStatus { groq: boolean; gemini: boolean; groqUrl: string; geminiUrl: string }
type Result = { ok: boolean; detail: string } | null;

const SERVICES = [
  {
    id: 'groq' as const, title: 'תמלול: Groq', prefix: 'gsk_',
    what: 'ההקלטות שלך מהטלפון מתומללות בשירות Groq (מודל Whisper), חינם, בלי כרטיס אשראי ובלי התקנה. מהיר מאוד: הקלטה של דקה מתומללת בשניות.',
    steps: ['היכנס ל-Groq (אפשר עם חשבון Google) ופתח את דף המפתחות.', 'לחץ Create API Key, תן שם כלשהו (למשל ClaudePhone), ואשר.', 'העתק את המפתח שמתחיל ב-gsk_ והדבק כאן. הוא מוצג רק פעם אחת.'],
    quota: 'המדרגה החינמית: 2,000 תמלולים ביום ועד 2 שעות שמע בשעה. הרבה מעבר לשימוש בטלפון. אם המפתח חסר או הגיבוי נדרש, ההקלטה מתומללת אצל Claude או במחשב.',
  },
  {
    id: 'gemini' as const, title: 'קול משופר: Gemini', prefix: 'AIza',
    what: 'במקום הקול של ימות, כל מה שהמערכת אומרת לך בטלפון מוקרא בקול של Gemini שנשמע כמו אדם. חינם, עם מפתח של Google AI Studio.',
    steps: ['היכנס ל-Google AI Studio עם חשבון Google ופתח את דף המפתחות.', 'לחץ Create API key (אפשר ליצור פרויקט חדש), ואשר.', 'העתק את המפתח שמתחיל ב-AIza והדבק כאן.'],
    quota: 'המדרגה החינמית מוגבלת במספר בקשות ביום לכל מודל (המספר המדויק מופיע ב-AI Studio, בדף Rate limits). התוכנה חסכונית: הודעות קבועות מופקות פעם אחת ונשמרות, ורק טקסטים חדשים מופקים. כשהמכסה נגמרת או יש תקלה, ההקראה חוזרת אוטומטית לקול של ימות. שים לב: במדרגה החינמית Google רשאית להשתמש בטקסטים לשיפור המוצרים שלה.',
  },
];

export function KeysBox({ compact = false, onChange }: { compact?: boolean; onChange?: (k: KeysStatus) => void }) {
  const [keys, setKeys] = useState<KeysStatus | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({ groq: '', gemini: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<Record<string, Result>>({ groq: null, gemini: null });
  const load = () => setupGet<{ keys: KeysStatus }>('/status').then(s => { setKeys(s.keys); onChange?.(s.keys); }).catch(() => {});
  useEffect(() => { load(); }, []);
  const save = async (id: 'groq' | 'gemini') => {
    setBusy(id); setRes(r => ({ ...r, [id]: null }));
    try {
      const r = await setupPost<{ results: Record<string, Result>; keys: KeysStatus }>('/keys', { [id]: vals[id] });
      setRes(x => ({ ...x, [id]: r.results[id] }));
      if (r.results[id]?.ok) setVals(v => ({ ...v, [id]: '' }));
      setKeys(r.keys); onChange?.(r.keys);
    } catch (e: any) { setRes(x => ({ ...x, [id]: { ok: false, detail: e.message } })); }
    setBusy(null);
  };
  const clear = async (id: 'groq' | 'gemini') => {
    if (!confirm('למחוק את המפתח מהמחשב?')) return;
    setBusy(id);
    try { const r = await setupPost<{ keys: KeysStatus }>('/keys', { clear: [id] }); setKeys(r.keys); onChange?.(r.keys); setRes(x => ({ ...x, [id]: { ok: true, detail: 'המפתח נמחק' } })); }
    catch (e: any) { setRes(x => ({ ...x, [id]: { ok: false, detail: e.message } })); }
    setBusy(null);
  };
  return (
    <div className="stack">
      {SERVICES.map(s => {
        const has = keys?.[s.id] ?? false;
        const url = s.id === 'groq' ? keys?.groqUrl ?? 'https://console.groq.com/keys' : keys?.geminiUrl ?? 'https://aistudio.google.com/apikey';
        const r = res[s.id];
        return (
          <div key={s.id} className="card">
            <div className="row"><b>{s.title}</b><span className={has ? 'muted' : 'muted'}><i className={has ? 'dot green' : 'dot gray'} /> {has ? 'מפתח שמור במחשב' : 'אין מפתח'}</span></div>
            {!compact && <p>{s.what}</p>}
            <details className="help" open={!has && !compact}>
              <summary>איך מפיקים מפתח (חינם)?</summary>
              <ol>{s.steps.map((t, i) => <li key={i}>{i === 0 ? <>{t} <a href={url} target="_blank" rel="noreferrer">פתח את דף המפתחות</a></> : t}</li>)}</ol>
              <p className="hint">{s.quota}</p>
            </details>
            <div className="row">
              <label className="field"><span>{has ? 'מפתח חדש (מחליף את השמור)' : 'הדבק את המפתח'}</span>
                <input type="password" autoComplete="off" dir="ltr" placeholder={s.prefix + '…'} value={vals[s.id]} onChange={e => setVals(v => ({ ...v, [s.id]: e.target.value }))} /></label>
              <div className="wiz-nav">
                <button type="button" className="btn primary" disabled={busy !== null || !vals[s.id].trim()} onClick={() => save(s.id)}>{busy === s.id ? 'בודק…' : 'בדוק ושמור'}</button>
                {has && <button type="button" className="btn" disabled={busy !== null} onClick={() => clear(s.id)}>מחק מפתח</button>}
              </div>
            </div>
            {r && <div className={r.ok ? 'okbox' : 'error'}>{r.ok ? '✓ ' : ''}{r.detail}</div>}
          </div>
        );
      })}
    </div>
  );
}
