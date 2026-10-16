// מסך שיחה כמו צ'אט (לבקשת המשתמש, 16.10): ההודעות שלך בבועה, התשובות של Claude מעוצבות (Markdown),
// פעולות Claude מקופלות בשורה קטנה בין ההודעות, תיבת הכתיבה למטה, וגלילה אוטומטית לסוף.
// משימות מהטלפון ומהלוח משולבות בתוך רצף ההודעות (הקלטה ליד ההודעה, "הוקרא בטלפון" ליד התשובה).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { act, useApi, type Conversation, type Task, type HistoryMessage } from './api';
import Markdown from './Markdown';
import { MODEL_LABEL, STATE_LABEL, stateTone, SOURCE_LABEL, when, full } from './format';

const ACTIVE = new Set(['queued', 'running', 'awaiting_permission', 'awaiting_answer', 'stop_requested']);
const READONLY_PREFIX = /^\[מצב קריאה בלבד: אל תשנה קבצים\]\s*/;

type Item =
  | { kind: 'user'; at: string | null; text: string; task?: Task }
  | { kind: 'assistant'; at: string | null; text: string; task?: Task }
  | { kind: 'steps'; at: string | null; tools: { name: string; input: string }[] }
  | { kind: 'note'; at: string | null; text: string }
  | { kind: 'pending'; task: Task };

function toolLabel(name: string): string {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'עריכת קובץ';
  if (name === 'Bash') return 'פקודה';
  if (name === 'Read') return 'קריאת קובץ';
  if (/^(Grep|Glob)$/.test(name)) return 'חיפוש';
  if (/^(WebFetch|WebSearch)$/.test(name)) return 'רשת';
  if (name === 'AskUserQuestion') return 'שאלה';
  if (/^(Task|Agent)$/.test(name)) return 'סוכן משנה';
  if (/^(TodoWrite|TaskCreate|TaskUpdate)$/.test(name)) return 'רשימת משימות';
  return name;
}

/** "ערך 3 קבצים · הריץ 2 פקודות · קרא 5 קבצים" */
function stepsSummary(tools: { name: string }[]): string {
  const c = { edit: 0, cmd: 0, read: 0, search: 0, web: 0, other: 0 };
  for (const t of tools) {
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name)) c.edit++;
    else if (t.name === 'Bash') c.cmd++;
    else if (t.name === 'Read') c.read++;
    else if (/^(Grep|Glob)$/.test(t.name)) c.search++;
    else if (/^(WebFetch|WebSearch)$/.test(t.name)) c.web++;
    else c.other++;
  }
  const parts: string[] = [];
  if (c.edit) parts.push(c.edit === 1 ? 'ערך קובץ' : `ערך ${c.edit} קבצים`);
  if (c.cmd) parts.push(c.cmd === 1 ? 'הריץ פקודה' : `הריץ ${c.cmd} פקודות`);
  if (c.read) parts.push(c.read === 1 ? 'קרא קובץ' : `קרא ${c.read} קבצים`);
  if (c.search) parts.push(c.search === 1 ? 'חיפוש' : `${c.search} חיפושים`);
  if (c.web) parts.push(c.web === 1 ? 'גלישה' : `${c.web} פניות לרשת`);
  if (c.other) parts.push(c.other === 1 ? 'פעולה נוספת' : `${c.other} פעולות נוספות`);
  return parts.join(' · ');
}

