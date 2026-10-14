import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync, appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { ClaudeHistory } from '../src/history/claude-history.ts';
import { CoworkHistory } from '../src/history/cowork.ts';
import { ConversationIndex } from '../src/history/conversations.ts';
import { Worker } from '../src/claude/worker.ts';
import { PermissionBroker } from '../src/claude/broker.ts';

/** מבנה כמו של Claude Desktop: שיחה על המחשב (עם תיקייה מקומית), שיחה במכונה הווירטואלית, ושיחה בארכיון. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cpcow-'));
  const coworkRoot = join(root, 'local-agent-mode-sessions');
  const org = join(coworkRoot, 'acct', 'org'); mkdirSync(org, { recursive: true });
  const claudeProjects = join(root, 'dot-claude-projects'); mkdirSync(claudeProjects);
  const folder = join(root, 'מאירוביץ'); mkdirSync(folder);
  writeFileSync(join(org, 'spaces.json'), JSON.stringify({ spaces: [{ id: 'sp1', name: 'מאירוביץ', folders: [{ path: folder }] }] }));

  const mk = (local: string, cli: string, extra: Record<string, unknown>, lines: object[] | null) => {
    const localDir = join(org, local);
    const outputs = join(localDir, 'outputs'); mkdirSync(outputs, { recursive: true });
    const meta = { sessionId: local, cliSessionId: cli, cwd: outputs, userSelectedFolders: [folder], title: 'כותרת ' + local, createdAt: 1000, lastActivityAt: 2000, spaceId: 'sp1', isArchived: false, systemPrompt: 'x'.repeat(5000), ...extra };
    writeFileSync(join(org, local + '.json'), JSON.stringify(meta));
    if (lines) {
      const pd = join(localDir, '.claude', 'projects', 'C--enc-' + local); mkdirSync(pd, { recursive: true });
      const f = join(pd, cli + '.jsonl');
      writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
      const old = new Date(Date.now() - 3600_000); utimesSync(f, old, old);
      return { localDir, outputs, transcript: f };
    }
    return { localDir, outputs, transcript: null };
  };
  const convo = [
    { type: 'user', entrypoint: 'local-agent', timestamp: '2026-05-01T10:00:00Z', message: { role: 'user', content: 'תבנה דוח' } },
    { type: 'assistant', timestamp: '2026-05-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'הדוח מוכן ושמור.\n---\nפירוט ארוך' }] } },
  ];
  const host = mk('local_host', 'cli-host', {}, convo);
  const vm = mk('local_vm', 'cli-vm', { cwd: '/sessions/happy-vm', title: 'שיחה במכונה' }, convo);
  mk('local_arch', 'cli-arch', { isArchived: true }, convo);
  return { root, coworkRoot, claudeProjects, folder, host, vm };
}

test('Cowork: רשימה, פרויקט Cowork, מקור, והקראת תוכן', () => {
  const f = fixture();
  const cw = new CoworkHistory(f.coworkRoot, f.claudeProjects);
  const list = cw.list();
  assert.equal(list.length, 3);
  const host = cw.get('cli-host')!;
  assert.equal(host.spaceName, 'מאירוביץ');
  assert.equal(host.hostMode, true);
  assert.equal(host.transcript, f.host.transcript);
  assert.equal(cw.get('cli-vm')!.hostMode, false);
  assert.deepEqual(cw.messages('cli-host').map(m => m.role), ['user', 'assistant']);
});

test('Cowork באינדקס השיחות: שייכות לפרויקט, סיבות חסימה, ובלי ארכיון בטלפון', () => {
  const f = fixture();
  const store = new Store(':memory:');
  const cw = new CoworkHistory(f.coworkRoot, f.claudeProjects);
  const history = new ClaudeHistory(f.claudeProjects);
  const idx = new ConversationIndex(store, history, { resumeSources: ['sdk', 'cowork'], activeMinutes: 3 }, cw);
  // לפני שהתיקייה נרשמה כפרויקט
  assert.equal(idx.get('cli-host')!.blockedReason, 'התיקייה של השיחה אינה פרויקט בטלפון');
  const p = store.addProject({ name: 'מאירוביץ', path: f.folder });
  const host = idx.get('cli-host')!;
  assert.equal(host.source, 'cowork');
  assert.equal(host.projectId, p.id);
  assert.equal(host.canContinue, true);
  assert.equal(host.coworkProject, 'מאירוביץ');
  assert.match(idx.get('cli-vm')!.blockedReason!, /מכונה הווירטואלית/);
  assert.deepEqual(idx.forPhone().map(c => c.id).sort(), ['cli-host', 'cli-vm']);   // הארכיון לא בטלפון
  assert.equal(idx.messages('cli-host').at(-1)!.text.startsWith('הדוח מוכן'), true);
  // כבוי בהגדרות
  const off = new ConversationIndex(store, history, { resumeSources: ['sdk'], activeMinutes: 3 }, cw);
  assert.match(off.get('cli-host')!.blockedReason!, /כבוי/);
  // נכתבה עכשיו (פתוחה ב-Desktop)
  appendFileSync(f.host.transcript!, '\n');
  assert.equal(idx.get('cli-host')!.blockedReason, 'השיחה פתוחה כרגע ב-Desktop');
});

test('המשך שיחת Cowork: רץ בתיקייה של השיחה, כותב לתמליל של Desktop, הקישור מוסר, והכתיבה שלנו לא חוסמת', async () => {
  const f = fixture();
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const cw = new CoworkHistory(f.coworkRoot, f.claudeProjects);
  const idx = new ConversationIndex(store, new ClaudeHistory(f.claudeProjects), { resumeSources: ['cowork'], activeMinutes: 3 }, cw);
  const p = store.addProject({ name: 'מאירוביץ', path: f.folder });
  const linkPath = join(f.claudeProjects, 'C--enc-local_host', 'cli-host.jsonl');
  const seen: any[] = [];
  const query = ({ options }: any) => (async function* () {
    seen.push({ options, linked: existsSync(linkPath), sameFile: existsSync(linkPath) && statSync(linkPath).ino === statSync(f.host.transcript!).ino });
    appendFileSync(linkPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'מהטלפון' } }) + '\n');   // Claude Code כותב דרך הקישור
    yield { type: 'system', subtype: 'init', session_id: 'cli-host' };
    const inside = await options.canUseTool('Write', { file_path: join(options.cwd, 'report.md'), content: 'x' });
    const proj = await options.canUseTool('Write', { file_path: join(f.folder, 'a.txt'), content: 'x' });
    seen.push({ inside: inside.behavior, proj: proj.behavior });
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'cli-host', result: 'בוצע' };
  })();
  const broker = new PermissionBroker({ store, tasks, minutes: 10, onEvent: () => {} });
  const worker = new Worker({ store, tasks, query: query as any, maxTurns: 5, permissionMinutes: 10, broker, coworkRun: (id) => idx.coworkRun(id) });
  const run = (prompt: string) => {
    const t = tasks.create({ projectId: p.id, source: 'phone', prompt, conversationId: 'cli-host' });
    tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x');
    worker.kick();
    return t;
  };
  const until = async (fn: () => boolean) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); };
  const t = run('תוסיף סיכום');
  await until(() => tasks.get(t.id)!.state === 'done');
  assert.equal(tasks.get(t.id)!.state, 'done');
  assert.equal(seen[0].linked, true);
  assert.equal(seen[0].sameFile, true);
  assert.equal(seen[0].options.cwd, f.host.outputs);
  assert.equal(seen[0].options.resume, 'cli-host');
  assert.ok(seen[0].options.additionalDirectories.includes(f.folder));
  assert.deepEqual(seen[1], { inside: 'allow', proj: 'allow' });
  assert.equal(existsSync(linkPath), false);                                  // הקישור הוסר
  assert.match(readFileSync(f.host.transcript!, 'utf8'), /מהטלפון/);           // ההודעה בתמליל של Desktop
  assert.equal(store.getConversation('cli-host'), null);                      // לא הפכה לשיחה "שלנו"
  // מיד אחרי הריצה שלנו: לא נחשבת פתוחה ב-Desktop, ואפשר להמשיך שוב
  assert.equal(idx.get('cli-host')!.canContinue, true);
  const t2 = run('ועוד משהו');
  await until(() => tasks.get(t2.id)!.state === 'done');
  assert.equal(tasks.get(t2.id)!.state, 'done');
});

test('המשך שיחת Cowork שפתוחה ב-Desktop נכשל בהודעה ברורה', async () => {
  const f = fixture();
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const cw = new CoworkHistory(f.coworkRoot, f.claudeProjects);
  const idx = new ConversationIndex(store, new ClaudeHistory(f.claudeProjects), { resumeSources: ['cowork'], activeMinutes: 3 }, cw);
  const p = store.addProject({ name: 'מאירוביץ', path: f.folder });
  let called = false;
  const query = () => (async function* () { called = true; })();
  const broker = new PermissionBroker({ store, tasks, minutes: 10, onEvent: () => {} });
  const worker = new Worker({ store, tasks, query: query as any, maxTurns: 5, permissionMinutes: 10, broker, coworkRun: (id) => idx.coworkRun(id) });
  appendFileSync(f.host.transcript!, '\n');   // Desktop כתב עכשיו
  const t = tasks.create({ projectId: p.id, source: 'phone', prompt: 'x', conversationId: 'cli-host' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x');
  worker.kick();
  for (let i = 0; i < 100 && tasks.get(t.id)!.state === 'queued'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(tasks.get(t.id)!.state, 'failed');
  assert.match(tasks.get(t.id)!.error!, /פתוחה כרגע ב-Desktop/);
  assert.equal(called, false);
  assert.equal(store.conversationLockedBy('cli-host'), null);
});
