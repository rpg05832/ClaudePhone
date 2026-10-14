import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { Tasks, InvalidTransition } from '../src/store/tasks.ts';

function setup() {
  const store = new Store(':memory:');
  const tasks = new Tasks(store);
  const p = store.addProject({ name: 'בדיקה', path: '/tmp/proj-a' });
  return { store, tasks, p };
}

test('משימה עוברת את מחזור החיים התקין ונרשמת ביומן', () => {
  const { tasks, p } = setup();
  const t = tasks.create({ projectId: p.id, source: 'phone' });
  assert.equal(t.state, 'draft');
  assert.equal(t.num, 1);
  tasks.transition(t.id, 'awaiting_transcript', 'phone', undefined, { prompt: 'שלום' });
  tasks.transition(t.id, 'queued', 'phone');
  tasks.transition(t.id, 'running', 'worker');
  const done = tasks.transition(t.id, 'done', 'worker', undefined, { resultText: 'x', resultSummary: 'y' });
  assert.equal(done.state, 'done');
  assert.equal(done.prompt, 'שלום');
  assert.equal(tasks.events(t.id).length, 5);
});

test('מעבר לא חוקי נדחה', () => {
  const { tasks, p } = setup();
  const t = tasks.create({ projectId: p.id, source: 'phone' });
  assert.throws(() => tasks.transition(t.id, 'running', 'x'), InvalidTransition);
});

test('נעילת שיחה: משימה שנייה לא מקבלת את אותה שיחה', () => {
  const { store } = setup();
  assert.equal(store.lockConversation('c1', 't1'), true);
  assert.equal(store.lockConversation('c1', 't2'), false);
  assert.equal(store.lockConversation('c1', 't1'), true);
  store.unlockConversation('c1', 't1');
  assert.equal(store.lockConversation('c1', 't2'), true);
});

test('תור: הישנה ראשונה, ומשימה שפג תוקפה מבוטלת', () => {
  const { tasks, p, store } = setup();
  const a = tasks.create({ projectId: p.id, source: 'phone', prompt: 'a' });
  const b = tasks.create({ projectId: p.id, source: 'phone', prompt: 'b' });
  for (const t of [a, b]) { tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); }
  store.db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', a.id);
  const next = tasks.nextQueued();
  assert.equal(next?.id, b.id);
  assert.equal(tasks.get(a.id)?.state, 'cancelled');
});

test('התאוששות אחרי אתחול: משימה רצה עוברת ל"דורשת בדיקה" ולא חוזרת לתור', () => {
  const { tasks, p, store } = setup();
  const t = tasks.create({ projectId: p.id, source: 'phone' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); tasks.transition(t.id, 'running', 'x');
  store.lockConversation('c', t.id);
  assert.equal(tasks.recoverAfterRestart(), 1);
  assert.equal(tasks.get(t.id)?.state, 'needs_review');
  assert.equal(tasks.nextQueued(), null);
  assert.equal(store.conversationLockedBy('c'), null);
});

test('תוצאות שלא נשמעו', () => {
  const { tasks, p } = setup();
  const t = tasks.create({ projectId: p.id, source: 'phone' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); tasks.transition(t.id, 'running', 'x'); tasks.transition(t.id, 'done', 'x');
  assert.equal(tasks.listUnheardResults().length, 1);
  tasks.markHeard(t.id);
  assert.equal(tasks.listUnheardResults().length, 0);
});
