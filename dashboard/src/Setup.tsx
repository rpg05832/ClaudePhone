// אשף ההגדרה (אפיון 7): מסך אחרי מסך, כל שלב נשמר מיד. אין כאן סודות מוצגים: הטוקן וה-PIN נשלחים לסוכן ולא חוזרים.
import { useEffect, useRef, useState } from 'react';
import { CreditLine } from './Credits';
import { VOICE_LABEL, MODE_LABEL, PHONE_KIND, when } from './format';

// ---------- תקשורת ----------
async function get<T>(path: string): Promise<T> {
  const r = await fetch('/api/setup' + path, { credentials: 'same-origin' });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `שגיאה ${r.status}`);
  return b as T;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch('/api/setup' + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-cp': '1' }, body: JSON.stringify(body),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `שגיאה ${r.status}`);
  return b as T;
}

interface CheckItem { id: string; name: string; state: string; detail: string; installable?: boolean; sizeMb?: number; required: boolean }
interface NetCheck { host: string; purpose: string; state: 'ok' | 'blocked' | 'unreachable' }
interface Report { items: CheckItem[]; network: NetCheck[] }
interface JobStep { id: string; name: string; state: string; progress: number | null; detail: string }
interface Job { id: string; kind: string; state: 'running' | 'done' | 'failed'; steps: JobStep[]; error: string | null; loginUrl?: string | null; needsCode?: boolean }
interface Status {
  mode: 'setup' | 'running';
  done: { claude: boolean; yemot: boolean; phones: boolean; pin: boolean; projects: boolean; finished: boolean };
  yemot: { extension: string }; phones: string[]; projectsParent: string; projectsExtra: string[];
  claudeProjectsDir?: string | null; desktopProjectsDir?: string;
  platform?: string; osName?: string; gui?: boolean;
}

const STEPS = ['ברוכים הבאים', 'בדיקת המחשב', 'התקנת רכיבים', 'חיבור ל-Claude', 'ימות המשיח', 'טלפונים וקוד', 'פרויקטים', 'העדפות', 'הפעלה ובדיקה'] as const;

function useJob(id: string | null, onEnd?: (j: Job) => void): Job | null {
  const [job, setJob] = useState<Job | null>(null);
  const end = useRef(onEnd); end.current = onEnd;
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const tick = async () => {
      try {
        const j = await get<Job>('/jobs/' + id);
        if (!alive) return;
        setJob(j);
        if (j.state === 'running') setTimeout(tick, 1500); else end.current?.(j);
      } catch { if (alive) setTimeout(tick, 3000); }
    };
    tick();
    return () => { alive = false; };
  }, [id]);
  return job;
}

export default function Setup({ standalone }: { standalone: boolean }) {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  const loadStatus = () => get<Status>('/status').then(setStatus).catch(() => {});
  const runChecks = async () => {
    setChecking(true); setCheckErr(null);
    try { setReport(await get<Report>('/checks')); } catch (e: any) { setCheckErr(e.message); }
    setChecking(false);
  };
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => { if (step === 1 && !report && !checking) runChecks(); }, [step]);

  const next = () => { setStep(s => Math.min(STEPS.length - 1, s + 1)); loadStatus(); scrollTo(0, 0); };
  const back = () => setStep(s => Math.max(0, s - 1));
  const item = (id: string) => report?.items.find(i => i.id === id);

  return (
    <div className={standalone ? 'wizard standalone' : 'wizard'}>
      {standalone && <div className="wiz-brand"><span className="logo" aria-hidden>☎</span><div><b>Claude בטלפון</b><small>הגדרה ראשונית</small></div></div>}
      <ol className="wiz-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'on' : i < step ? 'past' : ''}>
            <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}><span>{i + 1}</span>{s}</button>
          </li>
        ))}
      </ol>
      <section className="wiz-body">
        {step === 0 && <Welcome next={next} />}
        {step === 1 && <Checks report={report} checking={checking} err={checkErr} rerun={runChecks} next={next} back={back} />}
        {step === 2 && <Install report={report} rerun={runChecks} next={next} back={back} />}
        {step === 3 && <ClaudeLogin auth={item('claudeAuth')} rerun={runChecks} next={next} back={back} />}
        {step === 4 && <Yemot status={status} next={next} back={back} />}
        {step === 5 && <Phones status={status} next={next} back={back} />}
        {step === 6 && <ProjectsStep status={status} next={next} back={back} />}
        {step === 7 && <Prefs next={next} back={back} />}
        {step === 8 && <Finish status={status} back={back} />}
      </section>
    </div>
  );
}

