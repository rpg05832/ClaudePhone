import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { Worker, liveSummary } from '../src/claude/worker.ts';
import { PermissionBroker } from '../src/claude/broker.ts';
import { LiveHub } from '../src/live/hub.ts';
import { ClaudeHistory } from '../src/history/claude-history.ts';
import { ConversationIndex } from '../src/history/conversations.ts';
import { startDashboard } from '../src/web/server.ts';

const until = async (f: () => boolean, n = 300) => { for (let i = 0; i < n && !f(); i++) await new Promise(r => setTimeout(r, 10)); };

test('סשן חי: הודעה נמסרת בפנייה הארוכה, והתשובה חוזרת', async () => {
  const hub = new LiveHub({ pollMs: 200 });
  const sid = hub.register('C:\\proj\\site', 123);
  assert.equal(hub.list().length, 1);
  const polled = hub.poll(sid);
  const answer = hub.send(sid, 'task-1', 'תוסיף כפתור', async () => 'allow');
  const ev = await polled;
  assert.deepEqual(ev, [{ type: 'message', chat_id: 'task-1', text: 'תוסיף כפתור' }]);
  assert.equal(hub.list()[0].busy, true);
  assert.equal(hub.reply(sid, 'task-1', 'הוספתי.\n---\nפירוט'), true);
  assert.equal(await answer, 'הוספתי.\n---\nפירוט');
  assert.equal(hub.reply(sid, 'task-1', 'עוד'), false);          // אין מי שמחכה
  assert.deepEqual(await hub.poll(sid), []);                      // נגמר הזמן בלי אירועים
  assert.equal(await hub.poll('nope'), null);
});

test('סשן חי: הרשאה מועברת רק כשיש הודעה מהטלפון בטיפול, וההחלטה חוזרת לערוץ', async () => {
  const hub = new LiveHub({ pollMs: 200 });
  const sid = hub.register('/p', null);
  const req = { request_id: 'abcde', tool_name: 'Bash', description: 'הרצת בדיקות', input_preview: '{"command":"npm test"}' };
  assert.equal(hub.permission(sid, req), false);                  // המשתמש ליד המסך: לא מטרידים את הטלפון
  let asked: any = null;
  const pending = hub.send(sid, 't1', 'x', async (r) => { asked = r; return 'deny'; });
  await hub.poll(sid);                                            // ההודעה
  assert.equal(hub.permission(sid, req), true);
  const ev = await hub.poll(sid);
  assert.deepEqual(ev, [{ type: 'permission', request_id: 'abcde', behavior: 'deny' }]);
  assert.equal(asked.tool_name, 'Bash');
  hub.close(sid);
  await assert.rejects(pending, /נסגרה/);
  assert.equal(liveSummary(req), 'הרצת בדיקות. הפקודה: npm test');
});

test('סשן חי: הסשן נחשב סגור אחרי שקט ארוך', async () => {
  const hub = new LiveHub({ staleMs: 30, pollMs: 10 });
  hub.register('/p', null);
  assert.equal(hub.list().length, 1);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(hub.list().length, 0);
});

