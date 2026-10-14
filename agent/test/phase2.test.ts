import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { PermissionBroker } from '../src/claude/broker.ts';
import { Worker } from '../src/claude/worker.ts';
import { Notifier } from '../src/notify/notifier.ts';
import { quietState, DEFAULT_QUIET } from '../src/notify/quiet.ts';
import { decide } from '../src/claude/policy.ts';

const at = (iso: string) => new Date(iso);   // זמנים ב-UTC; ירושלים = UTC+3 באוקטובר 2026 עד 25.10

test('זמני שקט: לילה, שבת, ערב שבת אחרי הדלקת נרות, יום טוב', () => {
  assert.equal(quietState(at('2026-10-14T21:30:00Z')).reason, 'night');          // רביעי 00:30
  assert.equal(quietState(at('2026-10-14T09:00:00Z')).quiet, false);             // רביעי 12:00
  assert.equal(quietState(at('2026-10-16T12:00:00Z')).quiet, false);             // שישי 15:00
  assert.equal(quietState(at('2026-10-16T14:50:00Z')).reason, 'shabbat');        // שישי 17:50, אחרי הדלקת נרות
  assert.equal(quietState(at('2026-10-17T10:00:00Z')).reason, 'shabbat');        // שבת 13:00
  assert.equal(quietState(at('2026-10-17T17:00:00Z')).quiet, false);             // מוצאי שבת 20:00
  assert.equal(quietState(at('2026-10-03T09:00:00Z')).quiet, true);             // שמיני עצרת (שחל בשבת)
  assert.equal(quietState(at('2026-04-02T09:00:00Z')).reason, 'chag');           // פסח, יום חמישי
  assert.equal(quietState(at('2026-10-02T09:00:00Z')).quiet, false);             // הושענא רבה (חול המועד) בצהריים
  assert.equal(quietState(at('2026-10-02T09:00:00Z'), { ...DEFAULT_QUIET, includeCholHamoed: true }).reason, 'cholhamoed');
  assert.equal(quietState(at('2026-09-21T10:00:00Z')).reason, 'chag');           // יום כיפור
});

test('מדיניות שלב 2: פקודות נשאלות, שאלות תמיד נשאלות, במצב קריאה בלבד פקודות נחסמות', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-'));
  const perms = { editInsideProject: true, runCommands: false };
  assert.equal(decide('Bash', { command: 'npm i', description: 'התקנה' }, root, perms).action, 'ask');
  assert.match(decide('Bash', { command: 'npm i', description: 'התקנה' }, root, perms).summary, /התקנה\. הפקודה: npm i/);
  assert.equal(decide('PowerShell', { command: 'dir' }, root, perms, 'readonly').action, 'deny');
  assert.equal(decide('AskUserQuestion', { questions: [] }, root, perms, 'readonly').action, 'ask');
  assert.equal(decide('Write', { file_path: join(root, 'a') }, root, perms).action, 'allow');
  // אישור אוטומטי: פקודות מאושרות, שאלות עדיין נשאלות
  assert.equal(decide('Bash', { command: 'npm i' }, root, perms, 'auto').action, 'allow');
  assert.equal(decide('AskUserQuestion', { questions: [] }, root, perms, 'auto').action, 'ask');
});

