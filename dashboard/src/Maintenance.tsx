// עדכון מתוך התוכנה, ומיקום תיקיית הפרויקטים.
import { useEffect, useRef, useState } from 'react';
import { act, useApi, type UpdateState, type ProjectsLocationInfo } from './api';
import { when } from './format';

// ---------- עדכון ----------

/** פס עליון: גרסה חדשה זמינה, או עדכון שמתבצע עכשיו. */
export function UpdateBanner({ u, reload }: { u: UpdateState | null | undefined; reload: () => void }) {
  const busy = u?.phase === 'downloading' || u?.phase === 'installing';
  useInstallWatch(u, reload);
  if (!u || !u.enabled) return null;
  if (busy) return <div className="update-banner busy"><UpdateProgress u={u} /></div>;
  if (!u.available) return null;
  return (
    <div className="update-banner">
      <span>גרסה <bdi>{u.latest}</bdi> זמינה. אצלך מותקנת <bdi>{u.current}</bdi>.</span>
      <InstallButton u={u} />
      <a href="#/health" className="linkbtn">פרטים</a>
    </div>
  );
}

function UpdateProgress({ u }: { u: UpdateState }) {
  if (u.phase === 'downloading') {
    const pct = Math.round((u.progress ?? 0) * 100);
    return (
      <div className="upd-progress">
        <span>מוריד את גרסה <bdi>{u.latest}</bdi>… <bdi>{pct}%</bdi></span>
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }
  return <span>מתקין את גרסה <bdi>{u.latest}</bdi>. התוכנה תיסגר ותעלה מחדש, והלוח יתחבר לבד בעוד כדקה. אין צורך לסגור את החלון.</span>;
}

function InstallButton({ u }: { u: UpdateState }) {
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setErr(null); try { await act('/update/install'); } catch (e: any) { setErr(e.message); } };
  return <>{<button className="btn primary" onClick={go}>עדכן עכשיו</button>}{err && <span className="error-inline">{err}</span>}</>;
}

