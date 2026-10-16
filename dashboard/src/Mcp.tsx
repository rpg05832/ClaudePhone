// חיבורי MCP למשימות מהטלפון (לבקשת המשתמש, 16.10): רשימת כל החיבורים שקיימים במחשב, ומתג לכל אחד.
import { useEffect, useRef, useState } from 'react';
import { act, useApi, type McpState, type McpServer } from './api';
import { when, full } from './format';

const SOURCE: Record<McpServer['source'], string> = { 'claude.ai': 'מחבר של claude.ai', local: 'שרת MCP של Claude Code במחשב', plugin: 'תוסף' };
const STATUS: Record<string, { label: string; tone: string }> = {
  connected: { label: 'מחובר', tone: 'ok' }, pending: { label: 'עדיין עלה בסיום הסריקה', tone: 'warn' }, failed: { label: 'לא מתחבר', tone: 'bad' },
  needs_auth: { label: 'דורש התחברות', tone: 'warn' }, disabled: { label: 'מושבת ב-Claude Code', tone: 'muted' },
};

function label(s: McpServer): string {
  if (s.source === 'claude.ai') return s.name.replace(/^claude\.ai /, '');
  if (s.source === 'plugin') return s.name.split(':').pop() || s.name;
  return s.name;
}

export default function McpConnections() {
  const s = useApi<McpState>('/mcp');
  // המצב המוצג נשמר כאן (ולא רק ב-useApi) כדי שסימון יופיע מיד, וכדי ששני סימונים מהירים לא ידרסו זה את זה:
  // כל שינוי מחושב מהרשימה העדכנית ונשלח בתור, והתשובה של הסוכן היא האמת.
  const [view, setView] = useState<McpState | null>(null);
  const enabledRef = useRef<string[]>([]);
  const pending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (s.data && pending.current === 0) { enabledRef.current = s.data.enabled; setView(s.data); }
  }, [s.data]);
  const apply = (r: McpState) => { enabledRef.current = r.enabled; setView(r); };
  const scan = async () => {
    setBusy(true); setErr(null);
    try { apply(await act<McpState>('/mcp/scan')); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const toggle = (slug: string, on: boolean) => {
    const cur = enabledRef.current;
    const enabled = on ? [...new Set([...cur, slug])] : cur.filter(x => x !== slug);
    enabledRef.current = enabled;
    setErr(null);
    setView(v => (v ? { ...v, enabled } : v));
    pending.current++;
    chain.current = chain.current
      .then(() => act<McpState>('/mcp', { enabled: enabledRef.current }))
      .then(r => { if (pending.current === 1) apply(r); })
      .catch((e: any) => { setErr(e.message); if (pending.current === 1) s.reload(); })
      .finally(() => { pending.current--; });
  };
  const servers = view?.scan?.servers ?? [];
  const enabled = new Set(view?.enabled ?? []);
  // שרת שנבחר בעבר ולא נמצא בסריקה האחרונה: מוצג כדי שאפשר יהיה לכבות אותו
  const missing = [...enabled].filter(slug => !servers.some(x => x.slug === slug));
  const groups: McpServer['source'][] = ['claude.ai', 'local', 'plugin'];
  const scanning = busy || !!view?.scanning;
  return (
    <div className="card settings-form mcp">
      <p>Claude Code במחשב מחובר לשירותים: המחברים שחיברת ב-claude.ai (כמו Gmail, Google Drive ויומן), שרתי MCP שהגדרת ב-Claude Code, ושל תוספים. כאן בוחרים אילו מהם <b>פתוחים גם למשימות שנשלחות מהטלפון</b>. ברירת המחדל: אף אחד.</p>
      <div className="row">
        <button className="btn primary" onClick={scan} disabled={scanning}>{scanning ? 'סורק… (עד 30 שניות)' : view?.scan ? 'סרוק שוב' : 'סרוק חיבורים במחשב'}</button>
        {view?.scan && <span className="muted">נסרק {when(view.scan.at)}{view.scan.claudeCodeVersion ? ` · Claude Code ${view.scan.claudeCodeVersion}` : ''}</span>}
      </div>
      {err && <div className="error">{err}</div>}
      {view && !view.scan && <div className="hint">עוד לא נסרק. הסריקה מפעילה את Claude Code לרגע, בדיוק כמו פתיחת חלון טרמינל, וקוראת ממנו את רשימת החיבורים.</div>}
      {groups.map(g => {
        const list = servers.filter(x => x.source === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <div className="label">{SOURCE[g]}</div>
            <ul className="mcp-list">
              {list.map(x => {
                const st = STATUS[x.status] ?? { label: x.status, tone: 'muted' };
                return (
                  <li key={x.slug} className={enabled.has(x.slug) ? 'on' : ''}>
                    <label className="check">
                      <input type="checkbox" checked={enabled.has(x.slug)} onChange={e => toggle(x.slug, e.target.checked)} />
                      <b>{label(x)}</b>
                    </label>
                    <span className={`pill ${st.tone}`} title={x.error ?? ''}>{st.label}</span>
                    <button className="linkbtn" onClick={() => setOpen(open === x.slug ? null : x.slug)}>{x.tools.length === 1 ? 'כלי אחד' : `${x.tools.length} כלים`}</button>
                    {open === x.slug && <div className="mcp-tools" dir="ltr">{x.tools.length ? x.tools.join(', ') : '—'}{x.error ? <div className="mcp-error">{x.error}</div> : null}</div>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {missing.length > 0 && <>
        <div className="label">נבחרו בעבר ולא נמצאו בסריקה האחרונה</div>
        <ul className="mcp-list">{missing.map(slug => (
          <li key={slug} className="on"><label className="check"><input type="checkbox" checked onChange={() => toggle(slug, false)} /><b dir="ltr">{slug}</b></label><span className="pill muted">לא נמצא</span></li>
        ))}</ul>
      </>}
      <div className="hint">
        <b>מה הקבוצות:</b> "מחבר של claude.ai" הם השירותים שחיברת בהגדרות claude.ai; "שרת MCP של Claude Code במחשב" הם שרתים שהוגדרו ב-Claude Code עצמו (למשל כלי קבצים, VS Code, שרת שפה); "תוסף" הם שרתים שמגיעים עם תוספים שהתקנת ב-Claude Code.
        <b> מה המצבים:</b> "מחובר" עם רשימת הכלים (לחיצה על "N כלים"); "לא מתחבר" הוא שרת ש-Claude Code לא הצליח להפעיל (חסר מפתח, תוכנה לא מותקנת וכדומה; הסיבה מופיעה בלחיצה על הכלים), וגם במשימה הוא לא יעבוד; "עדיין עלה בסיום הסריקה" הוא שרת איטי שלא הספיק להתחבר בזמן הסריקה: אפשר לסמן אותו, ובמשימה הוא יחכה לו כרגיל.
      </div>
      <div className="hint">
        <b>מה קורה במשימה מהטלפון:</b> פעולות קריאה דרך חיבור פתוח (חיפוש, קריאת מייל, רשימת אירועים) רצות בלי לשאול. פעולה שמשנה משהו (שליחת מייל, תשובה, מחיקה, יצירת אירוע) תלויה במצב העבודה: ב"שינויים, פקודות באישור" היא מוקראת לך לאישור בטלפון; ב"אישור אוטומטי" היא רצה לבד; ב"קריאה בלבד" היא נחסמת. חיבור שלא סומן כאן לא זמין ל-Claude במשימות מהטלפון, גם באישור אוטומטי. בטרמינל וב-VS Code החיבורים זמינים תמיד, כמו ב-Claude Code רגיל.
      </div>
      {view?.scan && <div className="hint">הסריקה האחרונה: {full(view.scan.at)}. אחרי שחיברת שירות חדש ב-claude.ai או הוספת שרת MCP, לחץ "סרוק שוב".</div>}
    </div>
  );
}