function Nav({ back, next, nextLabel = 'המשך' }: { back?: () => void; next?: () => void; nextLabel?: string }) {
  return (
    <div className="wiz-nav">
      {next && <button className="btn primary" type="button" onClick={next}>{nextLabel}</button>}
      {back && <button className="btn" type="button" onClick={back}>חזרה</button>}
    </div>
  );
}

// ---------- 1. ברוכים הבאים ----------
function Welcome({ next }: { next: () => void }) {
  return (
    <div>
      <h1>ברוכים הבאים</h1>
      <p>האשף יכין את המחשב כך שתוכל לתת משימות ל-Claude Code מהטלפון, דרך שלוחה בימות המשיח.</p>
      <ul className="wiz-list">
        <li>נבדוק מה כבר מותקן במחשב ומה חסר. שום דבר לא יורד בלי אישור שלך.</li>
        <li>נחבר את Claude (נדרש מנוי Claude), ואת ימות המשיח עם טוקן API.</li>
        <li>נגדיר מאילו טלפונים מותר להתקשר, וקוד כניסה.</li>
      </ul>
      <p className="hint">הכל רץ על המחשב הזה. לוח הבקרה פתוח רק מהמחשב הזה. אפשר לחזור לאשף בכל זמן מהלוח.</p>
      <Nav next={next} nextLabel="מתחילים" />
      <CreditLine />
    </div>
  );
}

const STATE_UI: Record<string, [string, string]> = {
  ok: ['ok', 'תקין'], missing: ['warn', 'חסר'], old: ['bad', 'לא מספיק'], blocked: ['bad', 'חסום'], error: ['bad', 'שגיאה'], optional: ['muted', 'רשות'],
};

// ---------- 2. בדיקת המחשב ----------
function Checks({ report, checking, err, rerun, next, back }: { report: Report | null; checking: boolean; err: string | null; rerun: () => void; next: () => void; back: () => void }) {
  const blocked = report?.network.filter(n => n.state !== 'ok') ?? [];
  const fatal = report?.items.filter(i => i.required && (i.state === 'old' || i.state === 'error')) ?? [];
  return (
    <div>
      <h1>בדיקת המחשב</h1>
      {checking && <p className="muted">בודק… זה לוקח עד חצי דקה.</p>}
      {err && <div className="error">{err}</div>}
      {report && (
        <>
          <ul className="checks">
            {report.items.map(i => (
              <li key={i.id}>
                <span className={`pill ${STATE_UI[i.state]?.[0] ?? ''}`}>{STATE_UI[i.state]?.[1] ?? i.state}</span>
                <b>{i.name}</b><span className="muted">{i.detail}</span>
              </li>
            ))}
          </ul>
          <h2>גישה לאינטרנט</h2>
          {blocked.length === 0 ? <p className="muted">כל הכתובות הנדרשות פתוחות.</p> : (
            <div className="warnbox">
              <b>כתובות שלא נגישות מהמחשב:</b>
              <ul>{blocked.map(n => <li key={n.host}><code>{n.host}</code> ({n.purpose}) · {n.state === 'blocked' ? 'חסומה בסינון' : 'אין תגובה'}</li>)}</ul>
              <p>אם יש סינון (למשל נטפרי), צריך לבקש פתיחה של הכתובות האלה, ואז לבדוק שוב.</p>
            </div>
          )}
          {fatal.length > 0 && <div className="error">אי אפשר להמשיך: {fatal.map(f => f.name).join(', ')}.</div>}
        </>
      )}
      <div className="wiz-nav">
        <button className="btn primary" onClick={next} disabled={!report || fatal.length > 0}>המשך</button>
        <button className="btn" onClick={rerun} disabled={checking}>בדוק שוב</button>
        <button className="btn" onClick={back}>חזרה</button>
      </div>
    </div>
  );
}

