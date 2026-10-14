import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decide, isInside } from '../src/claude/policy.ts';
import { splitSummary } from '../src/claude/runner.ts';
import { hashPin, verifyPin } from '../src/util/pin.ts';
import { folderNameFor, createProjectFromPhone } from '../src/projects.ts';
import { san, ttsSegments, r } from '../src/phone/response.ts';
import { Store } from '../src/store/db.ts';

const perms = { editInsideProject: true, runCommands: false };

test('מדיניות: עריכה בפרויקט מותרת, מחוץ לו נחסמת, ופקודות נשאלות', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-'));
  assert.equal(decide('Write', { file_path: join(root, 'a', 'b.txt') }, root, perms).action, 'allow');
  assert.equal(decide('Edit', { file_path: join(root, '..', 'x.txt') }, root, perms).action, 'deny');
  assert.equal(decide('Bash', { command: 'rm -rf /' }, root, perms).action, 'ask');
  assert.equal(decide('Write', { file_path: join(root, 'a.txt') }, root, { ...perms, editInsideProject: false }).action, 'deny');
  assert.equal(decide('Write', { file_path: join(root, 'a.txt') }, root, perms, 'readonly').action, 'deny');
});

test('מדיניות: קישור שיוצא מהפרויקט נחסם', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-'));
  const outside = mkdtempSync(join(tmpdir(), 'cp-out-'));
  try { symlinkSync(outside, join(root, 'link'), 'dir'); } catch { return; } // ב-Windows בלי הרשאה: מדלגים
  assert.equal(isInside(root, join(root, 'link', 'f.txt')), false);
});

test('סיכום להקראה לפי שורת ---', () => {
  const s = splitSummary('הוספתי כפתור. הכול עובד.\n---\n```js\nx()\n```');
  assert.equal(s.summary, 'הוספתי כפתור. הכול עובד.');
  const s2 = splitSummary('# כותרת\n**שלום** `code`');
  assert.equal(s2.summary, 'כותרת שלום code');
});

test('PIN נשמר כגיבוב ונבדק', () => {
  const h = hashPin('1234');
  assert.ok(!h.includes('1234'));
  assert.equal(verifyPin('1234', h), true);
  assert.equal(verifyPin('1235', h), false);
});

test('שם פרויקט: תווים אסורים ויציאה מהתיקייה נדחים', async () => {
  assert.equal(folderNameFor('חנות.'), 'חנות');
  assert.throws(() => folderNameFor('../x'));
  assert.throws(() => folderNameFor('a/b'));
  assert.throws(() => folderNameFor('CON'));
  const parent = mkdtempSync(join(tmpdir(), 'cp-parent-'));
  const store = new Store(':memory:');
  const p = await createProjectFromPhone(store, parent, 'חנות', false);
  assert.ok(existsSync(p.path));
  await assert.rejects(() => createProjectFromPhone(store, parent, 'חנות', false), /כבר קיים/);
  mkdirSync(join(parent, 'קיים'));
  await assert.rejects(() => createProjectFromPhone(store, parent, 'קיים', false), /כבר קיים/);
});

test('תשובות ימות: ניקוי ומקטעים', () => {
  assert.equal(san('a,b-c=d&e.f'), 'a b c d e f');
  assert.ok(ttsSegments('מילה '.repeat(200)).every(s => s.length <= 220));
  assert.equal(r().say('שלום').hangup().toString(), 'id_list_message=t-שלום&go_to_folder=hangup');
});

test('קליטת מקשים: בלי השמעת ההקשה ובלי בקשת אישור; סולמית לבד מותרת רק כשביקשנו', () => {
  assert.equal(r().readDigits('בחר', 'v1').toString(), 'read=t-בחר=v1,no,1,1,15,NO,no,no,,,,,,,no');
  assert.equal(r().readDigits('בחר', 'v2', { min: 0 }).toString(), 'read=t-בחר=v2,no,1,1,15,NO,no,no,,,,Ok,EMPTY,,no');
});
