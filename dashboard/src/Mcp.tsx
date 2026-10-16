// חיבורי MCP למשימות מהטלפון (לבקשת המשתמש, 16.10): רשימת כל החיבורים שקיימים במחשב, ומתג לכל אחד.
import { useState } from 'react';
import { act, useApi, type McpState, type McpServer } from './api';
import { when, full } from './format';

const SOURCE: Record<McpServer['source'], string> = { 'claude.ai': 'מחבר של claude.ai', local: 'שרת MCP של Claude Code במחשב', plugin: 'תוסף' };
const STATUS: Record<string, { label: string; tone: string }> = {
  connected: { label: 'מחובר', tone: 'ok' }, pending: { label: 'מתחבר', tone: 'warn' }, failed: { label: 'לא מתחבר', tone: 'bad' }, needs_auth: { label: 'דורש התחברות', tone: 'warn' },
};

function label(s: McpServer): string {
  if (s.source === 'claude.ai') return s.name.replace(/^claude\.ai /, '');
  if (s.source === 'plugin') return s.name.split(':').pop() || s.name;
  return s.name;
}

export default function McpConnections() {
  const s = useApi<McpState>('/mcp');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const scan = async () => {
    setBusy(true); setErr(null);
    try { await act('/mcp/scan'); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const toggle = async (slug: string, on: boolean) => {
    if (!s.data) return;
    const enabled = on ? [...new Set([...s.data.enabled, slug])] : s.data.enabled.filter(x => x !== slug);
    setErr(null);
    try { await act('/mcp', { enabled }); } catch (e: any) { setErr(e.message); }
  };
  const servers = s.data?.scan?.servers ?? [];
  const enabled = new Set(s.data?.enabled ?? []);
  // שרת שנבחר בעבר ולא נמצא בסריקה האחרונה: מוצג כדי שאפשר יהיה לכבות אותו
  const missing = [...enabled].filter(slug => !servers.some(x => x.slug === slug));
  const groups: McpServer['source'][] = ['claude.ai', 'local', 'plugin'];
  return (
    <div className="card settings-form mcp">
      <p>Claude Code במחשב מחובר לשירותים: המחברים שחיברת ב-claude.ai (כמו Gmail, Google Drive ויומן), שרתי MCP שהגדרת ב-Claude Code, ושל תוספים. כאן בוחרים אילו מהם <b>פתוחים גם למשימות שנשלחות מהטלפון</b>. ברירת המחדל: אף אחד.</p>
      <div className="row">
        <button className="btn primary" onClick={scan} disabled={busy || s.data?.scanning}>{busy || s.data?.scanning ? 'סורק… (כ-20 שניות)' : s.data?.scan ? 'סרוק שוב' : 'סרוק חיבורים במחשב'}</button>
        {s.data?.scan && <span className="muted">נסרק {when(s.data.scan.at)}{s.data.scan.claudeCodeVersion ? ` · Claude Code ${s.data.scan.claudeCodeVersion}` : ''}</span>}
      </div>
      {err && <div className="error">{err}</div>}
      {s.data && !s.data.scan && <div className="hint">עוד לא נסרק. הסריקה מפעילה את Claude Code לרגע, בדיוק כמו פתיחת חלון טרמינל, וקוראת ממנו את רשימת החיבורים.</div>}
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
                    <span className={`pill ${st.tone}`}>{st.label}</span>
                    <button className="linkbtn" onClick={() => setOpen(open === x.slug ? null : x.slug)}>{x.tools.length === 1 ? 'כלי אחד' : `${x.tools.length} כלים`}</button>
                    {open === x.slug && <div className="mcp-tools" dir="ltr">{x.tools.length ? x.tools.join(', ') : '—'}</div>}
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
        <b>מה קורה במשימה מהטלפון:</b> פעולות קריאה דרך חיבור פתוח (חיפוש, קריאת מייל, רשימת אירועים) רצות בלי לשאול. פעולה שמשנה משהו (שליחת מייל, תשובה, מחיקה, יצירת אירוע) תלויה במצב העבודה: ב"שינויים, פקודות באישור" היא מוקראת לך לאישור בטלפון; ב"אישור אוטומטי" היא רצה לבד; ב"קריאה בלבד" היא נחסמת. חיבור שלא סומן כאן לא זמין ל-Claude במשימות מהטלפון, גם באישור אוטומטי. בטרמינל וב-VS Code החיבורים זמינים תמיד, כמו ב-Claude Code רגיל.
      </div>
      {s.data?.scan && <div className="hint">הסריקה האחרונה: {full(s.data.scan.at)}. אחרי שחיברת שירות חדש ב-claude.ai או הוספת שרת MCP, לחץ "סרוק שוב".</div>}
    </div>
  );
}