// ---------- 3. התקנת רכיבים ----------
function Install({ report, rerun, next, back }: { report: Report | null; rerun: () => void; next: () => void; back: () => void }) {
  const missing = report?.items.filter(i => i.installable && i.state !== 'ok') ?? [];
  const [sel, setSel] = useState<Set<string>>(() => new Set(missing.map(m => m.id)));
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const job = useJob(jobId, () => rerun());
  const total = missing.filter(m => sel.has(m.id)).reduce((s, m) => s + (m.sizeMb ?? 0), 0);
  const running = job?.state === 'running';
  const start = async () => {
    setErr(null);
    try { const j = await post<Job>('/install', { items: [...sel] }); setJobId(j.id); } catch (e: any) { setErr(e.message); }
  };
  if (!report) return <div><h1>התקנת רכיבים</h1><p className="muted">קודם צריך לבדוק את המחשב.</p><Nav back={back} /></div>;
  return (
    <div>
      <h1>התקנת רכיבים</h1>
      {missing.length === 0 && !job ? <p>כל הרכיבים כבר מותקנים.</p> : !job ? (
        <>
          <p>הרכיבים האלה חסרים. סמן מה להוריד ולהתקין (התקנה למשתמש הנוכחי בלבד, בלי הרשאות מנהל):</p>
          <ul className="checks">
            {missing.map(m => (
              <li key={m.id}>
                <label className="check">
                  <input type="checkbox" checked={sel.has(m.id)} onChange={e => { const s = new Set(sel); e.target.checked ? s.add(m.id) : s.delete(m.id); setSel(s); }} />
                  <b>{m.name}</b>
                </label>
                <span className="muted">{m.sizeMb ? `כ-${m.sizeMb >= 1000 ? (m.sizeMb / 1000).toFixed(1) + ' GB' : m.sizeMb + ' MB'}` : ''}</span>
              </li>
            ))}
          </ul>
          <p className="hint">סה"כ להורדה: כ-{total >= 1000 ? (total / 1000).toFixed(1) + ' GB' : total + ' MB'}. מודל התמלול הוא הגדול; ההורדה יכולה לקחת זמן.</p>
        </>
      ) : (
        <ul className="checks">
          {job.steps.map(s => (
            <li key={s.id}>
              <span className={`pill ${s.state === 'done' ? 'ok' : s.state === 'failed' ? 'bad' : s.state === 'running' ? 'busy' : 'muted'}`}>
                {{ done: 'הושלם', failed: 'נכשל', running: 'בתהליך', pending: 'ממתין', skipped: 'דולג' }[s.state] ?? s.state}
              </span>
              <b>{s.name}</b>
              <span className="muted">{s.detail}</span>
              {s.state === 'running' && s.progress !== null && <progress max={1} value={s.progress} />}
            </li>
          ))}
        </ul>
      )}
      {(err || job?.error) && <div className="error">{err || job?.error}</div>}
      <div className="wiz-nav">
        {!job && missing.length > 0 && <button className="btn primary" onClick={start} disabled={!sel.size}>אני מאשר, הורד והתקן</button>}
        {job?.state === 'failed' && <button className="btn primary" onClick={() => { setJobId(null); }}>נסה שוב</button>}
        <button className={`btn ${missing.length === 0 || job?.state === 'done' ? 'primary' : ''}`} onClick={next} disabled={running}>{missing.length === 0 || job?.state === 'done' ? 'המשך' : 'דלג בינתיים'}</button>
        <button className="btn" onClick={back} disabled={running}>חזרה</button>
      </div>
    </div>
  );
}

