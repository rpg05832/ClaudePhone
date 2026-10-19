import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudSessions, parseSessionId, CloudError } from '../src/cloud-sessions.ts';

test('מזהה סשן: מקישור, חשוף, או לא תקין', () => {
  assert.equal(parseSessionId('https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv'), 'session_01AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(parseSessionId('claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv?from=cli&m=0'), 'session_01AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(parseSessionId('session_01AbCdEfGhIjKlMnOpQrStUv'), 'session_01AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(parseSessionId('https://claude.ai/code/artifact/abc'), null);
  assert.equal(parseSessionId('שלום'), null);
});

function make(run: (exe: string, args: string[]) => Promise<{ code: number; out: string }>) {
  return new CloudSessions({
    sessions: () => [
      { name: 'הוועד', url: 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv' },
      { name: 'כפול', id: 'session_01AbCdEfGhIjKlMnOpQrStUv' },
      { name: 'שבור', url: 'https://example.com' },
    ],
    claudeExe: () => 'claude', run,
  });
}

test('רשימה: בלי כפילויות ובלי קישורים שבורים', () => {
  assert.deepEqual(make(async () => ({ code: 0, out: '' })).list(), [{ id: 'session_01AbCdEfGhIjKlMnOpQrStUv', name: 'הוועד' }]);
});

test('שליחה: הפקודה הנכונה, וטקסט המשתמש נשלח כארגומנט אחד', async () => {
  const calls: string[][] = [];
  const c = make(async (exe, args) => { calls.push([exe, ...args]); return { code: 0, out: '' }; });
  await c.send('session_01AbCdEfGhIjKlMnOpQrStUv', '--help; rm -rf /');
  assert.deepEqual(calls[0], ['claude', '-p', '--help; rm -rf /', '--cloud', 'session_01AbCdEfGhIjKlMnOpQrStUv']);
});

test('שליחה: שיחה שלא ברשימה, הודעה ריקה, וכשלים מוסברים', async () => {
  const ok = make(async () => ({ code: 0, out: '' }));
  await assert.rejects(ok.send('session_other0000000000', 'שלום'), /לא ברשימה/);
  await assert.rejects(ok.send('session_01AbCdEfGhIjKlMnOpQrStUv', '  '), CloudError);
  const id = 'session_01AbCdEfGhIjKlMnOpQrStUv';
  await assert.rejects(make(async () => ({ code: 1, out: 'Error: cloud session x is archived and cannot accept new messages' })).send(id, 'א'), /בארכיון/);
  await assert.rejects(make(async () => ({ code: 1, out: 'Session not found: x' })).send(id, 'א'), /לא נמצאה/);
  await assert.rejects(make(async () => ({ code: 1, out: 'Cloud sessions need a claude.ai sign-in. Run `claude auth login`' })).send(id, 'א'), /auth login/);
});
