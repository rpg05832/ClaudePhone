import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { ClaudeHistory } from '../src/history/claude-history.ts';
import { ConversationIndex } from '../src/history/conversations.ts';
import { startDashboard, maskPhone } from '../src/web/server.ts';

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode!, body: b, headers: res.headers }));
    }).on('error', reject);
  });
}

test('לוח הבקרה: אסימון, הגנת Host, API לקריאה, וחסימת שינויים', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpweb-'));
  const web = join(dir, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<html>לוח</html>');
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const p = store.addProject({ name: 'אתר', path: join(dir, 'proj') });
  store.upsertConversation({ id: 'conv-1', projectId: p.id, title: 'כפתור יצירת קשר', source: 'phone' });
  const t = tasks.create({ projectId: p.id, source: 'phone', prompt: 'תוסיף כפתור ירוק', conversationId: 'conv-1' });
  store.phoneLog({ callId: 'c', phone: '0501234567', kind: 'pin_ok' });
  const history = new ClaudeHistory(join(dir, 'none'));
  const port = 17000 + Math.floor(Math.random() * 2000);
  const tokenFile = join(dir, 'token');
  const srv = startDashboard({ port, tokenFile, staticDir: web, recordingsDir: join(dir, 'rec'), store, tasks, history,
    conversations: new ConversationIndex(store, history, { resumeSources: ['sdk'], activeMinutes: 3 }), health: () => ({ agent: { ok: true } }) });
  await new Promise(r => srv.once('listening', r));
  try {
    assert.equal((await get(port, '/api/overview')).status, 401);
    assert.equal((await get(port, '/api/overview', { host: 'evil.com' })).status, 403);
    const { readFileSync } = await import('node:fs');
    const token = readFileSync(tokenFile, 'utf8').trim();
    const login = await get(port, `/?t=${token}`);
    assert.equal(login.status, 302);
    const ck = String(login.headers['set-cookie']).split(';')[0];
    assert.equal((await get(port, '/?t=wrong')).status, 401);
    const ov = JSON.parse((await get(port, '/api/overview', { cookie: ck })).body);
    assert.equal(ov.health.agent.ok, true);
    const convs = JSON.parse((await get(port, '/api/conversations?q=' + encodeURIComponent('ירוק'), { cookie: ck })).body);
    assert.deepEqual(convs.map((c: any) => c.id), ['conv-1']);
    const one = JSON.parse((await get(port, '/api/conversations/conv-1', { cookie: ck })).body);
    assert.equal(one.tasks[0].id, t.id);
    const log = JSON.parse((await get(port, '/api/phonelog', { cookie: ck })).body);
    assert.equal(log[0].phone, '•••4567');
    assert.match((await get(port, '/conversations/x', { cookie: ck })).body, /לוח/);   // ניתוב צד לקוח
    const post = await new Promise<number>(res => { const r = http.request({ host: '127.0.0.1', port, path: '/api/overview', method: 'POST', headers: { host: '127.0.0.1', cookie: ck } }, x => res(x.statusCode!)); r.end(); });
    assert.equal(post, 405);
  } finally { srv.close(); }
});

test('הסתרת מספר טלפון', () => { assert.equal(maskPhone('0527654321'), '•••4321'); });
