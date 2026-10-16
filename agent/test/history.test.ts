import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeHistory, samePath } from '../src/history/claude-history.ts';
import { ConversationIndex } from '../src/history/conversations.ts';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { PhoneFlow } from '../src/phone/flow.ts';
import { hashPin, PinLockout } from '../src/util/pin.ts';

function writeSession(root: string, dir: string, id: string, lines: any[], ageMinutes = 60) {
  mkdirSync(join(root, dir), { recursive: true });
  const f = join(root, dir, id + '.jsonl');
  writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(f, t, t);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cph-'));
  const projDir = mkdtempSync(join(tmpdir(), 'proj-'));
  const base = { cwd: projDir, entrypoint: 'claude-desktop', version: '2.1.296' };
  writeSession(root, 'C--x', 'desk-1', [
    { type: 'user', ...base, timestamp: '2026-10-10T10:00:00Z', message: { content: '<local-command-caveat>x</local-command-caveat>' } },
    { type: 'user', ...base, timestamp: '2026-10-10T10:00:01Z', message: { content: 'תסדר את דף הבית' } },
    { type: 'assistant', ...base, timestamp: '2026-10-10T10:00:05Z', message: { content: [{ type: 'text', text: 'סידרתי' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }] } },
    { type: 'custom-title', customTitle: 'דף הבית החדש', sessionId: 'desk-1' },
  ]);
  writeSession(root, 'C--x', 'cli-1', [
    { type: 'user', cwd: projDir, entrypoint: 'cli', timestamp: '2026-10-11T10:00:00Z', message: { content: 'בדיקה מהטרמינל' } },
  ], 1);   // נכתבה לפני דקה: פעילה
  writeSession(root, 'C--y', 'other', [
    { type: 'user', cwd: 'C:\\somewhere-else', entrypoint: 'claude-desktop', timestamp: '2026-10-12T10:00:00Z', message: { content: 'שיחה אחרת' } },
  ]);
  writeFileSync(join(root, 'C--x', 'broken.jsonl'), '{"type":"user", bad json\n');
  return { root, projDir };
}

test('היסטוריה: כותרת, מקור, הודעות, ושורות פגומות לא מפילות', () => {
  const { root } = fixture();
  const h = new ClaudeHistory(root);
  const all = h.list();
  assert.deepEqual(all.map(s => s.id).sort(), ['cli-1', 'desk-1', 'other']);
  const d = h.get('desk-1')!;
  assert.equal(d.title, 'דף הבית החדש');
  assert.equal(d.source, 'desktop');
  assert.equal(d.version, '2.1.296');
  const msgs = h.messages('desk-1');
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(msgs[2].tool!.input, 'npm run build');
  assert.equal(h.get('cli-1')!.title, 'בדיקה מהטרמינל');
});

test('אינדקס שיחות: שיוך לפרויקט לפי תיקייה, ושיחות Desktop חסומות להמשך עד שיאומתו', () => {
  const { root, projDir } = fixture();
  const store = new Store(':memory:');
  const p = store.addProject({ name: 'אתר', path: projDir });
  const idx = new ConversationIndex(store, new ClaudeHistory(root), { resumeSources: ['sdk'], activeMinutes: 3 });
  const phone = idx.forPhone();
  assert.deepEqual(phone.map(c => c.id).sort(), ['cli-1', 'desk-1']);   // "other" לא שייכת לפרויקט מורשה
  const d = phone.find(c => c.id === 'desk-1')!;
  assert.equal(d.projectId, p.id);
  assert.equal(d.canContinue, false);
  assert.equal(d.blockedReason, 'המשך שיחות מהמקור הזה כבוי בהגדרות');
  const idx2 = new ConversationIndex(store, new ClaudeHistory(root), { resumeSources: ['sdk', 'desktop', 'cli'], activeMinutes: 3 });
  assert.equal(idx2.get('desk-1')!.canContinue, true);
  const cli = idx2.get('cli-1')!;
  assert.equal(cli.active, true);
  assert.equal(cli.canContinue, false);
  assert.equal(cli.blockedReason, 'השיחה פתוחה כרגע במחשב');
});

test('נתיבים: השוואה בלי תלות באותיות ובלוכסן בסוף', () => {
  assert.equal(samePath('/tmp/A/b/', '/tmp/a/B'), true);
  assert.equal(samePath('/tmp/a', '/tmp/ab'), false);
});

test('טלפון: מקש 2 מציג שיחת Desktop, וחוסם המשך עם הסבר', async () => {
  const { root, projDir } = fixture();
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  store.addProject({ name: 'אתר', path: projDir });
  const idx = new ConversationIndex(store, new ClaudeHistory(root), { resumeSources: ['sdk'], activeMinutes: 3 });
  const pin = hashPin('4321');
  const flow = new PhoneFlow({
    store, tasks, allowedPhones: () => ['050'], pinHash: () => pin, lockout: new PinLockout(5, 15),
    limits: { recordSeconds: 120, transcriptConfirmSeconds: 60, queuedTaskHours: 24, waitOnCallMinutes: 5 },
    transcribeRecording: async () => '', createProject: async () => { throw new Error('x'); }, kickWorker: () => {}, requestStop: () => {},
    applyVoice: async () => {}, decide: () => 'missing', transcribeAudio: async () => '', conversations: () => idx.forPhone(), sleep: async () => {},
  });
  const vals: Record<string, string> = {}; let last = '';
  const send = async (v?: string) => {
    if (v !== undefined && last) vals[last] = v;
    const b = await flow.handle({ ApiCallId: 'C1', ApiPhone: '050', ApiExtension: '9', ...vals });
    const m = [...b.matchAll(/=(v\d+),/g)].pop(); if (m) last = m[1];
    return b;
  };
  await send(); await send('4321');
  const list = await send('2');
  assert.match(list, /דף הבית החדש מדסקטופ/);
  assert.match(list, /לא זמינה להמשך/);
  const idxOf = idx.forPhone().findIndex(c => c.id === 'desk-1') + 2;   // מקש 1 = שיחה חדשה
  assert.match(await send(String(idxOf)), /המשך שיחות מהמקור הזה כבוי בהגדרות/);
});

