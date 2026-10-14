import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { Worker } from '../src/claude/worker.ts';
import { PermissionBroker } from '../src/claude/broker.ts';

function setup(query: any) {
  const store = new Store(':memory:');
  const tasks = new Tasks(store);
  const p = store.addProject({ name: 'p', path: mkdtempSync(join(tmpdir(), 'cpw-')) });
  const broker = new PermissionBroker({ store, tasks, minutes: 10, onEvent: (_k, id) => setTimeout(() => broker.decide(id, { decision: 'deny' }, 'phone'), 5) });
  const worker = new Worker({ store, tasks, query, maxTurns: 5, permissionMinutes: 10, broker });
  const enqueue = (prompt: string, conversationId: string | null = null) => {
    const t = tasks.create({ projectId: p.id, source: 'phone', prompt, conversationId });
    tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x');
    return t;
  };
  return { store, tasks, worker, enqueue, p };
}

const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };

test('משימה רצה, נפתחת שיחה, נשמר סיכום, והנעילה משתחררת', async () => {
  const calls: any[] = [];
  const query = ({ prompt, options }: any) => (async function* () {
    calls.push({ prompt, options });
    yield { type: 'system', subtype: 'init', session_id: 'S1' };
    const d = await options.canUseTool('Bash', { command: 'npm i' });
    assert.equal(d.behavior, 'deny');
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: 'S1', result: 'עשיתי. הכול טוב.\n---\nפירוט' };
  })();
  const { tasks, worker, enqueue, store } = setup(query);
  const t = enqueue('תעשה משהו');
  worker.kick();
  await until(() => tasks.get(t.id)!.state === 'done');
  const done = tasks.get(t.id)!;
  assert.equal(done.resultSummary, 'עשיתי. הכול טוב.');
  assert.equal(done.conversationId, 'S1');
  assert.equal(store.getConversation('S1')?.title, 'תעשה משהו');
  assert.equal(store.conversationLockedBy('S1'), null);
  assert.equal(store.listPermissionRequests(t.id)[0].decision, 'deny');
  assert.equal(calls[0].options.permissionMode, 'default');
  assert.notEqual(calls[0].options.permissionMode, 'bypassPermissions');
});

test('משימה אחת בכל פעם: השנייה מחכה בתור ורצה אחרי הראשונה, עם resume', async () => {
  let running = 0, maxRunning = 0;
  const seen: any[] = [];
  const query = ({ options }: any) => (async function* () {
    running++; maxRunning = Math.max(maxRunning, running); seen.push(options.resume);
    yield { type: 'system', subtype: 'init', session_id: options.resume ?? 'NEW' };
    await new Promise(r => setTimeout(r, 30));
    running--;
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok' };
  })();
  const { tasks, worker, enqueue } = setup(query);
  const a = enqueue('א'); const b = enqueue('ב', 'OLD');
  worker.kick(); worker.kick();
  await until(() => tasks.get(b.id)!.state === 'done');
  assert.equal(maxRunning, 1);
  assert.deepEqual(seen, [undefined, 'OLD']);
  assert.equal(tasks.get(a.id)!.state, 'done');
});

test('עצירה: המשימה מסומנת "בוטלה" רק אחרי שהריצה נעצרה בפועל', async () => {
  const query = ({ options }: any) => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'S2' };
    await new Promise((_, rej) => options.abortController.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  })();
  const { tasks, worker, enqueue } = setup(query);
  const t = enqueue('ארוך');
  worker.kick();
  await until(() => tasks.get(t.id)!.state === 'running');
  worker.requestStop(t.id, 'phone');
  await until(() => tasks.get(t.id)!.state === 'cancelled');
  assert.equal(tasks.get(t.id)!.state, 'cancelled');
  assert.ok(tasks.events(t.id).some((e: any) => e.to_state === 'stop_requested'));
});

test('שגיאת התחברות מוצגת בלי פרטי סוד', async () => {
  const query = () => (async function* () { throw new Error('OAuth token expired 401 sk-xxx'); })();
  const { tasks, worker, enqueue } = setup(query);
  const t = enqueue('x');
  worker.kick();
  await until(() => tasks.get(t.id)!.state === 'failed');
  assert.equal(tasks.get(t.id)!.error, 'החיבור של Claude במחשב פג. יש להתחבר מחדש במחשב');
});
