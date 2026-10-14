import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { ClaudeHistory } from '../src/history/claude-history.ts';
import { ConversationIndex } from '../src/history/conversations.ts';
import { PermissionBroker } from '../src/claude/broker.ts';
import { DashboardActions } from '../src/web/actions.ts';
import { startDashboard } from '../src/web/server.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cpact-'));
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const history = new ClaudeHistory(join(dir, 'none'));
  const conversations = new ConversationIndex(store, history, { resumeSources: ['sdk'], activeMinutes: 3 });
  const broker = new PermissionBroker({ store, tasks, minutes: 10, onEvent: () => {} });
  const kicks: number[] = []; const stops: string[] = []; const voices: string[] = [];
  const actions = new DashboardActions({
    store, tasks, conversations, kickWorker: () => kicks.push(1), requestStop: (id) => stops.push(id),
    decide: (id, d, via) => broker.decide(id, d, via), applyVoice: async (v, r) => { voices.push(`${v}:${r}`); },
  });
  const p = store.addProject({ name: 'אתר', path: join(dir, 'p') });
  return { dir, store, tasks, history, conversations, broker, actions, kicks, stops, voices, p };
}

test('לוח פעיל: משימה חדשה, המשך שיחה, ושיחה שאי אפשר להמשיך', async () => {
  const s = setup();
  assert.equal((await s.actions.handle('/tasks', { projectId: s.p.id, prompt: '  ' })).code, 400);
  const r = await s.actions.handle('/tasks', { projectId: s.p.id, prompt: 'תוסיף כפתור' });
  assert.equal(r.code, 200);
  const t = r.json as any;
  assert.equal(t.state, 'queued'); assert.equal(t.source, 'dashboard'); assert.equal(t.conversationId, null);
  assert.equal(s.kicks.length, 1);
  // המשך לשיחה שלנו
  s.store.upsertConversation({ id: 'conv-1', projectId: s.p.id, title: 'כפתור', source: 'phone' });
  const c = await s.actions.handle('/tasks', { conversationId: 'conv-1', prompt: 'ועכשיו בירוק' });
  assert.equal((c.json as any).conversationId, 'conv-1');
  assert.equal((c.json as any).projectId, s.p.id);
  assert.equal((await s.actions.handle('/tasks', { conversationId: 'nope', prompt: 'x' })).code, 404);
  // פרויקט כבוי
  s.store.updateProject(s.p.id, { phoneEnabled: false });
  assert.match(((await s.actions.handle('/tasks', { projectId: s.p.id, prompt: 'x' })).json as any).error, /כבוי/);
});

test('לוח פעיל: עצירה, נשמע, הגדרות ופרויקט', async () => {
  const s = setup();
  const t = (await s.actions.handle('/tasks', { projectId: s.p.id, prompt: 'x' })).json as any;
  assert.equal((await s.actions.handle(`/tasks/${t.id}/stop`, {})).code, 200);
  assert.deepEqual(s.stops, [t.id]);
  assert.equal((await s.actions.handle(`/tasks/${t.id}/heard`, {})).code, 200);
  const st = await s.actions.handle('/settings', { editMode: 'auto', voice: 'Sivan', rate: 4 });
  assert.equal((st.json as any).settings.editMode, 'auto');
  assert.deepEqual(s.voices, ['Sivan:4']);
  assert.equal((await s.actions.handle('/settings', { editMode: 'god' })).code, 400);
  await s.actions.handle('/settings', { notify: 'off' });
  assert.deepEqual(s.voices, ['Sivan:4']);   // בלי שינוי קול: השלוחה לא מתעדכנת
  const p = (await s.actions.handle(`/projects/${s.p.id}`, { spokenName: 'האתר של מאירוביץ', editInsideProject: false })).json as any;
  assert.equal(p.spokenName, 'האתר של מאירוביץ');
  assert.equal(p.permissions.editInsideProject, false);
  assert.equal(p.phoneEnabled, true);
});

