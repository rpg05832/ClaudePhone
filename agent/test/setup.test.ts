import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { loadConfig, AGENT_ROOT } from '../src/config.ts';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { ClaudeHistory } from '../src/history/claude-history.ts';
import { ConversationIndex } from '../src/history/conversations.ts';
import { startDashboard, isLocalOrigin } from '../src/web/server.ts';
import { SetupApi, needsSetup, normalizePhone } from '../src/setup/routes.ts';
import { verifyPin, loadPinHash } from '../src/util/pin.ts';

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cpsetup-'));
  copyFileSync(join(AGENT_ROOT, 'config.example.json'), join(root, 'config.example.json'));
  return root;
}

test('נרמול מספר טלפון', () => {
  assert.equal(normalizePhone('050-123-4567'), '0501234567');
  assert.equal(normalizePhone('+972 50 123 4567'), '0501234567');
  assert.equal(normalizePhone('02-6234567'), '026234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('Origin מקומי בלבד', () => {
  assert.equal(isLocalOrigin('http://127.0.0.1:7788', 7788), true);
  assert.equal(isLocalOrigin('http://localhost:7788', 7788), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:9999', 7788), false);
  assert.equal(isLocalOrigin('https://evil.com', 7788), false);
  assert.equal(isLocalOrigin(undefined, 7788), false);
});

test('אשף: טלפונים, PIN, פרויקטים, העדפות, ומצב הגדרה', async () => {
  const root = tempRoot();
  const cfg = loadConfig(root);
  assert.equal(needsSetup(cfg), true);
  const store = new Store(':memory:');
  let restarted = 0;
  const api = new SetupApi({ cfg, store, mode: 'setup', launcherPath: null, makeShortcut: async () => 'קיצור (בדיקה)', dashboardUrl: () => 'http://x', restart: () => { restarted++; }, root });

  assert.equal((await api.handle('POST', '/phones', { phones: ['abc'], pin: '1234' })).code, 400);
  assert.equal((await api.handle('POST', '/phones', { phones: ['0501234567'] })).code, 400);           // אין PIN עדיין
  assert.equal((await api.handle('POST', '/phones', { phones: ['0501234567'], pin: '12' })).code, 400);
  assert.equal((await api.handle('POST', '/phones', { phones: ['050-1234567', '0501234567', '+972521112222'], pin: '4321' })).code, 200);
  assert.deepEqual(cfg.phones.allowed, ['0501234567', '0521112222']);
  assert.ok(verifyPin('4321', loadPinHash(cfg.phones.pinHashFile)!));
  assert.ok(!readFileSync(cfg.phones.pinHashFile, 'utf8').includes('4321'));
  // שמירה בלי PIN חדש משאירה את הקיים
  assert.equal((await api.handle('POST', '/phones', { phones: ['0501234567'] })).code, 200);
  assert.ok(verifyPin('4321', loadPinHash(cfg.phones.pinHashFile)!));

  const parent = join(root, 'projects');
  const extra = join(root, 'existing'); mkdirSync(extra);
  assert.equal((await api.handle('POST', '/projects', { parent, extra: [join(root, 'nope')] })).code, 400);
  assert.equal((await api.handle('POST', '/projects', { parent, extra: [extra] })).code, 200);
  assert.ok(existsSync(parent));
  assert.equal(store.listProjects(true).length, 1);

  const pr = await api.handle('POST', '/prefs', { editMode: 'auto', voice: 'nope', rate: 99, notify: 'off' });
  assert.equal((pr.json as any).settings.editMode, 'auto');
  assert.equal((pr.json as any).settings.rate, 10);
  assert.equal((pr.json as any).settings.notify, 'off');

  // עדיין חסרה ימות: אי אפשר לסיים
  assert.equal((await api.handle('POST', '/finish', {})).code, 400);
  writeFileSync(cfg.yemot.tokenFile, 'tok\n'); cfg.yemot.chatExtension = '9';
  assert.equal(needsSetup(cfg), false);
  const fin = await api.handle('POST', '/finish', {});
  assert.equal(fin.code, 200);
  await new Promise(r => setTimeout(r, 900));
  assert.equal(restarted, 1);

  // ההגדרות נשמרו ב-config.json של המשתמש ונטענות מחדש
  const again = loadConfig(root);
  assert.deepEqual(again.phones.allowed, ['0501234567']);
  assert.equal(again.projects.newProjectsParent, parent);
  assert.equal((again as any).setupDone, true);
  const st = api.status();
  assert.equal(st.phones[0], '•••4567');
  assert.ok(!JSON.stringify(st).includes('0501234567'));
});

function req(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

test('אשף דרך לוח הבקרה: הגנת CSRF ומצב הגדרה', async () => {
  const root = tempRoot();
  const cfg = loadConfig(root);
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const history = new ClaudeHistory(join(root, 'none'));
  const setup = new SetupApi({ cfg, store, mode: 'setup', launcherPath: null, makeShortcut: async () => 'קיצור (בדיקה)', dashboardUrl: () => 'x', restart: () => {}, root });
  const port = 19000 + Math.floor(Math.random() * 2000);
  const web = join(root, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<html></html>');
  const srv = startDashboard({ port, tokenFile: join(root, 'data', 'dash.token'), staticDir: web, recordingsDir: join(root, 'rec'), store, tasks, history,
    conversations: new ConversationIndex(store, history, { resumeSources: ['sdk'], activeMinutes: 3 }), health: () => ({}), mode: 'setup', setup });
  await new Promise(r => srv.once('listening', r));
  try {
    const token = readFileSync(join(root, 'data', 'dash.token'), 'utf8').trim();
    const ck = { cookie: `cp_token=${token}` };
    const origin = { origin: `http://127.0.0.1:${port}`, 'x-cp': '1' };
    const body = { editMode: 'readonly' };
    assert.equal((await req(port, 'POST', '/api/setup/prefs', { ...origin }, body)).status, 401);                     // בלי עוגייה
    assert.equal((await req(port, 'POST', '/api/setup/prefs', { ...ck, 'x-cp': '1' }, body)).status, 403);          // בלי Origin
    assert.equal((await req(port, 'POST', '/api/setup/prefs', { ...ck, origin: 'https://evil.com', 'x-cp': '1' }, body)).status, 403);
    assert.equal((await req(port, 'POST', '/api/setup/prefs', { ...ck, origin: origin.origin }, body)).status, 403); // בלי X-CP
    const ok = await req(port, 'POST', '/api/setup/prefs', { ...ck, ...origin }, body);
    assert.equal(ok.status, 200);
    assert.equal(store.getSettings().editMode, 'readonly');
    assert.equal((await req(port, 'POST', '/api/overview', { ...ck, ...origin }, {})).status, 405);                 // שאר הלוח לקריאה בלבד
    const ov = JSON.parse((await req(port, 'GET', '/api/overview', ck)).body);
    assert.equal(ov.mode, 'setup');
    const st = JSON.parse((await req(port, 'GET', '/api/setup/status', ck)).body);
    assert.equal(st.mode, 'setup');
    assert.equal(st.done.pin, false);
  } finally { srv.close(); }
});

test('תיקיות מוכרות: Cowork, שיחות Claude, סינון וכפילויות', async () => {
  const { knownFolders } = await import('../src/setup/known-folders.ts');
  const root = mkdtempSync(join(tmpdir(), 'cpknown-'));
  const appData = join(root, 'AppData');
  const acct = join(appData, 'Claude', 'local-agent-mode-sessions', 'u1', 'o1'); mkdirSync(acct, { recursive: true });
  const a = join(root, 'Meirovitz'); const b = join(root, 'Archive'); const gone = join(root, 'gone'); const inside = join(appData, 'Claude', 'x');
  mkdirSync(a); mkdirSync(b); mkdirSync(inside, { recursive: true });
  writeFileSync(join(acct, 'spaces.json'), JSON.stringify({ spaces: [{ name: 'מאירוביץ', folders: [{ path: a }, { path: gone }], updatedAt: 1000 }] }));
  writeFileSync(join(acct, 'local_1.json'), JSON.stringify({ title: 't', userSelectedFolders: [b, '/sessions/vm'], lastActivityAt: 5000, systemPrompt: 'x'.repeat(1000) }));
  writeFileSync(join(acct, 'local_2.json'), JSON.stringify({ userSelectedFolders: [b, inside], lastActivityAt: 9000 }));
  const fakeHistory = { list: () => [{ cwd: a, source: 'desktop', lastActiveAt: new Date(20000).toISOString() }, { cwd: a, source: 'cli', lastActiveAt: new Date(100).toISOString() }] } as any;
  const list = knownFolders({ history: fakeHistory, appData, keepTemp: true });
  assert.deepEqual(list.map(f => f.path), [a, b]);            // הקיימות בלבד, בלי AppData\Claude ובלי נתיבי VM, לפי שימוש אחרון
  assert.equal(list[0].name, 'מאירוביץ');
  assert.deepEqual(list[0].sources.sort(), ['code', 'cowork', 'desktop']);
  assert.equal(list[0].conversations, 2);
  assert.equal(list[1].conversations, 2);
  assert.equal(list[1].lastUsed, new Date(9000).toISOString());
});

test('אשף: פרויקט שהוסר מהבחירה יוצא מהטלפון', async () => {
  const root = tempRoot();
  const cfg = loadConfig(root);
  const store = new Store(':memory:');
  const api = new SetupApi({ cfg, store, mode: 'setup', launcherPath: null, makeShortcut: async () => 'קיצור (בדיקה)', dashboardUrl: () => 'x', restart: () => {}, root });
  const parent = join(root, 'p'); const x = join(root, 'x'); const y = join(root, 'y'); mkdirSync(x); mkdirSync(y);
  assert.equal((await api.handle('POST', '/projects', { parent, extra: [{ path: x, name: 'מאירוביץ' }, y, x] })).code, 200);
  assert.deepEqual(store.listProjects(true).map(p => p.spokenName).sort(), ['y', 'מאירוביץ'].sort());
  assert.equal((await api.handle('POST', '/projects', { parent, extra: [y] })).code, 200);
  assert.deepEqual(store.listProjects(true).map(p => p.path), [y]);
  assert.equal(store.listProjects().length, 2);
});