test('טלפון: מקש 8 מקריא גם שיחות מחוץ לפרויקטים, וממשיך אותן בתיקייה שלהן (רישום אוטומטי)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cph8-'));
  const projDir = mkdtempSync(join(tmpdir(), 'proj8-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside8-'));
  writeSession(root, 'C--a', 'in-proj', [{ type: 'user', cwd: projDir, entrypoint: 'cli', timestamp: '2026-10-10T10:00:00Z', message: { content: 'שיחה בפרויקט' } }]);
  writeSession(root, 'C--b', 'out-1', [{ type: 'user', cwd: outside, entrypoint: 'claude-vscode', timestamp: '2026-10-12T10:00:00Z', message: { content: 'שיחה מחוץ לפרויקטים' } }]);
  writeSession(root, 'C--c', 'gone-1', [{ type: 'user', cwd: join(outside, 'deleted'), entrypoint: 'cli', timestamp: '2026-10-11T10:00:00Z', message: { content: 'תיקייה שנמחקה' } }]);
  const store = new Store(':memory:'); const tasks = new Tasks(store);
  const p = store.addProject({ name: 'אתר', path: projDir });
  const off = store.addProject({ name: 'כבוי', path: mkdtempSync(join(tmpdir(), 'off8-')) });
  store.updateProject(off.id, { phoneEnabled: false });
  writeSession(root, 'C--d', 'off-1', [{ type: 'user', cwd: off.path, entrypoint: 'cli', timestamp: '2026-10-13T10:00:00Z', message: { content: 'פרויקט כבוי' } }]);
  const idx = new ConversationIndex(store, new ClaudeHistory(root), { resumeSources: ['sdk', 'cli', 'vscode'], activeMinutes: 3 });
  // הרשימה המלאה: בלי שיחות של פרויקט כבוי; שיחה מחוץ לפרויקטים ניתנת להמשך עם תיקייה
  const all = idx.allForPhone();
  assert.deepEqual(all.map(c => c.id).sort(), ['gone-1', 'in-proj', 'out-1']);
  const out = all.find(c => c.id === 'out-1')!;
  assert.equal(out.canContinue, true); assert.equal(out.autoFolder, outside); assert.equal(out.source, 'vscode');
  assert.equal(all.find(c => c.id === 'gone-1')!.canContinue, false);
  assert.equal(idx.forPhone().some(c => c.id === 'out-1'), false);
  const ensured: string[] = [];
  const pin = hashPin('4321');
  const flow = new PhoneFlow({
    store, tasks, allowedPhones: () => ['050'], pinHash: () => pin, lockout: new PinLockout(5, 15),
    limits: { recordSeconds: 120, transcriptConfirmSeconds: 60, queuedTaskHours: 24, waitOnCallMinutes: 5 },
    transcribeRecording: async () => '', createProject: async () => { throw new Error('x'); }, kickWorker: () => {}, requestStop: () => {},
    applyVoice: async () => {}, decide: () => 'missing', transcribeAudio: async () => '', conversations: () => idx.forPhone(), sleep: async () => {},
    allConversations: () => idx.allForPhone(),
    ensureProject: (folder) => { ensured.push(folder); return store.addProject({ name: 'חוץ', path: folder, listed: false }).id; },
  });
  const vals: Record<string, string> = {}; let last = '';
  const send = async (v?: string) => {
    if (v !== undefined && last) vals[last] = v;
    const b = await flow.handle({ ApiCallId: 'C8', ApiPhone: '050', ApiExtension: '9', ...vals });
    const m = [...b.matchAll(/=(v\d+),/g)].pop(); if (m) last = m[1];
    return b;
  };
  await send();
  assert.match(await send('4321'), /לכל השיחות במחשב 8/);
  const list = await send('8');
  assert.match(list, /שיחה מחוץ לפרויקטים מויזואל סטודיו/);
  const pos = idx.allForPhone().findIndex(c => c.id === 'out-1') + 2;   // מקש 1 = שיחה חדשה
  assert.match(await send(String(pos)), /record/);
  assert.deepEqual(ensured, [outside]);
  // התיקייה נרשמה, אבל לא מופיעה ברשימת הפרויקטים במקש 3
  assert.equal(store.listMenuProjects().some(x => x.path === outside), false);
  assert.equal(store.listMenuProjects().some(x => x.id === p.id), true);
  assert.equal(idx.forPhone().some(c => c.id === 'out-1'), true);
});