function setup(minutes = 10) {
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const p = store.addProject({ name: 'p', path: mkdtempSync(join(tmpdir(), 'cpb-')) });
  const events: [string, string][] = [];
  const broker = new PermissionBroker({ store, tasks, minutes, onEvent: (k, id) => events.push([k, id]) });
  const t = tasks.create({ projectId: p.id, source: 'phone', prompt: 'x', phone: '050' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); tasks.transition(t.id, 'running', 'x');
  return { store, tasks, broker, p, t: tasks.get(t.id)!, events };
}

test('מתווך: הבקשה ממתינה, המשימה במצב "ממתינה לאישור", אישור משחרר וחוזרת לריצה', async () => {
  const { store, tasks, broker, p, t, events } = setup();
  const pr = broker.request(t, p, 'Bash', { command: 'ls' }, 'ls', new AbortController().signal);
  assert.equal(tasks.get(t.id)!.state, 'awaiting_permission');
  assert.equal(events[0][0], 'permission');
  const id = store.pendingPermissionRequests()[0].id;
  assert.equal(broker.decide(id, { decision: 'allow' }, 'phone'), 'ok');
  assert.deepEqual(await pr, { kind: 'allow' });
  assert.equal(tasks.get(t.id)!.state, 'running');
});

test('מתווך: שני ערוצים מחליטים בו-זמנית, רק ההחלטה הראשונה נקלטת', async () => {
  const { store, broker, p, t } = setup();
  const pr = broker.request(t, p, 'Bash', { command: 'ls' }, 'ls', new AbortController().signal);
  const id = store.pendingPermissionRequests()[0].id;
  const a = broker.decide(id, { decision: 'deny' }, 'dashboard');
  const b = broker.decide(id, { decision: 'allow' }, 'phone');
  assert.deepEqual([a, b], ['ok', 'already']);
  assert.equal((await pr).kind, 'deny');
  assert.equal(store.getPermissionRequest(id)!.decision, 'deny');
});

test('מתווך: בקשה שפג תוקפה נדחית ואי אפשר לאשר אותה אחר כך', async () => {
  const { store, broker, p, t } = setup(0.001);   // כ-60 מילישניות
  const res = await broker.request(t, p, 'Bash', { command: 'ls' }, 'ls', new AbortController().signal);
  assert.equal(res.kind, 'deny');
  const id = store.listPermissionRequests(t.id)[0].id;
  assert.equal(store.getPermissionRequest(id)!.decision, 'expired');
  assert.equal(broker.decide(id, { decision: 'allow' }, 'phone'), 'already');
});

test('מתווך: עצירת המשימה סוגרת את הבקשה', async () => {
  const { store, broker, p, t } = setup();
  const ac = new AbortController();
  const pr = broker.request(t, p, 'Bash', { command: 'ls' }, 'ls', ac.signal);
  ac.abort();
  assert.equal((await pr).kind, 'deny');
  assert.equal(store.listPermissionRequests(t.id)[0].decision, 'cancelled');
});

test('אתחול: בקשות פתוחות נסגרות', () => {
  const { store, broker, p, t } = setup();
  const ac = new AbortController();
  void broker.request(t, p, 'Bash', { command: 'ls' }, 'ls', ac.signal);
  assert.equal(store.closeAllPending(), 1);
  assert.equal(store.pendingPermissionRequests().length, 0);
  ac.abort();   // משחרר את הממתין (בפועל התהליך כולו התאתחל)
});

test('worker + מתווך: שאלה של Claude נענית מהטלפון והתשובה מגיעה ל-Claude', async () => {
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const p = store.addProject({ name: 'p', path: mkdtempSync(join(tmpdir(), 'cpw-')) });
  const broker = new PermissionBroker({ store, tasks, minutes: 10, onEvent: (_k, id) => {
    setTimeout(() => broker.decide(id, { decision: 'answer', answers: { 'איזה צבע?': 'כחול' } }, 'phone'), 20);
  } });
  let got: any = null;
  const query = ({ options }: any) => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'S' };
    got = await options.canUseTool('AskUserQuestion', { questions: [{ question: 'איזה צבע?', options: [] }] }, { signal: new AbortController().signal });
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'בחרת כחול' };
  })();
  const worker = new Worker({ store, tasks, query, maxTurns: 5, permissionMinutes: 10, broker });
  const t = tasks.create({ projectId: p.id, source: 'phone', prompt: 'x' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x');
  worker.kick();
  for (let i = 0; i < 100 && tasks.get(t.id)!.state !== 'done'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(tasks.get(t.id)!.state, 'done');
  assert.equal(got.behavior, 'allow');
  assert.deepEqual(got.updatedInput.answers, { 'איזה צבע?': 'כחול' });
  assert.ok(tasks.events(t.id).some((e: any) => e.to_state === 'awaiting_answer'));
});

function notifierSetup(nowIso: string, opts: { inCall?: boolean; fail?: number } = {}) {
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const p = store.addProject({ name: 'p', path: '/tmp/x' });
  const sent: string[][] = [];
  let fails = opts.fail ?? 0;
  let now = at(nowIso);
  const n = new Notifier({
    store, tasks, quiet: DEFAULT_QUIET, phones: () => ['050'], maxAttempts: 3,
    tzintuk: async (ph) => { if (fails-- > 0) throw new Error('x'); sent.push(ph); },
    inCall: () => !!opts.inCall, now: () => now,
  });
  const t = tasks.create({ projectId: p.id, source: 'phone', prompt: 'x', phone: '050' });
  return { store, tasks, n, sent, t, setNow: (iso: string) => { now = at(iso); } };
}

test('התראות: צינתוק אחד לכל אירוע', async () => {
  const { n, sent, t } = notifierSetup('2026-10-14T09:00:00Z');
  assert.equal(await n.event('done', t.id, '050'), 'sent');
  assert.equal(await n.event('done', t.id, '050'), 'duplicate');
  assert.equal(sent.length, 1);
});

test('התראות: בשעות שקט נדחות, ונשלח צינתוק מרוכז אחד בסיום, רק לאירועים שלא טופלו', async () => {
  const { n, sent, tasks, store, t, setNow } = notifierSetup('2026-10-14T21:30:00Z');   // 00:30 בלילה
  const p2 = store.listProjects()[0];
  const t2 = tasks.create({ projectId: p2.id, source: 'phone', prompt: 'y' });
  assert.equal(await n.event('done', t.id, '050'), 'deferred');
  assert.equal(await n.event('done', t2.id, '050'), 'deferred');
  tasks.markHeard(t2.id);                       // נשמעה בינתיים
  await n.tick();
  assert.equal(sent.length, 0);                 // עדיין לילה
  setNow('2026-10-15T05:00:00Z');               // 08:00
  await n.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(store.notificationsInState('dropped').map(x => x.refId), [t2.id]);
});

test('התראות: לא מצנתקים מי שכבר בשיחה; צינתוק שנכשל מנוסה שוב עד 3 פעמים', async () => {
  const a = notifierSetup('2026-10-14T09:00:00Z', { inCall: true });
  assert.equal(await a.n.event('done', a.t.id, '050'), 'in_call');
  assert.equal(a.sent.length, 0);
  const b = notifierSetup('2026-10-14T09:00:00Z', { fail: 1 });
  await b.n.event('done', b.t.id, '050');
  assert.equal(b.sent.length, 0);
  await b.n.tick();
  assert.equal(b.sent.length, 1);
});

test('התראות: כבויות בהגדרות', async () => {
  const { n, sent, t, store } = notifierSetup('2026-10-14T09:00:00Z');
  store.setSetting('notify', 'off');
  assert.equal(await n.event('done', t.id, '050'), 'disabled');
  assert.equal(sent.length, 0);
});