test('לוח פעיל: אישור בקשה, ובקשה שכבר הוכרעה', async () => {
  const s = setup();
  const t = s.tasks.create({ projectId: s.p.id, source: 'phone', prompt: 'x' });
  s.tasks.transition(t.id, 'awaiting_transcript', 'x'); s.tasks.transition(t.id, 'queued', 'x'); s.tasks.transition(t.id, 'running', 'x');
  const ac = new AbortController();
  const pending = s.broker.request(s.tasks.get(t.id)!, s.p, 'Bash', { command: 'npm test' }, 'הרצת בדיקות', ac.signal);
  const req = s.store.pendingPermissionRequests()[0];
  const r = await s.actions.handle(`/permissions/${req.id}`, { decision: 'allow' });
  assert.equal(r.code, 200);
  assert.deepEqual(await pending, { kind: 'allow' });
  assert.equal(s.store.getPermissionRequest(req.id)!.decidedVia, 'dashboard');
  const again = await s.actions.handle(`/permissions/${req.id}`, { decision: 'deny' });
  assert.equal(again.code, 409);
});

function post(port: number, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on('error', reject); r.write(JSON.stringify(body)); r.end();
  });
}

test('לוח פעיל דרך השרת: רק עם עוגייה, Origin מקומי וכותרת X-CP', async () => {
  const s = setup();
  const web = join(s.dir, 'web'); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<html></html>');
  const port = 21000 + Math.floor(Math.random() * 2000);
  const tokenFile = join(s.dir, 'token');
  const srv = startDashboard({ port, tokenFile, staticDir: web, recordingsDir: join(s.dir, 'rec'), store: s.store, tasks: s.tasks, history: s.history,
    conversations: s.conversations, health: () => ({}), mode: 'running', actions: s.actions });
  await new Promise(r => srv.once('listening', r));
  try {
    const ck = `cp_token=${readFileSync(tokenFile, 'utf8').trim()}`;
    const origin = `http://127.0.0.1:${port}`;
    const body = { projectId: s.p.id, prompt: 'מהלוח' };
    assert.equal((await post(port, '/api/tasks', { origin, 'x-cp': '1' }, body)).status, 401);
    assert.equal((await post(port, '/api/tasks', { cookie: ck, 'x-cp': '1' }, body)).status, 403);
    assert.equal((await post(port, '/api/tasks', { cookie: ck, origin: 'https://evil.example', 'x-cp': '1' }, body)).status, 403);
    assert.equal((await post(port, '/api/tasks', { cookie: ck, origin }, body)).status, 403);
    assert.equal(s.tasks.recent(10).length, 0);
    const ok = await post(port, '/api/tasks', { cookie: ck, origin, 'x-cp': '1' }, body);
    assert.equal(ok.status, 200);
    assert.equal(s.tasks.recent(10).length, 1);
  } finally { srv.close(); }
});