// ---------- 4. Claude ----------
function ClaudeLogin({ auth, rerun, next, back }: { auth?: CheckItem; rerun: () => void; next: () => void; back: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const job = useJob(jobId, () => rerun());
  const ok = auth?.state === 'ok' || job?.state === 'done';
  const start = async () => { setErr(null); try { setJobId((await post<Job>('/claude-login', {})).id); } catch (e: any) { setErr(e.message); } };
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const sendCode = async () => { setErr(null); try { await post('/claude-login-code', { jobId, code }); setSent(true); setCode(''); } catch (e: any) { setErr(e.message); } };
  return (
    <div>
      <h1>חיבור ל-Claude</h1>
      {ok ? <p className="okbox">✓ {job?.steps[0]?.detail || auth?.detail || 'מחובר'}</p> : (
        <>
          <p>Claude Code מגיע עם ההתקנה; צריך רק לחבר אותו לחשבון Claude שלך.</p>
          <ol className="wiz-list">
            <li>לחץ על הכפתור. ייפתח דף התחברות של Claude בדפדפן.</li>
            <li>היכנס לחשבון ואשר את החיבור.</li>
            <li>חזור לכאן. האשף יזהה את החיבור לבד.</li>
          </ol>
          {job?.state === 'running' && !job.loginUrl && <p className="muted">ממתין לאישור בדפדפן…</p>}
          {job?.state === 'running' && job.loginUrl && (
            <div className="card">
              <p>אם דף ההתחברות לא נפתח לבד (למשל כשהתוכנה רצה על שרת בלי מסך), פתח את הקישור הזה בכל מחשב או טלפון, אשר את החיבור, והדבק כאן את הקוד שיוצג:</p>
              <p><a href={job.loginUrl} target="_blank" rel="noreferrer">פתיחת דף ההתחברות של Claude</a></p>
              <div className="row">
                <input className="grow" dir="ltr" value={code} onChange={e => setCode(e.target.value)} placeholder="הקוד מדף האישור" aria-label="קוד אישור" />
                <button className="btn" onClick={sendCode} disabled={!code.trim()}>שלח קוד</button>
              </div>
              {sent && <p className="muted">{job.steps[0]?.detail}</p>}
            </div>
          )}
        </>
      )}
      {(err || job?.error) && <div className="error">{err || job?.error}</div>}
      <div className="wiz-nav">
        {!ok && <button className="btn primary" onClick={start} disabled={job?.state === 'running'}>פתח דף התחברות</button>}
        <button className={`btn ${ok ? 'primary' : ''}`} onClick={next}>{ok ? 'המשך' : 'דלג בינתיים'}</button>
        <button className="btn" onClick={back}>חזרה</button>
      </div>
    </div>
  );
}

// ---------- 5. ימות ----------
function Yemot({ status, next, back }: { status: Status | null; next: () => void; back: () => void }) {
  const [token, setToken] = useState('');
  const [ext, setExt] = useState(status?.yemot.extension || '9');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ existingType: string } | null>(null);
  const [saved, setSaved] = useState<{ systemNumber: string; units: number | null } | null>(null);
  const already = status?.done.yemot;
  const submit = async (replace = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await post<any>('/yemot', { token, extension: ext, replace });
      if (r.needsConfirm) setConfirm({ existingType: r.existingType });
      else { setConfirm(null); setSaved(r); setToken(''); }
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <form onSubmit={e => { e.preventDefault(); saved ? next() : submit(); }}>
      <h1>ימות המשיח</h1>
      <p>המערכת עובדת דרך שלוחה במערכת ימות המשיח שלך. השלוחה תוגדר אוטומטית כשלוחת API.</p>
      <details className="help"><summary>איך משיגים טוקן API?</summary>
        <ol>
          <li>נכנסים לאתר הניהול של ימות המשיח עם מספר המערכת והסיסמה.</li>
          <li>בהגדרות המערכת יוצרים טוקן API (מפתח גישה), ומעתיקים אותו.</li>
          <li>מדביקים כאן. הטוקן נשמר רק במחשב הזה, ולא מוצג שוב.</li>
        </ol>
        <p>לא להדביק את הסיסמה של המערכת. רק טוקן.</p>
      </details>
      <label className="field"><span>טוקן API {already && <em className="muted">(כבר שמור. השאר ריק כדי לא לשנות)</em>}</span>
        <input type="password" autoComplete="off" value={token} onChange={e => { setToken(e.target.value); setSaved(null); }} dir="ltr" required={!already} /></label>
      <label className="field short"><span>מספר השלוחה</span>
        <input value={ext} onChange={e => { setExt(e.target.value); setSaved(null); setConfirm(null); }} dir="ltr" inputMode="numeric" required /></label>
      <p className="hint">כדאי לבחור שלוחה פנויה. אם בשלוחה כבר יש משהו אחר, נשאל לפני שמחליפים.</p>
      {confirm && (
        <div className="warnbox">
          <b>בשלוחה {ext} כבר מוגדרת שלוחה מסוג "{confirm.existingType}".</b>
          <p>אם תמשיך, השלוחה תהפוך לשלוחת Claude והתוכן הקיים בה לא יפעל יותר.</p>
          <div className="wiz-nav"><button type="button" className="btn danger" onClick={() => submit(true)} disabled={busy}>כן, להחליף</button><button type="button" className="btn" onClick={() => setConfirm(null)}>אבחר שלוחה אחרת</button></div>
        </div>
      )}
      {saved && <p className="okbox">✓ התחבר למערכת {saved.systemNumber}{saved.units !== null ? ` · יתרת יחידות: ${saved.units}` : ''}. השלוחה {ext} תוגדר בהפעלה.</p>}
      {err && <div className="error">{err}</div>}
      <div className="wiz-nav">
        {saved ? <button className="btn primary" type="submit">המשך</button> : <button className="btn primary" type="submit" disabled={busy || !!confirm}>{busy ? 'בודק…' : 'בדוק ושמור'}</button>}
        {already && !saved && <button className="btn" type="button" onClick={next}>השאר כמו שהוא</button>}
        <button className="btn" type="button" onClick={back}>חזרה</button>
      </div>
    </form>
  );
}