/** בזמן הורדה: רענון מהיר של ההתקדמות. בזמן התקנה: ממתינים שהסוכן יעלה בגרסה החדשה ומרעננים את הדף. */
function useInstallWatch(u: UpdateState | null | undefined, reload: () => void) {
  const from = useRef<string | null>(null);
  useEffect(() => {
    if (!u) return;
    if (u.phase === 'downloading') { const t = setInterval(reload, 1000); return () => clearInterval(t); }
    if (u.phase !== 'installing') return;
    from.current = u.current;
    const t = setInterval(async () => {
      try {
        const r = await fetch('/api/overview', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return;
        const o = await r.json();
        if (o?.update?.current && o.update.current !== from.current) location.reload();
      } catch { /* הסוכן עדיין לא עלה */ }
    }, 3000);
    return () => clearInterval(t);
  }, [u?.phase]);
}

/** בלשונית "הגדרות ותקינות": גרסה, בדיקה, התקנה, מאגר ועדכון אוטומטי. */
export function UpdateBox({ u, reload }: { u: UpdateState | null | undefined; reload: () => void }) {
  const [repo, setRepo] = useState(u?.repo ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (u?.repo) setRepo(u.repo); }, [u?.repo]);
  if (!u) return null;
  if (!u.enabled) return <div className="card settings-form"><p className="muted">{u.disabledReason}</p></div>;
  const check = async () => { setChecking(true); setMsg(null); try { await act('/update/check'); reload(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } setChecking(false); };
  const saveRepo = async () => { setMsg(null); try { await act('/update/settings', { repo }); setMsg({ ok: true, text: 'נשמר ונבדק' }); reload(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } };
  const setAuto = async (auto: boolean) => { try { await act('/update/settings', { auto }); reload(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } };
  const busy = u.phase === 'downloading' || u.phase === 'installing';
  return (
    <div className="card settings-form update-box">
      <div className="row">
        <b>גרסה מותקנת: <bdi>{u.current}</bdi></b>
        {u.available ? <span className="pill warn">גרסה {u.latest} זמינה</span> : u.latest && !u.error ? <span className="pill ok">זו הגרסה האחרונה</span> : null}
        <span className="muted">{u.checkedAt ? `נבדק ${when(u.checkedAt)}` : 'עוד לא נבדק'}</span>
      </div>
      {busy ? <UpdateProgress u={u} /> : (
        <div className="row">
          {u.available && <InstallButton u={u} />}
          <button className="btn" onClick={check} disabled={checking || u.phase === 'checking'}>{checking || u.phase === 'checking' ? 'בודק…' : 'בדוק עכשיו'}</button>
          {u.pageUrl && <a href={u.pageUrl} target="_blank" rel="noreferrer" className="linkbtn">דף הגרסה ב-GitHub</a>}
        </div>
      )}
      {u.error && <div className="error">{u.error}</div>}
      {u.available && u.notes && <details><summary>מה חדש בגרסה {u.latest}</summary><div className="notes" dir="auto">{u.notes}</div></details>}
      <label className="check"><input type="checkbox" checked={u.auto} onChange={e => setAuto(e.target.checked)} /> להתקין עדכונים לבד, כשאין משימה פעילה ואין שיחת טלפון</label>
      <div className="row">
        <label className="field grow"><span>מאגר העדכונים ב-GitHub</span><input value={repo} onChange={e => setRepo(e.target.value)} dir="ltr" placeholder="owner/repo" /></label>
        {repo !== u.repo && <button className="btn" onClick={saveRepo}>שמור</button>}
      </div>
      <p className="hint">התוכנה בודקת כל כמה שעות אם יש גרסה חדשה ב-Releases של המאגר. המאגר צריך להיות ציבורי, או לפחות ה-Releases שבו. ההגדרות, הפרויקטים וההיסטוריה נשמרים בעדכון.</p>
      {msg && <div className={msg.ok ? 'hint' : 'error'}>{msg.text}</div>}
    </div>
  );
}

// ---------- תיקיית הפרויקטים ----------

interface MoveResult { parent: string; moved: { name: string; from: string; to: string; transcripts: number }[]; skipped: { name: string; reason: string }[]; added: number }

export function LocationCard() {
  const s = useApi<ProjectsLocationInfo>('/projects-location');
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<MoveResult | null>(null);
  const info = s.data;
  if (!info) return null;
  const pick = async () => {
    setErr(null);
    try { const r = await act<{ path: string | null }>('/pick-folder', { initial: target || info.parent, title: 'בחר את תיקיית הפרויקטים' }); if (r.path) setTarget(r.path); }
    catch (e: any) { setErr(e.message); }
  };
  const save = async () => {
    setBusy(true); setErr(null); setResult(null);
    try { const r = await act<MoveResult>('/projects/location', { parent: target, move }); setResult(r); setOpen(false); s.reload(); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const same = target.trim().toLowerCase().replace(/[\\/]+$/, '') === info.parent.toLowerCase().replace(/[\\/]+$/, '');
  return (
    <div className="card location">
      <div className="row">
        <b>תיקיית הפרויקטים</b>
        <span className="path grow" dir="ltr">{info.parent}</span>
        {!open && <button className="btn" onClick={() => { setOpen(true); setTarget(''); setMove(false); setResult(null); }}>שינוי מיקום</button>}
      </div>
      <div className="hint">כאן נוצרים פרויקטים חדשים (מהטלפון במקש 3 ומהלוח), וכל תיקייה שבתוכה מופיעה כפרויקט.</div>
      {open && (
        <div className="loc-edit">
          <div className="loc-options" role="radiogroup" aria-label="מיקום חדש">
            {info.suggestions.filter(x => !x.current).map(x => (
              <label key={x.path} className={`radio ${target === x.path ? 'on' : ''}`}>
                <input type="radio" name="loc" checked={target === x.path} onChange={() => setTarget(x.path)} />
                <span><b>{x.label}</b><span className="path" dir="ltr">{x.path}</span>{!x.exists && <span className="muted"> (תיווצר)</span>}</span>
              </label>
            ))}
          </div>
          <div className="row">
            <input className="grow" dir="ltr" placeholder="או נתיב אחר, למשל D:\Projects" value={target} onChange={e => setTarget(e.target.value)} />
            <button className="btn" type="button" onClick={pick}>בחירת תיקייה…</button>
          </div>
          {info.inside.length > 0 && (
            <div className="loc-move">
              <label className="check"><input type="radio" name="mv" checked={!move} onChange={() => setMove(false)} /> רק פרויקטים חדשים ייווצרו במקום החדש. הקיימים נשארים איפה שהם</label>
              <label className="check"><input type="radio" name="mv" checked={move} onChange={() => setMove(true)} /> להעביר גם את {info.inside.length === 1 ? 'הפרויקט שבתיקייה הנוכחית' : `${info.inside.length} הפרויקטים שבתיקייה הנוכחית`}: {info.inside.map(p => p.name).join(', ')}</label>
              {move && <p className="hint">התיקיות זזות עם כל הקבצים, וגם שיחות Claude Code שלהן עוברות, כך שאפשר להמשיך אותן מהטלפון, מהלוח ומהטרמינל. פרויקט שיש בו משימה פעילה או שיחה פתוחה, או שקובץ בו פתוח בתוכנה אחרת, יישאר במקומו. באפליקציית Claude Desktop שיחות ישנות של פרויקט שהועבר עדיין מכוונות לתיקייה הישנה, לכן שם עדיף לפתוח שיחה חדשה.</p>}
            </div>
          )}
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button className="btn primary" onClick={save} disabled={busy || !target.trim() || same}>{busy ? 'שומר…' : move ? 'העבר ושמור' : 'שמור'}</button>
            <button className="btn" onClick={() => setOpen(false)}>ביטול</button>
          </div>
        </div>
      )}
      {result && (
        <div className="okbox">
          <div>תיקיית הפרויקטים עכשיו: <span dir="ltr">{result.parent}</span></div>
          {result.moved.length > 0 && <div>הועברו: {result.moved.map(m => `${m.name}${m.transcripts ? ` (${m.transcripts} שיחות)` : ''}`).join(', ')}</div>}
          {result.added > 0 && <div>{result.added === 1 ? 'נוסף פרויקט אחד' : `נוספו ${result.added} פרויקטים`} מהתיקייה החדשה</div>}
          {result.skipped.length > 0 && <div className="error">לא הועברו: {result.skipped.map(x => `${x.name} (${x.reason})`).join('; ')}</div>}
        </div>
      )}
    </div>
  );
}
