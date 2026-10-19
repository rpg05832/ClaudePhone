// צינתוקים חינמיים (0.7.5): ההחלטה חינם/בתשלום, המטמון, קריאות ה-API, ומקש 9 בהגדרות.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreeTzintuk } from '../src/notify/free-tzintuk.ts';
import { YemotApi } from '../src/phone/yemot-api.ts';
import { Notifier } from '../src/notify/notifier.ts';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { DEFAULT_QUIET } from '../src/notify/quiet.ts';

const A = '0501234567', B = '0529876543', STRANGER = '0541112233';

test('צינתוקים חינמיים: חינם רק כשכל היעדים רשומים ואין ברשימה זר', async () => {
  let list = [A];
  let calls = 0;
  const ft = new FreeTzintuk({ listName: 'ClaudePhone', entries: async () => { calls++; return list; }, allowed: () => [A, B], cacheMs: 1000 });
  let c = await ft.check([A]);
  assert.equal(c.ok, true); assert.deepEqual(c.members, [A]);
  c = await ft.check([B]);
  assert.equal(c.ok, false); assert.deepEqual(c.missing, [B]);
  c = await ft.check([A, B]);
  assert.equal(c.ok, false);
  assert.equal(calls, 1, 'מטמון: קריאה אחת לרשת');
  // מספר זר ברשימה: לא משתמשים בה, גם אם היעד רשום
  list = [A, '972-54-111-2233'];
  c = await ft.check([A], true);
  assert.equal(c.ok, false); assert.deepEqual(c.foreign, [STRANGER]);
  // אחרי invalidate נקרא מחדש; פורמטים שונים של אותו מספר מנורמלים
  list = ['+972501234567', '052-987-6543'];
  ft.invalidate();
  c = await ft.check([A, B]);
  assert.equal(c.ok, true); assert.deepEqual(c.members, [A, B]);
  // כשל ברשת: המטמון הקודם נשאר, והשגיאה מדווחת
  const bad = new FreeTzintuk({ listName: 'X', entries: async () => { throw new Error('ימות: ERROR'); }, allowed: () => [A] });
  c = await bad.check([A]);
  assert.equal(c.ok, false); assert.match(c.error ?? '', /ERROR/);
  assert.equal(ft.status().free, true);
});

test('צינתוקים חינמיים: הקריאות לימות', async () => {
  const sent: { url: string; body: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), body });
    const reply = body.action === 'getlistEnteres'
      ? (body.TzintukimList === 'Empty' ? { responseStatus: 'Exception', message: 'Tzintukim List Does not exist' } : { responseStatus: 'OK', enteres: [{ phone: A, name: '' }, { phone: B, name: 'ב' }] })
      : { responseStatus: 'OK' };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as any;
  try {
    const y = new YemotApi('tok', 'https://x/api');
    await y.setTzintukListExtension('9/1', 'ClaudePhone');
    await y.tzintukList('ClaudePhone');
    assert.deepEqual(await y.tzintukListEntries('ClaudePhone'), [A, B]);
    assert.deepEqual(await y.tzintukListEntries('Empty'), [], 'רשימה שעוד לא נוצרה: ריקה, לא שגיאה');
  } finally { globalThis.fetch = orig; }
  assert.match(sent[0].url, /UpdateExtension$/);
  assert.deepEqual(sent[0].body, { token: 'tok', path: 'ivr2:9/1', type: 'tzintuk', list_tzintuk: 'ClaudePhone', tzintuk_end: 'hangup' });
  assert.match(sent[1].url, /RunTzintuk$/);
  assert.deepEqual(sent[1].body, { token: 'tok', phones: 'tzl:', tzintukLists: ['ClaudePhone'], TzintukTimeOut: 9 });
  assert.deepEqual(sent[2].body, { token: 'tok', action: 'getlistEnteres', TzintukimList: 'ClaudePhone' });
});

test('התראה: הצינתוק עובר דרך ההחלטה חינם/בתשלום ונרשם כנשלח', async () => {
  const store = new Store(':memory:');
  const tasks = new Tasks(store);
  const how: string[] = [];
  const n = new Notifier({
    store, tasks, quiet: { ...DEFAULT_QUIET, start: '23:00', end: '23:01', shabbatAndChag: false },
    phones: () => [A], inCall: () => false, maxAttempts: 3,
    tzintuk: async (phones) => { how.push(phones.join(',')); return 'free'; },
    now: () => new Date('2026-10-19T09:00:00+03:00'),
  });
  const proj = store.addProject({ name: 'p', spokenName: 'p', path: '/tmp/p' });
  const t = tasks.create({ projectId: proj.id, source: 'phone', prompt: 'x', phone: A });
  assert.equal(await n.event('done', t.id, A), 'sent');
  assert.deepEqual(how, [A]);
  assert.equal(store.notificationsInState('sent').length, 1);
});