// ---------- 6. טלפונים ו-PIN ----------
function Phones({ status, next, back }: { status: Status | null; next: () => void; back: () => void }) {
  const [phones, setPhones] = useState<string[]>(['']);
  const [pin, setPin] = useState(''); const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasPin = status?.done.pin;
  const submit = async () => {
    setErr(null);
    if (pin !== pin2) return setErr('שני הקודים לא זהים');
    setBusy(true);
    try { await post('/phones', { phones: phones.filter(p => p.trim()), pin }); setPin(''); setPin2(''); next(); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <h1>טלפונים וקוד כניסה</h1>
      <p>רק ממספרים שברשימה אפשר להיכנס לשלוחה, ורק עם הקוד.</p>
      {status?.phones.length ? <p className="hint">כרגע מורשים: {status.phones.join(', ')}. מה שתשמור כאן יחליף את הרשימה.</p> : null}
      {phones.map((p, i) => (
        <div className="row" key={i}>
          <label className="field short"><span>{i === 0 ? 'מספר טלפון' : 'מספר נוסף'}</span>
            <input value={p} onChange={e => setPhones(phones.map((x, j) => j === i ? e.target.value : x))} dir="ltr" inputMode="tel" required={i === 0} placeholder="0501234567" /></label>
          {i > 0 && <button type="button" className="linkbtn" onClick={() => setPhones(phones.filter((_, j) => j !== i))}>הסר</button>}
        </div>
      ))}
      <button type="button" className="linkbtn" onClick={() => setPhones([...phones, ''])}>+ הוסף מספר</button>
      <div className="row">
        <label className="field short"><span>קוד כניסה (4 עד 8 ספרות) {hasPin && <em className="muted">· השאר ריק כדי לא לשנות</em>}</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} required={!hasPin} dir="ltr" /></label>
        <label className="field short"><span>שוב, לאימות</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ''))} required={!hasPin || !!pin} dir="ltr" /></label>
      </div>
      <p className="hint">הקוד נשמר מוצפן (hash) ולא ניתן לשחזר אותו. אחרי 5 ניסיונות שגויים הכניסה ננעלת ל-15 דקות.</p>
      {err && <div className="error">{err}</div>}
      <div className="wiz-nav"><button className="btn primary" type="submit" disabled={busy}>שמור והמשך</button><button className="btn" type="button" onClick={back}>חזרה</button></div>
    </form>
  );
}

// ---------- 7. פרויקטים ----------
interface KnownFolder { path: string; name: string; sources: ('code' | 'desktop' | 'cowork')[]; coworkProjects: string[]; conversations: number; lastUsed: string | null; selected: boolean }
const SRC_LABEL = { code: 'Claude Code', desktop: 'Desktop', cowork: 'Cowork' } as const;