test('לוח פעיל: פרויקט חדש, זמני שקט, וייצוא-ייבוא בלי סודות', async () => {
  const { copyFileSync } = await import('node:fs');
  const { loadConfig, AGENT_ROOT } = await import('../src/config.ts');
  const { DEFAULT_QUIET } = await import('../src/notify/quiet.ts');
  const root = mkdtempSync(join(tmpdir(), 'cpimp-'));
  copyFileSync(join(AGENT_ROOT, 'config.example.json'), join(root, 'config.example.json'));
  const cfg = loadConfig(root);
  cfg.phones.allowed = ['0501234567'];
  const quiet = { ...DEFAULT_QUIET, ...cfg.quietHours };
  const s = setup();
  const created: string[] = [];
  const actions = new DashboardActions({
    store: s.store, tasks: s.tasks, conversations: s.conversations, kickWorker: () => {}, requestStop: () => {},
    decide: (id, d, via) => s.broker.decide(id, d, via), cfg, quiet, root,
    createProject: async (name) => { if (!name.trim()) throw new Error('צריך שם'); created.push(name); return s.store.addProject({ name, path: join(s.dir, name) }); },
  });
  assert.equal((await actions.handle('/projects/new', { name: '' })).code, 400);
  assert.equal((await actions.handle('/projects/new', { name: 'אתר חדש' })).code, 200);
  assert.deepEqual(created, ['אתר חדש']);

  assert.equal((await actions.handle('/quiet', { start: '25:00' })).code, 400);
  const q = await actions.handle('/quiet', { start: '22:30', end: '06:45', includeCholHamoed: true, retentionDays: 30 });
  assert.equal(q.code, 200);
  assert.equal(quiet.start, '22:30');                       // המתריע רואה את השינוי מיד
  assert.equal(cfg.retention.recordingsDays, 30);
  assert.equal(loadConfig(root).quietHours.end, '06:45');   // ונשמר

  const ex = actions.exportData() as any;
  assert.equal(ex.format, 'claudephone-settings');
  assert.deepEqual(ex.phones, ['0501234567']);
  const text = JSON.stringify(ex);
  assert.ok(!/token|pin/i.test(Object.keys(ex).join(',')));
  assert.ok(!text.includes('pinHash'));

  // ייבוא למחשב "אחר": פרויקט שקיים, פרויקט שחסר, טלפונים ושעות
  const s2 = setup();
  const root2 = mkdtempSync(join(tmpdir(), 'cpimp2-'));
  copyFileSync(join(AGENT_ROOT, 'config.example.json'), join(root2, 'config.example.json'));
  const cfg2 = loadConfig(root2);
  const quiet2 = { ...DEFAULT_QUIET };
  const a2 = new DashboardActions({ store: s2.store, tasks: s2.tasks, conversations: s2.conversations, kickWorker: () => {}, requestStop: () => {}, decide: (id, d, via) => s2.broker.decide(id, d, via), cfg: cfg2, quiet: quiet2, root: root2 });
  const existing = join(s2.dir, 'קיים'); mkdirSync(existing);
  ex.projects = [{ name: 'קיים', spokenName: 'הקיים', path: existing, phoneEnabled: true, editInsideProject: false }, { name: 'חסר', path: join(s2.dir, 'no') }];
  assert.equal((await a2.handle('/import', { data: { format: 'other' } })).code, 400);
  const r = await a2.handle('/import', { data: ex });
  assert.equal(r.code, 200);
  assert.equal((r.json as any).missing.length, 1);
  assert.deepEqual(cfg2.phones.allowed, ['0501234567']);
  assert.equal(quiet2.start, '22:30');
  const imported = s2.store.getProjectByPath(existing)!;
  assert.equal(imported.spokenName, 'הקיים');
  assert.equal(imported.permissions.editInsideProject, false);
  assert.equal(loadConfig(root2).projects.list.length, 1);
});

test('מודל: הגדרה כללית, בחירה לבקשה, וקדימות', async () => {
  const { modelFor } = await import('../src/claude/worker.ts');
  const s = setup();
  assert.equal(s.store.getSettings().model, 'default');
  assert.equal((await s.actions.handle('/settings', { model: 'gpt' })).code, 400);
  await s.actions.handle('/settings', { model: 'sonnet' });
  assert.equal(s.store.getSettings().model, 'sonnet');
  const t = (await s.actions.handle('/tasks', { projectId: s.p.id, prompt: 'x', model: 'haiku' })).json as any;
  assert.equal(t.model, 'haiku');
  assert.equal(modelFor(t, 'sonnet', 'opus'), 'haiku');
  assert.equal(modelFor({ ...t, model: null }, 'sonnet', 'opus'), 'sonnet');
  assert.equal(modelFor({ ...t, model: null }, 'default', undefined), undefined);
  assert.equal((await s.actions.handle('/tasks', { projectId: s.p.id, prompt: 'x', model: 'nope' })).code, 400);
  assert.equal((await s.actions.handle('/settings', { effort: 'xhigh' })).code, 200);
  assert.equal(s.store.getSettings().effort, 'xhigh');
  assert.equal((await s.actions.handle('/settings', { effort: 'ultra' })).code, 400);
});