/** הודעות שה-API מזריק לתמליל בתפקיד "משתמש" (לא המשתמש כתב אותן): מוצגות כהערת מערכת, לא כבועה שלך. */
const SYSTEM_INJECTED = /^(Your response above was stopped by a safety classifier|\[Request interrupted by user|<system-reminder>)/i;

/** משלב את המשימות (מהטלפון ומהלוח) בתוך רצף ההודעות מההיסטוריה של Claude. */
export function buildTimeline(messages: HistoryMessage[], tasks: Task[]): Item[] {
  const byPrompt = new Map<string, Task[]>();
  const byResult = new Map<string, Task[]>();
  const push = (m: Map<string, Task[]>, k: string, t: Task) => { const a = m.get(k) ?? []; a.push(t); m.set(k, a); };
  for (const t of tasks) { if (t.prompt) push(byPrompt, t.prompt.trim(), t); if (t.resultText) push(byResult, t.resultText.trim(), t); }
  const matched = new Set<string>();
  const take = (m: Map<string, Task[]>, k: string) => { const a = m.get(k); const t = a?.find(x => !matched.has(x.id + ':' + (m === byPrompt ? 'p' : 'r'))); if (t) matched.add(t.id + ':' + (m === byPrompt ? 'p' : 'r')); return t; };
  const items: Item[] = [];
  let steps: { name: string; input: string }[] = [];
  let stepsAt: string | null = null;
  const flushSteps = () => { if (steps.length) { items.push({ kind: 'steps', at: stepsAt, tools: steps }); steps = []; stepsAt = null; } };
  for (const m of messages) {
    if (m.role === 'tool') { if (!steps.length) stepsAt = m.at; steps.push({ name: m.tool?.name ?? '', input: m.tool?.input ?? '' }); continue; }
    flushSteps();
    if (m.role === 'user') {
      if (SYSTEM_INJECTED.test(m.text.trim())) { items.push({ kind: 'note', at: m.at, text: m.text }); continue; }
      const text = m.text.replace(READONLY_PREFIX, '');
      items.push({ kind: 'user', at: m.at, text, task: take(byPrompt, text.trim()) ?? take(byPrompt, m.text.trim()) });
    } else items.push({ kind: 'assistant', at: m.at, text: m.text, task: take(byResult, m.text.trim()) });
  }
  flushSteps();
  // משימות שעדיין לא מופיעות בהיסטוריה (בתור, רצות, נכשלו, או שהתמליל טרם התעדכן): בסוף, לפי זמן יצירה
  const rest = tasks.filter(t => !matched.has(t.id + ':p')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const t of rest) items.push({ kind: 'pending', task: t });
  return items;
}

export default function ConversationView({ id }: { id: string }) {
  const s = useApi<{ entry: Conversation; messages: HistoryMessage[]; tasks: Task[] }>(`/conversations/${id}`);
  const [showSteps, setShowSteps] = useState(true);
  const [openMsg, setOpenMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const firstLoad = useRef(true);
  const items = useMemo(() => s.data ? buildTimeline(s.data.messages, s.data.tasks) : [], [s.data]);

  // גלילה לסוף: בטעינה הראשונה, ואחר כך רק אם המשתמש כבר היה בסוף (לא מפריעים לקריאה למעלה)
  useEffect(() => {
    const onScroll = () => { nearBottom.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120; };
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!s.data) return;
    if (firstLoad.current || nearBottom.current) {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior: firstLoad.current ? 'auto' : 'smooth' });
      firstLoad.current = false;
    }
  }, [items]);

  if (!s.data) return <section><a className="back" href="#/conversations">→ כל השיחות</a>{s.error ? <div className="error">{s.error}</div> : <div className="muted pad">טוען…</div>}</section>;
  const { entry, tasks } = s.data;
  const active = tasks.filter(t => ACTIVE.has(t.state));
  const canOpenTerminal = !!entry.folder && entry.source !== 'cowork' && entry.inHistory;
  const open = async (what: 'open-terminal' | 'open-folder') => {
    setOpenMsg(null);
    try { await act(`/conversations/${entry.id}/${what}`); setOpenMsg({ ok: true, text: what === 'open-terminal' ? 'נפתח חלון Claude Code שממשיך את השיחה הזו' : 'התיקייה נפתחה בסייר הקבצים' }); }
    catch (e: any) { setOpenMsg({ ok: false, text: e.message }); }
  };
  const hasSteps = items.some(i => i.kind === 'steps');

  return (
    <section className="chat-page">
      <header className="chat-head">
        <a className="back" href="#/conversations">→ כל השיחות</a>
        <div className="chat-title-row">
          <h1 className="chat-title">{entry.title}</h1>
          <div className="row chat-actions">
            {canOpenTerminal && <button className="btn" onClick={() => open('open-terminal')} title="חלון Claude Code שממשיך את השיחה הזו (claude --resume)">פתח בטרמינל</button>}
            {entry.folder && <button className="btn" onClick={() => open('open-folder')} title={entry.folder}>פתח תיקייה</button>}
          </div>
        </div>
        <div className="row meta chat-meta">
          <span>{entry.projectName ?? 'בלי פרויקט'}</span>
          <span className={`pill src-${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
          {entry.coworkProject && <span className="pill">פרויקט Cowork: {entry.coworkProject}</span>}
          {entry.active && <span className="pill busy">פעילה כרגע</span>}
          <span className="muted">עודכנה {full(entry.lastActiveAt)}</span>
          {entry.folder && <span className="muted path chat-folder" dir="ltr" title={entry.folder}>{entry.folder}</span>}
          {hasSteps && <label className="toggle grow"><input type="checkbox" checked={showSteps} onChange={e => setShowSteps(e.target.checked)} /> פעולות של Claude</label>}
        </div>
        {openMsg && <div className={openMsg.ok ? 'okbox' : 'error'}>{openMsg.text}</div>}
        {entry.source === 'cowork' && <div className="hint">שיחת Cowork: הטקסט כאן מתוך Claude Desktop. ב-Desktop רואים אותה עם כל העיצוב, וגם המשך מהטלפון מופיע שם.</div>}
      </header>

      <div className="chat">
        {!entry.inHistory && items.length === 0 && <div className="empty">היסטוריית Claude של השיחה הזו לא נמצאה במחשב.</div>}
        {items.map((it, i) => {
          if (it.kind === 'steps') return showSteps ? <Steps key={i} tools={it.tools} at={it.at} /> : null;
          if (it.kind === 'pending') return <PendingTask key={it.task.id} t={it.task} />;
          if (it.kind === 'note') return <details key={i} className="steps note"><summary>הודעת מערכת של Claude (לא נכתבה על ידך)<span className="muted">{when(it.at)}</span></summary><div className="note-text" dir="auto">{it.text}</div></details>;
          if (it.kind === 'user') return <UserBubble key={i} text={it.text} at={it.at} task={it.task} />;
          return <AssistantMessage key={i} text={it.text} at={it.at} task={it.task} />;
        })}
        {active.length > 0 && items[items.length - 1]?.kind !== 'pending' && <Working t={active[active.length - 1]} />}
        <div ref={bottomRef} />
      </div>

      <div className="chat-composer">
        {(entry.canContinue || entry.source === 'phone') && entry.projectId
          ? <Composer conversationId={entry.id} placeholder={active.length ? 'ההודעה הבאה תמתין בתור עד שהמשימה הנוכחית תסתיים' : 'המשך השיחה: מה לעשות עכשיו?'} />
          : <p className="hint">{entry.blockedReason ?? 'אי אפשר להמשיך את השיחה הזו מכאן'}</p>}
      </div>
    </section>
  );
}

function Who({ children, at }: { children: ReactNode; at: string | null }) {
  return <div className="who">{children}<span className="muted" title={full(at)}>{when(at)}</span></div>;
}

function UserBubble({ text, at, task }: { text: string; at: string | null; task?: Task }) {
  return (
    <div className="msg user">
      <Who at={at}>אתה{task && <span className={`pill src-${task.source === 'dashboard' ? 'dashboard' : 'phone'}`}>{task.source === 'dashboard' ? 'מהלוח' : 'מהטלפון'}</span>}{task?.model && <span className="pill">{MODEL_LABEL[task.model] ?? task.model}</span>}</Who>
      <div className="bubble"><Markdown text={text} /></div>
      {task?.hasRecording && <audio controls preload="none" src={`/api/recordings/${task.id}`} />}
    </div>
  );
}

function AssistantMessage({ text, at, task }: { text: string; at: string | null; task?: Task }) {
  const [err, setErr] = useState<string | null>(null);
  const heard = async () => { try { await act(`/tasks/${task!.id}/heard`); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="msg assistant">
      <Who at={at}>Claude{task && task.source !== 'dashboard' && (task.heard
        ? <span className="pill ok">הוקרא בטלפון</span>
        : <span className="pill warn">טרם נשמע בטלפון <button className="linkbtn tiny" onClick={heard}>סמן כנשמע</button></span>)}
      </Who>
      <div className="answer"><Markdown text={text} /></div>
      {task?.error && <div className="error">{task.error}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

function Steps({ tools, at }: { tools: { name: string; input: string }[]; at: string | null }) {
  return (
    <details className="steps">
      <summary><span className="steps-n">{tools.length}</span> {stepsSummary(tools)}<span className="muted">{when(at)}</span></summary>
      <ul>
        {tools.map((t, i) => (
          <li key={i}><span className="step-kind">{toolLabel(t.name)}</span><code dir="ltr" className="step-input" title={t.input}>{t.input || t.name}</code></li>
        ))}
      </ul>
    </details>
  );
}

/** משימה שעוד לא בהיסטוריה (או שלא הסתיימה בתשובה): בועה שלך עם מצב, ואם יש תשובה, גם היא. */
function PendingTask({ t }: { t: Task }) {
  const isActive = ACTIVE.has(t.state);
  return (
    <>
      <div className="msg user">
        <Who at={t.createdAt}>אתה<span className={`pill src-${t.source === 'dashboard' ? 'dashboard' : 'phone'}`}>{t.source === 'dashboard' ? 'מהלוח' : 'מהטלפון'}</span><span className={`pill ${stateTone(t.state)}`}>{STATE_LABEL[t.state]}</span></Who>
        <div className="bubble"><Markdown text={t.prompt || '—'} /></div>
        {t.hasRecording && <audio controls preload="none" src={`/api/recordings/${t.id}`} />}
        {isActive && <StopButton t={t} />}
      </div>
      {t.resultText && <AssistantMessage text={t.resultText} at={t.updatedAt} task={t} />}
      {!t.resultText && t.error && <div className="msg assistant"><Who at={t.updatedAt}>Claude</Who><div className="error">{t.error}</div></div>}
    </>
  );
}

function Working({ t }: { t: Task }) {
  return (
    <div className="msg assistant working">
      <Who at={null}>Claude</Who>
      <div className="answer typing"><span className="dots" aria-hidden="true"><i /><i /><i /></span> {STATE_LABEL[t.state]}{t.state === 'awaiting_permission' || t.state === 'awaiting_answer' ? <> · <a href="#/approvals">לאישורים</a></> : null}<StopButton t={t} inline /></div>
    </div>
  );
}

function StopButton({ t, inline }: { t: Task; inline?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stop = async () => { setBusy(true); setErr(null); try { await act(`/tasks/${t.id}/stop`); } catch (e: any) { setErr(e.message); } setBusy(false); };
  if (!ACTIVE.has(t.state) || t.state === 'stop_requested') return null;
  return <span className={inline ? 'stop-inline' : 'row actions'}><button className="btn danger small" disabled={busy} onClick={stop}>{t.state === 'queued' ? 'בטל' : 'עצור'}</button>{err && <span className="error-inline">{err}</span>}</span>;
}

// ---------- תיבת הכתיבה (שלב 4), אותו API כמו קודם ----------
export function Composer({ conversationId, projectId, placeholder }: { conversationId?: string; projectId?: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [model, setModel] = useState('default');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const t = await act<Task>('/tasks', { conversationId, projectId, prompt: text, model });
      setText(''); setMsg({ ok: true, text: `משימה ${t.num} נכנסה לתור.` });
      setTimeout(() => setMsg(null), 4000);
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };
  return (
    <div className="composer">
      <textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder={placeholder}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
      <div className="row">
        <button className="btn primary" onClick={send} disabled={busy || !text.trim() || (!conversationId && !projectId)}>{busy ? 'שולח…' : 'שלח ל-Claude'}</button>
        <select value={model} onChange={e => setModel(e.target.value)} aria-label="מודל">
          <option value="default">מודל לפי ההגדרות</option>
          {['fable', 'opus', 'sonnet', 'haiku'].map(m => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
        </select>
        <span className="muted composer-hint">Ctrl+Enter לשליחה · ההרשאות לפי מצב העבודה</span>
        {msg && <span className={msg.ok ? 'muted' : 'error-inline'}>{msg.text}</span>}
      </div>
    </div>
  );
}