function ProjectsStep({ status, next, back }: { status: Status | null; next: () => void; back: () => void }) {
  const [parent, setParent] = useState(status?.projectsParent ?? '');
  const [known, setKnown] = useState<KnownFolder[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (status && !parent) setParent(status.projectsParent); }, [status]);
  useEffect(() => {
    get<KnownFolder[]>('/known-folders').then(list => {
      setKnown(list);
      setSel(new Set(list.filter(f => f.selected).map(f => f.path)));
      setNames(Object.fromEntries(list.map(f => [f.path, f.name])));
      const knownPaths = new Set(list.map(f => f.path.toLowerCase()));
      setExtra((status?.projectsExtra ?? []).filter(p => !knownPaths.has(p.toLowerCase())).join('\n'));
    }).catch(() => { setKnown([]); setExtra((status?.projectsExtra ?? []).join('\n')); });
  }, []);
  const pickParent = async () => {
    try { const r = await post<{ path: string | null }>('/pick-folder', { initial: parent, title: 'בחר את תיקיית הפרויקטים' }); if (r.path) setParent(r.path); }
    catch (e: any) { setErr(e.message); }
  };
  const toggle = (p: string, on: boolean) => { const s = new Set(sel); on ? s.add(p) : s.delete(p); setSel(s); };
  const shown = (known ?? []).filter(f => !filter || `${f.name} ${f.path} ${f.coworkProjects.join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  const submit = async () => {
    setBusy(true); setErr(null);
    const chosen = (known ?? []).filter(f => sel.has(f.path)).map(f => ({ path: f.path, name: (names[f.path] ?? f.name).trim() }));
    const manual = extra.split('\n').map(s => s.trim()).filter(Boolean);
    try { await post('/projects', { parent, extra: [...chosen, ...manual] }); next(); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <h1>פרויקטים</h1>
      <p>כל תיקייה בתוך תיקיית הפרויקטים היא פרויקט שאפשר לבחור בטלפון. פרויקט חדש שתפתח מהטלפון ייווצר שם.</p>
      <div className="row">
        <label className="field grow"><span>תיקיית הפרויקטים</span><input value={parent} onChange={e => setParent(e.target.value)} dir="ltr" required /></label>
        <button type="button" className="btn" onClick={pickParent}>בחירת תיקייה…</button>
      </div>
      <div className="row chips">
        {status?.claudeProjectsDir && <button type="button" className={`chip ${parent === status.claudeProjectsDir ? 'on' : ''}`} onClick={() => setParent(status.claudeProjectsDir!)}>התיקייה של Claude (עם הפרויקטים של Cowork)</button>}
        {status?.desktopProjectsDir && <button type="button" className={`chip ${parent === status.desktopProjectsDir ? 'on' : ''}`} onClick={() => setParent(status.desktopProjectsDir!)}>{status.platform === 'linux' && status.gui === false ? 'ClaudeProjects בתיקיית הבית' : 'ClaudeProjects בשולחן העבודה'}</button>}
      </div>
      <p className="hint">אפשר לשנות את המיקום אחר כך בלוח הבקרה, בלשונית "פרויקטים", וגם להעביר לשם את הפרויקטים הקיימים.</p>

      <h2>תיקיות שכבר עבדת בהן עם Claude במחשב</h2>
      {known === null ? <p className="muted">מחפש בשיחות Claude Code, Desktop ו-Cowork…</p> : known.length === 0 ? <p className="muted">לא נמצאו תיקיות נוספות.</p> : (
        <>
          <p className="hint">סמן את התיקיות שתרצה לבחור בטלפון. השם הוא מה שיוקרא בטלפון, ואפשר לשנות אותו.</p>
          <div className="row">
            <input className="grow" placeholder="סינון לפי שם או נתיב" value={filter} onChange={e => setFilter(e.target.value)} />
            <button type="button" className="linkbtn" onClick={() => setSel(new Set([...sel, ...shown.map(f => f.path)]))}>סמן הכל</button>
            <button type="button" className="linkbtn" onClick={() => { const s = new Set(sel); shown.forEach(f => s.delete(f.path)); setSel(s); }}>נקה</button>
            <span className="muted">{sel.size} נבחרו</span>
          </div>
          <ul className="folders">
            {shown.map(f => (
              <li key={f.path} className={sel.has(f.path) ? 'on' : ''}>
                <input type="checkbox" checked={sel.has(f.path)} onChange={e => toggle(f.path, e.target.checked)} aria-label={f.name} />
                <div className="f-main">
                  <input className="f-name" value={names[f.path] ?? f.name} onChange={e => setNames({ ...names, [f.path]: e.target.value })} disabled={!sel.has(f.path)} />
                  <div className="path">{f.path}</div>
                </div>
                <div className="f-meta">
                  {f.sources.map(s => <span key={s} className="pill">{SRC_LABEL[s]}</span>)}
                  {f.coworkProjects.length > 0 && <span className="pill src-phone">פרויקט Cowork: {f.coworkProjects.join(', ')}</span>}
                  <div className="muted">{f.conversations ? `${f.conversations} שיחות · ` : ''}{f.lastUsed ? when(f.lastUsed) : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <label className="field"><span>תיקיות נוספות (רשות, נתיב מלא בכל שורה)</span><textarea rows={2} value={extra} onChange={e => setExtra(e.target.value)} dir="ltr" placeholder={status?.platform === 'linux' ? '/home/.../MyProject' : 'C:\\Users\\...\\MyProject'} /></label>
      <p className="hint">Claude יעבוד רק בתוך התיקייה של הפרויקט שבחרת בשיחה. תיקייה שתוריד את הסימון ממנה תצא מהטלפון, וההיסטוריה שלה נשמרת.</p>
      {err && <div className="error">{err}</div>}
      <div className="wiz-nav"><button className="btn primary" type="submit" disabled={busy}>שמור והמשך</button><button className="btn" type="button" onClick={back}>חזרה</button></div>
    </form>
  );
}

// ---------- 8. העדפות ----------
function Prefs({ next, back }: { next: () => void; back: () => void }) {
  const [mode, setMode] = useState<'readonly' | 'edit' | 'auto'>('edit');
  const [voice, setVoice] = useState('ymMale');
  const [rate, setRate] = useState(0);
  const [notify, setNotify] = useState<'on' | 'off'>('on');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetch('/api/overview', { credentials: 'same-origin' }).then(r => r.json()).then(o => { const s = o.settings; if (s) { setMode(s.editMode); setVoice(s.voice); setRate(s.rate); setNotify(s.notify); } }).catch(() => {}); }, []);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await post('/prefs', { editMode: mode, voice, rate, notify }); next(); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const MODE_HELP = { readonly: 'Claude רק קורא ועונה. לא משנה קבצים ולא מריץ פקודות.', edit: 'Claude משנה קבצים בתוך הפרויקט. כל פקודה אחרת מחכה לאישור שלך בטלפון.', auto: 'Claude מבצע הכל בלי לשאול. מתאים כשסומכים על המשימה.' };
  return (
    <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <h1>העדפות</h1>
      <h2>מה Claude רשאי לעשות</h2>
      <div className="radios">
        {(['readonly', 'edit', 'auto'] as const).map(m => (
          <label key={m} className={`radio ${mode === m ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
            <b>{MODE_LABEL[m]}</b><span className="muted">{MODE_HELP[m]}</span>
          </label>
        ))}
      </div>
      <h2>קול ההקראה</h2>
      <div className="row">
        <label className="field short"><span>קול</span><select value={voice} onChange={e => setVoice(e.target.value)}>{Object.entries(VOICE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field short"><span>מהירות</span><select value={rate} onChange={e => setRate(Number(e.target.value))}>
          <option value={-4}>איטי</option><option value={0}>רגיל</option><option value={4}>מהיר</option><option value={8}>מהיר מאוד</option></select></label>
      </div>
      <h2>התראות</h2>
      <label className="check"><input type="checkbox" checked={notify === 'on'} onChange={e => setNotify(e.target.checked ? 'on' : 'off')} /> צינתוק לטלפון כשמשימה מסתיימת או כש-Claude מחכה לאישור (לא בלילה, בשבת ובחג)</label>
      <p className="hint">את כל אלה אפשר לשנות אחר כך מהטלפון, בתפריט ההגדרות (מקש 7).</p>
      {err && <div className="error">{err}</div>}
      <div className="wiz-nav"><button className="btn primary" type="submit" disabled={busy}>שמור והמשך</button><button className="btn" type="button" onClick={back}>חזרה</button></div>
    </form>
  );
}

