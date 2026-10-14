import { useEffect, useMemo, useState } from 'react';
import { act, useApi, useLiveConnected, type Overview, type Conversation, type Task, type HistoryMessage, type PermissionRequest, type Project, type PhoneLogEntry } from './api';
import Setup from './Setup';
import Help from './Help';
import { CreditLine } from './Credits';
import { UpdateBanner, UpdateBox, LocationCard } from './Maintenance';
import { MODEL_LABEL, EFFORT_LABEL, when, until, full, STATE_LABEL, stateTone, SOURCE_LABEL, DECISION_LABEL, VIA_LABEL, MODE_LABEL, VOICE_LABEL, PHONE_KIND } from './format';

// ---------- ניתוב פשוט לפי hash ----------
function useRoute(): string[] {
  const [h, setH] = useState(location.hash.slice(1) || '/conversations');
  useEffect(() => { const f = () => setH(location.hash.slice(1) || '/conversations'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h.split('/').filter(Boolean);
}
const go = (p: string) => { location.hash = p; };

export default function App() {
  const route = useRoute();
  const ov = useApi<Overview>('/overview');
  const page = route[0] ?? 'conversations';
  if (!ov.data && !ov.error) return <div className="boot">טוען את לוח הבקרה</div>;
  if (ov.data?.mode === 'setup') return <Setup standalone />;
  const nav: [string, string, number?][] = [
    ['conversations', 'שיחות'],
    ['tasks', 'משימות', ov.data?.counts.active || undefined],
    ['approvals', 'אישורים', ov.data?.counts.pending || undefined],
    ['projects', 'פרויקטים'],
    ['live', 'שיחה פתוחה'],
    ['phone', 'יומן טלפון'],
    ['health', 'הגדרות ותקינות'],
    ['setup', 'אשף הגדרה'],
    ['help', 'עזרה'],
  ];
  const pending = ov.data?.counts.pending ?? 0;
  return (
    <div className="shell">
      <header className="top">
        <div className="top-row">
          <a className="brand" href="#/conversations">
            <svg className="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M9 5c1.2 0 2 .7 2.4 1.8l1.4 3.9c.3 1 0 2-.8 2.6l-1.7 1.3a14 14 0 0 0 7.1 7.1l1.3-1.7c.6-.8 1.6-1.1 2.6-.8l3.9 1.4c1.1.4 1.8 1.2 1.8 2.4V27c0 1.1-.9 2-2 2C14.1 29 3 17.9 3 7c0-1.1.9-2 2-2h4z" /></svg>
            <span><b>Claude בטלפון</b><small>לוח הבקרה של המחשב</small></span>
          </a>
          {ov.data && <span className="mode-chip" title="מצב העבודה של Claude">{MODE_LABEL[ov.data.settings.editMode]}{ov.data.health.quiet?.quiet ? ', זמן שקט' : ''}</span>}
        </div>
        <LineStrip ov={ov.data} />
        <nav className="tabs" aria-label="ניווט">
          {nav.map(([k, label, badge]) => (
            <a key={k} href={`#/${k}`} className={page === k ? 'on' : ''} aria-current={page === k ? 'page' : undefined}>
              {label}{badge ? <span className={`badge ${k === 'approvals' ? 'warn' : ''}`}>{badge}</span> : null}
            </a>
          ))}
        </nav>
      </header>
      <UpdateBanner u={ov.data?.update} reload={ov.reload} />
      {pending > 0 && page !== 'approvals' && (
        <a className="waiting-banner" href="#/approvals">
          <span className="lamp" aria-hidden="true" />
          {pending === 1 ? 'Claude מחכה להחלטה שלך' : `${pending} בקשות מחכות להחלטה שלך`}
          <u>לאישורים</u>
        </a>
      )}
      <main>
        {page === 'conversations' && !route[1] && <Conversations />}
        {page === 'conversations' && route[1] && <ConversationView id={route[1]} />}
        {page === 'tasks' && <Tasks />}
        {page === 'approvals' && <Approvals />}
        {page === 'projects' && <Projects />}
        {page === 'live' && <Live />}
        {page === 'phone' && <PhoneLog />}
        {page === 'health' && <Health ov={ov.data} reload={ov.reload} />}
        {page === 'setup' && <Setup standalone={false} />}
        {page === 'help' && <Help />}
      </main>
      <footer className="foot"><CreditLine /></footer>
    </div>
  );
}

// ---------- הקו: הדרך מהטלפון אל Claude, תחנה אחרי תחנה ----------
function LineStrip({ ov }: { ov: Overview | null }) {
  const live = useLiveConnected();
  const h = ov?.health ?? {};
  const stops: { name: string; ok: boolean | null; detail: string }[] = [
    { name: 'הטלפון', ok: h.yemot?.ok ?? null, detail: h.yemot?.ok ? `שלוחה ${h.yemot.extension}` : 'השלוחה לא מחוברת' },
    { name: 'ימות המשיח', ok: h.yemot?.ok ?? null, detail: h.yemot?.ok ? `עודכנה ${when(h.yemot.updatedAt)}` : 'ממתין' },
    { name: 'מנהרה', ok: h.tunnel?.ok ?? null, detail: h.tunnel?.ok ? `פעילה ${when(h.tunnel.since)}` : h.tunnel?.error ?? 'מתחברת' },
    { name: 'המחשב', ok: live, detail: live ? 'הסוכן פועל' : 'אין חיבור לסוכן' },
    { name: 'תמלול', ok: h.stt?.ok ? true : null, detail: h.stt?.ok ? 'מוכן' : 'נטען' },
    { name: 'Claude', ok: h.claude ? true : null, detail: h.claude?.busyWith ? 'עובד על משימה' : 'פנוי' },
  ];
  const state = (ok: boolean | null) => ok === null ? 'wait' : ok ? 'ok' : 'down';
  return (
    <ol className="line" aria-label="מצב החיבור מהטלפון אל Claude">
      {stops.map(st => (
        <li key={st.name} className={`stop ${state(st.ok)}`} title={st.detail}>
          <i aria-hidden="true" />
          <span className="stop-name">{st.name}</span>
          <span className="stop-detail">{st.detail}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------- שיחות ----------
function Conversations() {
  const [q, setQ] = useState('');
  const [proj, setProj] = useState(() => { try { const v = sessionStorage.getItem('cp-proj') ?? ''; sessionStorage.removeItem('cp-proj'); return v; } catch { return ''; } });
  const [src, setSrc] = useState('');
  const [all, setAll] = useState(false);
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (proj) params.set('project', proj);
  if (src) params.set('source', src);
  if (all) params.set('all', '1');
  const list = useApi<Conversation[]>('/conversations?' + params.toString());
  const projects = useApi<Project[]>('/projects');
  return (
    <section>
      <div className="head"><h1>שיחות</h1><span className="muted">{list.data ? `${list.data.length} שיחות` : ''}</span></div>
      <div className="filters">
        <input type="search" placeholder="חיפוש בכותרות, במשימות ובתוכן השיחות" value={q} onChange={e => setQ(e.target.value)} />
        <select value={proj} onChange={e => setProj(e.target.value)}>
          <option value="">כל הפרויקטים</option>
          {projects.data?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={src} onChange={e => setSrc(e.target.value)}>
          <option value="">כל המקורות</option>
          {['phone', 'desktop', 'cowork', 'cli', 'vscode', 'sdk'].map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </select>
        <label className="toggle"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> גם שיחות מחוץ לפרויקטים הרשומים</label>
      </div>
      <Loading s={list} />
      {list.data?.length === 0 && <Empty>אין שיחות{debounced ? ' שמתאימות לחיפוש' : ''}. שיחה חדשה נפתחת מהטלפון במקש 3.</Empty>}
      <ul className="cards">
        {list.data?.map(c => (
          <li key={c.id} className="card link" onClick={() => go(`/conversations/${c.id}`)}>
            <div className="row">
              <b className="title">{c.title}</b>
              <span className="muted nowrap">{when(c.lastActiveAt)}</span>
            </div>
            <div className="row meta">
              <span>{c.projectName ?? 'בלי פרויקט'}</span>
              <span className={`pill src-${c.source}`}>{SOURCE_LABEL[c.source]}</span>
              {c.coworkProject && c.coworkProject !== c.projectName && <span className="pill">פרויקט Cowork: {c.coworkProject}</span>}
              {c.archived && <span className="pill muted">בארכיון</span>}
              {c.active && <span className="pill busy">פעילה כרגע</span>}
              {!c.canContinue && c.source !== 'phone' && <span className="pill muted" title={c.blockedReason ?? ''}>לא להמשך מהטלפון</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConversationView({ id }: { id: string }) {
  const s = useApi<{ entry: Conversation; messages: HistoryMessage[]; tasks: Task[] }>(`/conversations/${id}`);
  const [showTools, setShowTools] = useState(false);
  if (!s.data) return <section><a className="back" href="#/conversations">→ כל השיחות</a><Loading s={s} /></section>;
  const { entry, messages, tasks } = s.data;
  const msgs = showTools ? messages : messages.filter(m => m.role !== 'tool');
  return (
    <section>
      <a className="back" href="#/conversations">→ כל השיחות</a>
      <div className="head"><h1>{entry.title}</h1></div>
      <div className="row meta big">
        <span>{entry.projectName ?? 'בלי פרויקט'}</span>
        <span className={`pill src-${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
        {entry.coworkProject && <span className="pill">פרויקט Cowork: {entry.coworkProject}</span>}
        {entry.active && <span className="pill busy">פעילה כרגע</span>}
        <span className="muted">עודכנה {full(entry.lastActiveAt)}</span>
        {!entry.canContinue && entry.blockedReason && <span className="muted">· {entry.blockedReason}</span>}
      </div>

      {(entry.canContinue || entry.source === 'phone') && entry.projectId
        ? <Composer conversationId={entry.id} placeholder="המשך השיחה: מה לעשות עכשיו?" />
        : <p className="hint">{entry.blockedReason ?? 'אי אפשר להמשיך את השיחה הזו מכאן'}</p>}

      {tasks.length > 0 && <>
        <h2>מה נשלח מהטלפון ומהלוח</h2>
        <div className="stack">{tasks.map(t => <TaskCard key={t.id} t={t} />)}</div>
      </>}

      <div className="row between"><h2>השיחה המלאה</h2>
        {messages.some(m => m.role === 'tool') && <label className="toggle"><input type="checkbox" checked={showTools} onChange={e => setShowTools(e.target.checked)} /> הצג פעולות של Claude</label>}
      </div>
      {!entry.inHistory && <Empty>היסטוריית Claude של השיחה הזו לא נמצאה במחשב.</Empty>}
      <div className="timeline">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="who">{m.role === 'user' ? 'אתה' : m.role === 'assistant' ? 'Claude' : `פעולה: ${m.tool?.name}`}<span>{when(m.at)}</span></div>
            {m.role === 'tool' ? <code className="tool">{m.tool?.input}</code> : <div className="text">{m.text}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskCard({ t }: { t: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card task">
      <div className="row">
        <b>משימה {t.num}</b>
        <span className={`pill ${stateTone(t.state)}`}>{STATE_LABEL[t.state]}</span>
        {t.state === 'done' && !t.heard && <span className="pill warn">טרם נשמעה</span>}
        {t.model && <span className="pill">{t.model}</span>}
        <span className="muted grow">{full(t.createdAt)}</span>
      </div>
      <div className="label">{t.source === 'dashboard' ? 'נכתב בלוח הבקרה' : 'התמלול שאושר'}</div>
      <div className="quote">{t.prompt || '—'}</div>
      {t.hasRecording && <audio controls preload="none" src={`/api/recordings/${t.id}`} />}
      {t.resultSummary && <><div className="label">{t.source === 'dashboard' ? 'סיכום' : 'מה הוקרא בטלפון'}</div><div className="spoken">{t.resultSummary}</div></>}
      {t.error && <div className="error">{t.error}</div>}
      <TaskActions t={t} />
      {t.resultText && <>
        <button className="linkbtn" onClick={() => setOpen(o => !o)}>{open ? 'הסתר' : 'הצג'} את התשובה המלאה של Claude</button>
        {open && <div className="text full">{t.resultText}</div>}
      </>}
    </div>
  );
}

// ---------- שליחת משימה (שלב 4) ----------
function Composer({ conversationId, projectId, placeholder }: { conversationId?: string; projectId?: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [model, setModel] = useState('default');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const t = await act<Task>('/tasks', { conversationId, projectId, prompt: text, model });
      setText(''); setMsg({ ok: true, text: `משימה ${t.num} נכנסה לתור. התשובה תופיע כאן ובעמוד המשימות.` });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };
  return (
    <div className="composer">
      <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={placeholder}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
      <div className="row">
        <button className="btn primary" onClick={send} disabled={busy || !text.trim() || (!conversationId && !projectId)}>{busy ? 'שולח…' : 'שלח ל-Claude'}</button>
        <select value={model} onChange={e => setModel(e.target.value)} aria-label="מודל">
          <option value="default">מודל לפי ההגדרות</option>
          {['fable', 'opus', 'sonnet', 'haiku'].map(m => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
        </select>
        <span className="muted">Ctrl+Enter לשליחה · ההרשאות לפי מצב העבודה</span>
      </div>
      {msg && <div className={msg.ok ? 'okbox' : 'error'}>{msg.text}</div>}
    </div>
  );
}

function NewTask() {
  const projects = useApi<Project[]>('/projects');
  const [pid, setPid] = useState('');
  const enabled = (projects.data ?? []).filter(p => p.phoneEnabled);
  return (
    <details className="card newtask">
      <summary><b>משימה חדשה</b> <span className="muted">שיחה חדשה בפרויקט, מהמחשב</span></summary>
      <select value={pid} onChange={e => setPid(e.target.value)}>
        <option value="">בחר פרויקט</option>
        {enabled.map(p => <option key={p.id} value={p.id}>{p.spokenName}</option>)}
      </select>
      <Composer projectId={pid || undefined} placeholder="מה Claude צריך לעשות?" />
    </details>
  );
}

function TaskActions({ t }: { t: Task }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string) => { setBusy(true); setErr(null); try { await act(path); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const active = ['queued', 'running', 'awaiting_permission', 'awaiting_answer'].includes(t.state);
  if (!active && !(t.state === 'done' && !t.heard)) return null;
  return (
    <div className="row actions">
      {active && <button className="btn danger" disabled={busy} onClick={() => run(`/tasks/${t.id}/stop`)}>{t.state === 'queued' ? 'בטל' : 'עצור'}</button>}
      {t.state === 'done' && !t.heard && <button className="btn" disabled={busy} onClick={() => run(`/tasks/${t.id}/heard`)}>סמן כנקרא</button>}
      {err && <span className="error">{err}</span>}
    </div>
  );
}

// ---------- משימות ----------
function Tasks() {
  const [onlyActive, setOnlyActive] = useState(false);
  const list = useApi<Task[]>(onlyActive ? '/tasks?state=active' : '/tasks');
  const [sel, setSel] = useState<string | null>(null);
  return (
    <section>
      <div className="head"><h1>משימות</h1>
        <label className="toggle"><input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} /> רק פעילות</label>
      </div>
      <NewTask />
      <Loading s={list} />
      {list.data?.length === 0 && <Empty>אין משימות{onlyActive ? ' פעילות' : ''}.</Empty>}
      {!!list.data?.length && (
        <table>
          <thead><tr><th>#</th><th>פרויקט</th><th>מצב</th><th>המשימה</th><th>נוצרה</th></tr></thead>
          <tbody>
            {list.data.map(t => (
              <tr key={t.id} className="link" onClick={() => setSel(t.id)}>
                <td>{t.num}</td><td>{t.projectName}</td>
                <td><span className={`pill ${stateTone(t.state)}`}>{STATE_LABEL[t.state]}</span></td>
                <td className="clip">{t.prompt || '—'}</td><td className="nowrap muted">{when(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sel && <TaskDrawer id={sel} onClose={() => setSel(null)} />}
    </section>
  );
}

function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useApi<{ task: Task; events: any[]; permissions: PermissionRequest[] }>(`/tasks/${id}`);
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal>
        <button className="close" onClick={onClose} aria-label="סגירה">×</button>
        {!s.data ? <Loading s={s} /> : <>
          <TaskCard t={s.data.task} />
          {s.data.task.conversationId && <a className="linkbtn" href={`#/conversations/${s.data.task.conversationId}`} onClick={onClose}>לשיחה המלאה ←</a>}
          <h3>מהלך המשימה</h3>
          <ol className="events">
            {s.data.events.map((e, i) => <li key={i}><b>{STATE_LABEL[e.to_state as keyof typeof STATE_LABEL] ?? e.to_state}</b> <span className="muted">{full(e.at)} · {e.actor}{e.reason ? ` · ${e.reason}` : ''}</span></li>)}
          </ol>
          {s.data.permissions.length > 0 && <>
            <h3>בקשות והחלטות</h3>
            <ul className="plain">{s.data.permissions.map(p => <li key={p.id}><PermLine p={p} /></li>)}</ul>
          </>}
        </>}
      </div>
    </div>
  );
}

// ---------- אישורים ----------
function Approvals() {
  const s = useApi<{ pending: PermissionRequest[]; recent: PermissionRequest[] }>('/permissions');
  return (
    <section>
      <div className="head"><h1>אישורים ושאלות</h1></div>
      <Loading s={s} />
      {s.data && <>
        <h2>ממתינים לך ({s.data.pending.length})</h2>
        {s.data.pending.length === 0 && <Empty>אין בקשות פתוחות.</Empty>}
        <div className="stack">
          {s.data.pending.map(p => (
            <div key={p.id} className="card pending">
              <div className="row"><b>{p.toolName === 'AskUserQuestion' ? 'שאלה' : 'בקשת אישור'}</b><span className="muted">משימה {p.taskNum} · {p.projectName}</span><span className="muted grow">פג תוקף {until(p.expiresAt)}</span></div>
              {p.toolName !== 'AskUserQuestion' && <div className="quote">{p.summary}</div>}
              <Decide p={p} />
            </div>
          ))}
        </div>
        <h2>החלטות אחרונות</h2>
        {s.data.recent.length === 0 ? <Empty>עוד לא התקבלו החלטות.</Empty> : (
          <table>
            <thead><tr><th>מתי</th><th>משימה</th><th>בקשה</th><th>החלטה</th></tr></thead>
            <tbody>{s.data.recent.map(p => (
              <tr key={p.id}><td className="nowrap muted">{when(p.decidedAt ?? p.createdAt)}</td><td>{p.taskNum}</td><td className="clip">{p.summary}</td><td><PermDecision p={p} /></td></tr>
            ))}</tbody>
          </table>
        )}
      </>}
    </section>
  );
}

function Decide({ p }: { p: PermissionRequest }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [free, setFree] = useState<Record<string, string>>({});
  const send = async (body: unknown) => { setBusy(true); setErr(null); try { await act(`/permissions/${p.id}`, body); } catch (e: any) { setErr(e.message); } setBusy(false); };
  if (p.toolName === 'AskUserQuestion') {
    const qs: any[] = Array.isArray(p.input?.questions) ? p.input.questions : [];
    return (
      <div className="stack">
        {qs.map((q, i) => (
          <div key={i}>
            <div className="quote">{q.question}</div>
            <div className="row actions">
              {(q.options ?? []).map((o: any) => (
                <button key={o.label} className="btn" disabled={busy} title={o.description ?? ''} onClick={() => send({ decision: 'answer', answers: { [q.question]: o.label } })}>{o.label}</button>
              ))}
            </div>
            <div className="row actions">
              <input className="grow" placeholder="או תשובה חופשית" value={free[q.question] ?? ''} onChange={e => setFree({ ...free, [q.question]: e.target.value })} />
              <button className="btn" disabled={busy || !(free[q.question] ?? '').trim()} onClick={() => send({ decision: 'answer', answers: { [q.question]: free[q.question] } })}>שלח תשובה</button>
            </div>
          </div>
        ))}
        {err && <div className="error">{err}</div>}
      </div>
    );
  }
  return (
    <div>
      <div className="row actions">
        <button className="btn primary" disabled={busy} onClick={() => send({ decision: 'allow' })}>אשר</button>
        <button className="btn danger" disabled={busy} onClick={() => send({ decision: 'deny', explanation: why })}>דחה</button>
        <input className="grow" placeholder="הסבר ל-Claude (רשות, נשלח עם הדחייה)" value={why} onChange={e => setWhy(e.target.value)} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="hint">אפשר לענות גם בטלפון (מקש 6). מה שנענה קודם קובע.</div>
    </div>
  );
}

function PermDecision({ p }: { p: PermissionRequest }) {
  const tone = p.decision === 'allow' || p.decision === 'answer' ? 'ok' : p.decision === 'deny' ? 'bad' : 'muted';
  let extra = '';
  if (p.decision === 'answer' && p.explanation) { try { extra = Object.values(JSON.parse(p.explanation)).join(', '); } catch { /* */ } }
  else if (p.explanation && p.decidedVia !== 'policy') extra = p.explanation;
  return <span><span className={`pill ${tone}`}>{DECISION_LABEL[p.decision ?? ''] ?? 'ממתין'}</span> <span className="muted">{VIA_LABEL[p.decidedVia ?? ''] ?? ''}{extra ? ` · ${extra}` : ''}</span></span>;
}
function PermLine({ p }: { p: PermissionRequest }) { return <><span className="clip-inline">{p.summary}</span> <PermDecision p={p} /></>; }

// ---------- פרויקטים ----------
function Projects() {
  const s = useApi<Project[]>('/projects');
  return (
    <section>
      <div className="head"><h1>פרויקטים</h1></div>
      <LocationCard />
      <NewProject />
      <Loading s={s} />
      {s.data?.length === 0 && <Empty>אין פרויקטים. פרויקט חדש נפתח מהטלפון (מקש 3, האפשרות האחרונה), או בתיקייה ClaudeProjects בשולחן העבודה.</Empty>}
      <ul className="cards grid">
        {s.data?.map(p => (
          <ProjectCard key={p.id} p={p} />
        ))}
      </ul>
    </section>
  );
}

function NewProject() {
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true); setMsg(null);
    try { const p = await act<Project>('/projects/new', { name }); setName(''); setMsg({ ok: true, text: `נוצר פרויקט ${p.spokenName} בתיקייה ${p.path}` }); }
    catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };
  return (
    <div className="card newproj">
      <div className="row">
        <b>פרויקט חדש</b>
        <input className="grow" placeholder="שם הפרויקט (כך הוא יוקרא בטלפון)" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && create()} />
        <button className="btn primary" onClick={create} disabled={busy || !name.trim()}>צור</button>
      </div>
      <div className="hint">נוצרת תיקייה חדשה בתיקיית הפרויקטים. תיקייה קיימת במקום אחר מוסיפים באשף ההגדרה, במסך הפרויקטים.</div>
      {msg && <div className={msg.ok ? 'okbox' : 'error'}>{msg.text}</div>}
    </div>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const [name, setName] = useState(p.spokenName);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setName(p.spokenName), [p.spokenName]);
  const save = async (patch: Record<string, unknown>) => { setErr(null); try { await act(`/projects/${p.id}`, patch); } catch (e: any) { setErr(e.message); } };
  return (
    <li className={`card ${p.phoneEnabled ? '' : 'off'}`}>
      <div className="row">
        <input className="f-name grow" value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== p.spokenName && save({ spokenName: name })} aria-label="השם שמוקרא בטלפון" />
      </div>
      <div className="muted path" dir="ltr">{p.path}</div>
      <div className="row meta">
        <a href={`#/conversations`} onClick={() => sessionStorage.setItem('cp-proj', p.id)}>{p.conversations} שיחות</a>
        {p.lastActiveAt && <span className="muted">{when(p.lastActiveAt)}</span>}
      </div>
      <label className="check"><input type="checkbox" checked={p.phoneEnabled} onChange={e => save({ phoneEnabled: e.target.checked })} /> זמין בטלפון ובלוח</label>
      <label className="check"><input type="checkbox" checked={p.permissions.editInsideProject} onChange={e => save({ editInsideProject: e.target.checked })} /> Claude עורך קבצים בפרויקט בלי לשאול</label>
      {err && <div className="error">{err}</div>}
    </li>
  );
}

// ---------- שיחה פתוחה במחשב (סשן חי, שלב 5) ----------
interface LiveSession { id: string; cwd: string; name: string; since: string; busy: boolean }
function Live() {
  const sessions = useApi<LiveSession[]>('/live');
  const projects = useApi<Project[]>('/projects');
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => { setTick(x => x + 1); sessions.reload(); }, 5000); return () => clearInterval(t); }, []);
  const [pid, setPid] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const open = async () => {
    setMsg(null);
    try { const r = await act<{ opened: string }>('/live/open', { projectId: pid }); setMsg({ ok: true, text: `נפתח חלון Claude בתיקייה ${r.opened}. אחרי שהוא עולה, הוא יופיע כאן ובמקש 1 בטלפון.` }); }
    catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };
  return (
    <section>
      <div className="head"><h1>שיחה פתוחה במחשב</h1></div>
      <p>שיחת Claude Code שנפתחת מכאן מחוברת לטלפון: במקש 1 שולחים אליה הודעה, והיא נכנסת ישר לשיחה שעל המסך. התשובה מוקראת בטלפון, ובקשות אישור מגיעות לטלפון כל עוד הודעה מהטלפון בטיפול.</p>
      <div className="card newproj">
        <div className="row">
          <b>פתיחת שיחה</b>
          <select value={pid} onChange={e => setPid(e.target.value)}>
            <option value="">בחר פרויקט</option>
            {(projects.data ?? []).map(p => <option key={p.id} value={p.id}>{p.spokenName}</option>)}
          </select>
          <button className="btn primary" disabled={!pid} onClick={open}>פתח חלון Claude</button>
        </div>
        {msg && <div className={msg.ok ? 'okbox' : 'error'}>{msg.text}</div>}
      </div>
      <h2>שיחות פתוחות עכשיו</h2>
      {sessions.data?.length === 0 && <Empty>אין שיחה פתוחה עם חיבור לטלפון.</Empty>}
      <ul className="cards">
        {sessions.data?.map(s => (
          <li key={s.id + tick} className="card">
            <div className="row"><b className="title">{s.name}</b>{s.busy && <span className="pill busy">מטפלת בהודעה מהטלפון</span>}<span className="muted">מ-{when(s.since)}</span></div>
            <div className="muted path" dir="ltr">{s.cwd}</div>
          </li>
        ))}
      </ul>
      <p className="hint">יכולת ניסיונית של Claude Code (Channels): עובדת בחלון טרמינל ולא בלשונית Code של Desktop. החלון נפתח עם דגל ערוצי פיתוח, שמאפשר רק לערוץ הטלפון המקומי להיכנס לשיחה הזו. בשיחה חלות ההרשאות של Claude Code עצמו, לא מצב העבודה של המערכת.</p>
    </section>
  );
}

// ---------- יומן טלפון ----------
function PhoneLog() {
  const s = useApi<PhoneLogEntry[]>('/phonelog');
  const calls = useMemo(() => {
    const m = new Map<string, PhoneLogEntry[]>();
    for (const e of s.data ?? []) { const a = m.get(e.callId) ?? []; a.push(e); m.set(e.callId, a); }
    return [...m.entries()].map(([id, evs]) => ({ id, evs: evs.slice().reverse() }));
  }, [s.data]);
  return (
    <section>
      <div className="head"><h1>יומן טלפון</h1></div>
      <Loading s={s} />
      {calls.length === 0 && s.data && <Empty>עוד לא היו שיחות.</Empty>}
      <div className="stack">
        {calls.map(c => (
          <div key={c.id} className="card">
            <div className="row"><b>שיחה {when(c.evs[0]?.at)}</b><span className="muted">{c.evs[0]?.phone}</span></div>
            <ol className="events compact">
              {c.evs.map((e, i) => <li key={i}><span className="muted nowrap">{full(e.at).split(' ').pop()}</span> {PHONE_KIND[e.kind] ?? e.kind}{e.detail && !/^v\d+$/.test(e.detail) ? ` · ${e.detail}` : ''}</li>)}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- הגדרות ותקינות ----------
function Health({ ov, reload }: { ov: Overview | null; reload: () => void }) {
  if (!ov) return <section><Loading s={{ loading: true, error: null }} /></section>;
  const h = ov.health;
  const rows: [string, boolean | null, string][] = [
    ['הסוכן', true, `${h.agent?.version ? 'גרסה ' + h.agent.version + ' · ' : ''}פועל מ-${full(h.agent?.startedAt)} · Node ${h.agent?.node ?? ''} · Agent SDK ${h.agent?.sdk ?? '?'}`],
    ['מנהרת Cloudflare', h.tunnel?.ok, h.tunnel?.ok ? `${h.tunnel.url}` : h.tunnel?.error ?? 'לא מחוברת'],
    ['ימות המשיח', h.yemot?.ok, h.yemot?.ok ? `שלוחה ${h.yemot.extension} עודכנה ${when(h.yemot.updatedAt)}` : 'השלוחה לא עודכנה'],
    ['תמלול (ivrit-ai)', h.stt?.ok, h.stt?.ok ? 'המודל טעון' : 'המודל נטען'],
    ['Claude Code', true, `${h.claude?.claudeCodeVersion ? 'גרסה ' + h.claude.claudeCodeVersion : ''}${h.claude?.busyWith ? ' · עובד על משימה' : ' · פנוי'}`],
  ];
  return (
    <section>
      <div className="head"><h1>הגדרות ותקינות</h1></div>
      <h2>רכיבים</h2>
      <ul className="health">{rows.map(([n, ok, d]) => <li key={n}><i className={ok === null || ok === undefined ? 'dot gray' : ok ? 'dot green' : 'dot red'} /><b>{n}</b><span className="muted" dir="auto">{d}</span></li>)}</ul>
      <h2>הגדרות</h2>
      <SettingsForm s={ov.settings} />
      <h2>זמני שקט ושמירת הקלטות</h2>
      {h.quiet?.quiet && <p className="hint">עכשיו זמן שקט ({({ night: 'לילה', shabbat: 'שבת', chag: 'חג', cholhamoed: 'חול המועד' } as any)[h.quiet.reason] ?? ''}): צינתוקים נדחים לסופו.</p>}
      <QuietForm />
      <h2>עדכונים</h2>
      <UpdateBox u={ov.update} reload={reload} />
      <h2>גיבוי והעברה למחשב אחר</h2>
      <BackupBox />
      <p className="hint">אותן הגדרות כמו במקש 7 בטלפון. כל שינוי חל מיד, גם על משימה שכבר רצה (בשאלה הבאה).</p>
    </section>
  );
}

function SettingsForm({ s }: { s: Overview['settings'] }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (patch: Record<string, unknown>) => {
    setMsg(null);
    try { const r = await act<{ warning: string | null }>('/settings', patch); setMsg(r.warning ? { ok: false, text: r.warning } : { ok: true, text: 'נשמר' }); }
    catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };
  return (
    <div className="settings-form card">
      <div className="radios">
        {(['readonly', 'edit', 'auto'] as const).map(m => (
          <label key={m} className={`radio ${s.editMode === m ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={s.editMode === m} onChange={() => save({ editMode: m })} />
            <b>{MODE_LABEL[m]}</b>
          </label>
        ))}
      </div>
      <div className="row">
        <label className="field short"><span>קול ההקראה</span>
          <select value={s.voice} onChange={e => save({ voice: e.target.value })}>{Object.entries(VOICE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field short"><span>מהירות</span>
          <select value={s.rate} onChange={e => save({ rate: Number(e.target.value) })}>
            {[[-4, 'איטי'], [0, 'רגיל'], [4, 'מהיר'], [8, 'מהיר מאוד']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {![-4, 0, 4, 8].includes(s.rate) && <option value={s.rate}>{s.rate}</option>}
          </select></label>
      </div>
      <div className="row">
        <label className="field short"><span>מודל (אפשר לבחור אחר לכל בקשה)</span>
          <select value={s.model ?? 'default'} onChange={e => save({ model: e.target.value })}>{Object.entries(MODEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field short"><span>רמת חשיבה</span>
          <select value={s.effort ?? 'default'} onChange={e => save({ effort: e.target.value })}>{Object.entries(EFFORT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label className="check"><input type="checkbox" checked={s.notify === 'on'} onChange={e => save({ notify: e.target.checked ? 'on' : 'off' })} /> צינתוק לטלפון כשמשימה מהטלפון מסתיימת או מחכה לאישור</label>
      {msg && <div className={msg.ok ? 'hint' : 'error'}>{msg.text}</div>}
    </div>
  );
}

function QuietForm() {
  const q = useApi<{ start: string; end: string; shabbatAndChag: boolean; includeCholHamoed: boolean; retentionDays: number }>('/quiet-config');
  const [f, setF] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data]);
  if (!f) return <Loading s={q} />;
  const save = async () => {
    setMsg(null);
    try { await act('/quiet', f); setMsg({ ok: true, text: 'נשמר' }); } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };
  return (
    <div className="card settings-form">
      <div className="row">
        <label className="field short"><span>שקט בלילה מ-</span><input type="time" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></label>
        <label className="field short"><span>עד</span><input type="time" value={f.end} onChange={e => setF({ ...f, end: e.target.value })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={f.shabbatAndChag} onChange={e => setF({ ...f, shabbatAndChag: e.target.checked })} /> שבת ויום טוב (מהדלקת נרות עד צאת הכוכבים, זמני ירושלים)</label>
      <label className="check"><input type="checkbox" checked={f.includeCholHamoed} onChange={e => setF({ ...f, includeCholHamoed: e.target.checked })} /> גם חול המועד</label>
      <label className="field short"><span>שמירת הקלטות (ימים, 0 = לא למחוק)</span><input type="number" min={0} max={365} value={f.retentionDays} onChange={e => setF({ ...f, retentionDays: Number(e.target.value) })} /></label>
      <div className="row"><button className="btn primary" onClick={save}>שמור</button>{msg && <span className={msg.ok ? 'muted' : 'error'}>{msg.text}</span>}</div>
    </div>
  );
}

function BackupBox() {
  const [report, setReport] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const onFile = async (file: File | undefined) => {
    setErr(null); setReport(null);
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await act<{ report: string[] }>('/import', { data });
      setReport(r.report);
    } catch (e: any) { setErr(e instanceof SyntaxError ? 'הקובץ אינו קובץ הגדרות תקין' : e.message); }
  };
  return (
    <div className="card settings-form">
      <p>הקובץ כולל: הגדרות העבודה והקול, זמני שקט, מספרי הטלפון המורשים והפרויקטים. <b>לא</b> כולל את טוקן ימות ואת קוד הכניסה: אותם מזינים באשף ההגדרה במחשב החדש.</p>
      <div className="row">
        <a className="btn primary" href="/api/export" download>ייצוא הגדרות לקובץ</a>
        <label className="btn">ייבוא מקובץ…<input type="file" accept=".json,application/json" hidden onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>
      {err && <div className="error">{err}</div>}
      {report && <ul className="wiz-list">{report.map(r => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

// ---------- עזרים ----------
function Loading({ s }: { s: { loading: boolean; error: string | null } }) {
  if (s.error) return <div className="error">{s.error}</div>;
  if (s.loading) return <div className="muted pad">טוען…</div>;
  return null;
}
function Empty({ children }: { children: React.ReactNode }) { return <div className="empty">{children}</div>; }