test('משימה לסשן חי: לא תופסת את המנוע, ההרשאה עוברת דרך המתווך, והתשובה נשמרת', async () => {
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const p = store.addProject({ name: 'p', path: mkdtempSync(join(tmpdir(), 'cplive-')) });
  const hub = new LiveHub({ pollMs: 2000 });
  const sid = hub.register(p.path, null);
  const broker = new PermissionBroker({ store, tasks, minutes: 10, onEvent: (_k, id) => setTimeout(() => broker.decide(id, { decision: 'allow' }, 'phone'), 5) });
  let queried = 0;
  const query = () => (async function* () { queried++; })();
  const finished: string[] = [];
  const worker = new Worker({ store, tasks, query: query as any, maxTurns: 5, permissionMinutes: 10, broker,
    live: { send: (s, c, t, op) => hub.send(s, c, t, op), cancel: (s, c) => hub.cancel(s, c) }, onFinished: (t) => finished.push(t.state) });
  const t = tasks.create({ projectId: p.id, source: 'phone', prompt: 'מה המצב?', conversationId: `live:${sid}` });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x');
  worker.kick();
  const ev = await hub.poll(sid);
  assert.equal((ev as any)[0].chat_id, t.id);
  assert.equal(worker.busyWith, null);                            // המנוע פנוי למשימות אחרות
  assert.equal(hub.permission(sid, { request_id: 'qwert', tool_name: 'Bash', description: 'בנייה', input_preview: '{"command":"npm run build"}' }), true);
  const perm = await hub.poll(sid);
  assert.deepEqual(perm, [{ type: 'permission', request_id: 'qwert', behavior: 'allow' }]);
  assert.equal(store.listPermissionRequests(t.id)[0].summary, 'בנייה. הפקודה: npm run build');
  hub.reply(sid, t.id, 'הכול תקין.\n---\nפרטים');
  await until(() => tasks.get(t.id)!.state === 'done');
  assert.equal(tasks.get(t.id)!.resultSummary, 'הכול תקין.');
  assert.equal(queried, 0);
  assert.deepEqual(finished, ['done']);
});

test('משימה לסשן חי: עצירה מבטלת את ההמתנה', async () => {
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const p = store.addProject({ name: 'p', path: '/x' });
  const hub = new LiveHub();
  const sid = hub.register('/x', null);
  const broker = new PermissionBroker({ store, tasks, minutes: 10, onEvent: () => {} });
  const worker = new Worker({ store, tasks, query: (() => (async function* () {})()) as any, maxTurns: 5, permissionMinutes: 10, broker,
    live: { send: (s, c, t, op) => hub.send(s, c, t, op), cancel: (s, c) => hub.cancel(s, c) } });
  const t = tasks.create({ projectId: p.id, source: 'phone', prompt: 'x', conversationId: `live:${sid}` });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x');
  worker.kick();
  await until(() => tasks.get(t.id)!.state === 'running');
  worker.requestStop(t.id, 'phone');
  await until(() => tasks.get(t.id)!.state === 'cancelled');
  assert.equal(tasks.get(t.id)!.state, 'cancelled');
});

test('ממשק הערוץ: רק עם אסימון הסשן החי, בלי עוגיית הלוח', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cplivesrv-'));
  const web = join(dir, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<html></html>');
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const history = new ClaudeHistory(join(dir, 'none'));
  const hub = new LiveHub({ pollMs: 100 });
  const port = 23000 + Math.floor(Math.random() * 2000);
  const srv = startDashboard({ port, tokenFile: join(dir, 'tok'), staticDir: web, recordingsDir: join(dir, 'rec'), store, tasks, history,
    conversations: new ConversationIndex(store, history, { resumeSources: ['sdk'], activeMinutes: 3 }), health: () => ({}), mode: 'running', live: hub, liveToken: 'L'.repeat(48) });
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    const bad = await fetch(base + '/live/register', { method: 'POST', headers: { 'x-cp-live': 'wrong', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401);
    const h = { 'x-cp-live': 'L'.repeat(48), 'content-type': 'application/json' };
    const reg = await (await fetch(base + '/live/register', { method: 'POST', headers: h, body: JSON.stringify({ cwd: dir, pid: 5 }) })).json();
    assert.ok(reg.session);
    const answer = hub.send(reg.session, 'c1', 'שלום', async () => 'allow');
    const poll = await (await fetch(base + `/live/poll?s=${reg.session}`, { headers: h })).json();
    assert.equal(poll.events[0].text, 'שלום');
    const rep = await (await fetch(base + '/live/reply', { method: 'POST', headers: h, body: JSON.stringify({ s: reg.session, chat_id: 'c1', text: 'היי' }) })).json();
    assert.equal(rep.delivered, true);
    assert.equal(await answer, 'היי');
    assert.equal((await fetch(base + '/live/poll?s=gone', { headers: h })).status, 410);
  } finally { srv.close(); }
});