// ---------- 9. הפעלה ובדיקה ----------
function Finish({ status, back }: { status: Status | null; back: () => void }) {
  const [phase, setPhase] = useState<'ready' | 'starting' | 'running' | 'error'>(status?.mode === 'running' && status.done.finished ? 'running' : 'ready');
  const [notes, setNotes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [health, setHealth] = useState<any>(null);
  const [log, setLog] = useState<any[]>([]);
  const [tz, setTz] = useState<string | null>(null);
  const missing = status ? [!status.done.yemot && 'ימות המשיח', !status.done.phones && 'טלפונים', !status.done.pin && 'קוד כניסה'].filter(Boolean) : [];

  const finish = async () => {
    setErr(null); setPhase('starting');
    try { const r = await post<{ notes: string[] }>('/finish', {}); setNotes(r.notes); } catch (e: any) { setErr(e.message); setPhase('ready'); }
  };
  // אחרי ההפעלה מחדש: ממתינים שהסוכן יעלה במצב מלא, ואז מציגים מצב ויומן שיחות חי
  useEffect(() => {
    if (phase === 'ready' || phase === 'error') return;
    let alive = true; const started = Date.now();
    const tick = async () => {
      try {
        const o = await fetch('/api/overview', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null);
        if (o && alive) {
          setHealth(o.health);
          if (o.mode === 'running') {
            setPhase('running');
            const l = await fetch('/api/phonelog?limit=8', { credentials: 'same-origin' }).then(r => r.json()).catch(() => []);
            if (alive) setLog(l);
          }
        }
      } catch { /* הסוכן עדיין עולה */ }
      if (alive) {
        if (phase === 'starting' && Date.now() - started > 120_000) { setPhase('error'); setErr('הסוכן לא עלה אחרי 2 דקות. אפשר להפעיל אותו מקיצור הדרך "Claude בטלפון".'); return; }
        setTimeout(tick, 2500);
      }
    };
    const t = setTimeout(tick, phase === 'starting' ? 2500 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [phase]);

  const testTz = async () => { setTz(null); try { await post('/test-tzintuk', {}); setTz('נשלח צינתוק. הטלפון אמור לצלצל לרגע.'); } catch (e: any) { setTz(e.message); } };
  const ok = (b: any) => <i className={b ? 'dot green' : b === false ? 'dot red' : 'dot gray'} />;

  return (
    <div>
      <h1>הפעלה ובדיקה</h1>
      {phase === 'ready' && (
        <>
          {missing.length ? <div className="error">חסר עדיין: {missing.join(', ')}. חזור לשלבים האלה.</div> : (
            <>
              <p>הכל מוכן. בלחיצה על "הפעל":</p>
              <ul className="wiz-list">
                <li>הסוכן יעלה מחדש במצב מלא, ויחבר את השלוחה בימות למחשב.</li>
                {status?.platform === 'linux'
                  ? <li>הוא יופעל אוטומטית עם הפעלת המחשב (שירות systemd).</li>
                  : <li>הוא יופעל אוטומטית בכל פעם שנכנסים ל-Windows.</li>}
                {status?.gui !== false && <li>בשולחן העבודה יהיה קיצור דרך ללוח הבקרה.</li>}
              </ul>
            </>
          )}
          {err && <div className="error">{err}</div>}
          <div className="wiz-nav"><button className="btn primary" onClick={finish} disabled={missing.length > 0}>הפעל</button><button className="btn" onClick={back}>חזרה</button></div>
        </>
      )}
      {phase !== 'ready' && (
        <>
          {notes.length > 0 && <ul className="wiz-list">{notes.map(n => <li key={n}>{n}</li>)}</ul>}
          <ul className="health">
            <li>{ok(phase === 'running')}<b>הסוכן</b><span>{phase === 'running' ? 'פועל' : phase === 'starting' ? 'עולה…' : 'לא עלה'}</span></li>
            <li>{ok(health?.tunnel?.ok ?? null)}<b>חיבור לאינטרנט (מנהרה)</b><span>{health?.tunnel?.ok ? 'פעיל' : health?.tunnel?.error ?? 'מתחבר…'}</span></li>
            <li>{ok(health?.yemot?.ok ?? null)}<b>השלוחה בימות</b><span>{health?.yemot?.ok ? `שלוחה ${health.yemot.extension} מחוברת` : 'מתעדכנת…'}</span></li>
            <li>{ok(health?.stt?.ok ?? null)}<b>תמלול</b><span>{health?.stt?.ok ? 'מוכן' : 'נטען (בפעם הראשונה עד דקה)…'}</span></li>
          </ul>
          {err && <div className="error">{err}</div>}
          {phase === 'running' && health?.yemot?.ok && (
            <>
              <h2>שיחת בדיקה</h2>
              <p>התקשר עכשיו מהטלפון למערכת שלך, היכנס לשלוחה {health.yemot.extension}, והקש את הקוד. כאן יופיע מה שקורה בשיחה:</p>
              {log.length === 0 ? <p className="muted">עדיין לא התקבלה שיחה…</p> : (
                <ul className="plain">{log.map((e, i) => <li key={i}><span className="muted">{when(e.at)}</span> · {PHONE_KIND[e.kind] ?? e.kind}{e.detail ? ` · ${e.detail}` : ''}</li>)}</ul>
              )}
              <div className="wiz-nav">
                <button className="btn" onClick={testTz}>שלח צינתוק לבדיקה</button>
                <a className="btn primary" href="#/conversations">סיום, ללוח הבקרה</a>
              </div>
              {tz && <p className="hint">{tz}</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}
