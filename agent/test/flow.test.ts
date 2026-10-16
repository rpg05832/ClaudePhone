import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { PhoneFlow, type FlowDeps } from '../src/phone/flow.ts';
import type { Store as StoreT } from '../src/store/db.ts';
import { hashPin, PinLockout } from '../src/util/pin.ts';

const PHONE = '0500000000';
const PIN = '4321';

function setup(over: Partial<FlowDeps> = {}) {
  const store = new Store(':memory:');
  const tasks = new Tasks(store);
  const proj = store.addProject({ name: 'אתר', spokenName: 'אתר', path: '/tmp/site' });
  const kicks: number[] = [];
  const voiceCalls: [string, number][] = [];
  const decisions: [string, any][] = [];
  const pinHash = hashPin(PIN);
  const flow = new PhoneFlow({
    store, tasks,
    allowedPhones: () => [PHONE],
    pinHash: () => pinHash,
    lockout: new PinLockout(5, 15),
    limits: { recordSeconds: 120, transcriptConfirmSeconds: 60, queuedTaskHours: 24, waitOnCallMinutes: 5 },
    transcribeRecording: async () => 'תוסיף כפתור יצירת קשר',
    createProject: async (name) => store.addProject({ name, path: '/tmp/new/' + name }),
    kickWorker: () => kicks.push(1),
    requestStop: () => {},
    applyVoice: async (v, r) => { voiceCalls.push([v, r]); },
    decide: (id, d, via) => {
      decisions.push([id, d]);
      const text = d.decision === 'answer' ? JSON.stringify(d.answers) : d.decision === 'deny' ? (d.explanation ?? null) : null;
      return store.decidePermission(id, d.decision, via, text);
    },
    transcribeAudio: async () => 'תשתמש ב-pnpm במקום',
    sleep: async () => {},
    ...over,
  });
  return { store, tasks, flow, proj, kicks, voiceCalls, decisions };
}

/** מדמה את ימות: שומר את כל הערכים שנקלטו ושולח אותם בכל בקשה. */
function call(flow: PhoneFlow, callId = 'CALL1', phone = PHONE) {
  const vals: Record<string, string> = {};
  let lastVar = '';
  const send = async (value?: string) => {
    if (value !== undefined && lastVar) vals[lastVar] = value;
    const body = await flow.handle({ ApiCallId: callId, ApiPhone: phone, ApiExtension: '9', ...vals });
    const m = [...body.matchAll(/=(v\d+),/g)].pop();
    if (m) lastVar = m[1];
    return body;
  };
  return { send, hangup: () => flow.handle({ ApiCallId: callId, ApiPhone: phone, hangup: 'yes' }), vals };
}

test('מספר לא מורשה מנותק בלי ליצור משימה', async () => {
  const { flow, tasks } = setup();
  const body = await call(flow, 'X', '0599999999').send();
  assert.match(body, /hangup/);
  assert.equal(tasks.recent().length, 0);
});

test('PIN שגוי לא נותן כניסה, ואחרי 5 ניסיונות יש חסימה', async () => {
  const { flow } = setup();
  const c = call(flow);
  await c.send();
  for (let i = 0; i < 4; i++) assert.match(await c.send('1111' + i), /שגוי/);
  assert.match(await c.send('11115'), /נחסמה/);
  assert.match(await call(flow, 'CALL2').send(), /נחסמה/);
});

test('שיחה חדשה מקצה לקצה: PIN, פרויקט, הקלטה, תמלול, אישור -> משימה אחת בתור', async () => {
  const { flow, tasks, kicks } = setup();
  const c = call(flow);
  assert.match(await c.send(), /הקוד האישי/);
  assert.match(await c.send(PIN), /להמשך שיחה 2/);
  assert.match(await c.send('3'), /לפרויקט חדש הקש 1.*לאתר הקש 2/);
  assert.match(await c.send('2'), /record,\/9,cp-/);
  assert.match(await c.send('/9/x.wav'), /go_to_folder=\/9/);
  const confirm = await c.send();
  assert.match(confirm, /תוסיף כפתור יצירת קשר/);
  assert.match(confirm, /שיחה חדשה בפרויקט אתר/);
  const sent = await c.send('1');
  assert.match(sent, /משימה 1.*go_to_folder=\/9/);
  const t = tasks.getByNum(1)!;
  assert.equal(t.state, 'queued');
  assert.equal(t.prompt, 'תוסיף כפתור יצירת קשר');
  assert.equal(kicks.length, 1);
  // אירוע כפול (ימות שלחה שוב את אותה הקשה): אותה תשובה, ואין משימה נוספת
  const again = await flow.handle({ ApiCallId: 'CALL1', ApiPhone: PHONE, ApiExtension: '9', ...c.vals });
  assert.doesNotMatch(again, /משימה 2/);
  assert.equal(tasks.recent().length, 1);
  assert.equal(kicks.length, 1);
});

test('ניתוק לפני אישור התמלול מבטל את הטיוטה', async () => {
  const { flow, tasks } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('3'); await c.send('2'); await c.send('/9/x.wav'); await c.send();
  await c.hangup();
  const t = tasks.getByNum(1)!;
  assert.equal(t.state, 'cancelled');
});

test('הקלטה מחדש (2) לא יוצרת משימה נוספת; ביטול (3) מבטל', async () => {
  const { flow, tasks } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('3'); await c.send('2'); await c.send('/9/x.wav'); await c.send();
  assert.match(await c.send('2'), /record/);
  await c.send('/9/y.wav');
  assert.match(await c.send(), /לשליחה הקש 1/);
  assert.match(await c.send('3'), /בוטל/);
  assert.equal(tasks.recent().length, 1);
  assert.equal(tasks.getByNum(1)!.state, 'cancelled');
});

test('תמלול ריק מבקש הקלטה מחדש בלי ביצוע', async () => {
  const { flow, tasks } = setup({ transcribeRecording: async () => '' });
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('3'); await c.send('2'); await c.send('/9/x.wav');
  assert.match(await c.send(), /לא זוהה דיבור.*record/);
  assert.equal(tasks.listActive().length, 0);
});

test('פרויקט חדש מהטלפון: הקלדה, אישור, ואז הקלטה בפרויקט החדש', async () => {
  const { flow, store } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('3');
  assert.match(await c.send('1'), /פרויקט חדש/);
  assert.match(await c.send('2'), /HebrewKeyboard/);
  // שם מוקלד נוצר מיד, בלי שאלת אישור
  assert.match(await c.send('חנות'), /הפרויקט חנות נוצר.*record/);
  assert.ok(store.listProjects().some(p => p.name === 'חנות'));
});

test('המשך שיחה ותוצאות: התוצאה נשמעת ומסומנת', async () => {
  const { flow, tasks, store, proj } = setup();
  store.upsertConversation({ id: 'sess-1', projectId: proj.id, title: 'כפתור יצירת קשר', source: 'phone' });
  const t = tasks.create({ projectId: proj.id, source: 'phone', conversationId: 'sess-1', prompt: 'x' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); tasks.transition(t.id, 'running', 'x');
  tasks.transition(t.id, 'done', 'x', undefined, { resultSummary: 'הוספתי את הכפתור' });
  const c = call(flow);
  await c.send();
  assert.match(await c.send(PIN), /תוצאה אחת חדשה/);
  assert.match(await c.send('4'), /הוספתי את הכפתור/);
  assert.match(await c.send('3'), /record/);   // המשך השיחה מתוך התוצאה
  assert.equal(tasks.get(t.id)!.heard, true);
  // תפריט 2 מציג את השיחה
  const c2 = call(flow, 'CALL9');
  await c2.send(); await c2.send(PIN);
  assert.match(await c2.send('2'), /כפתור יצירת קשר/);
});

test('ניתוק אחרי שהתוצאה הוקראה מסמן אותה כנשמעה', async () => {
  const { flow, tasks, proj } = setup();
  const t = tasks.create({ projectId: proj.id, source: 'phone', prompt: 'x' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); tasks.transition(t.id, 'running', 'x');
  tasks.transition(t.id, 'done', 'x', undefined, { resultSummary: 'בוצע' });
  const c = call(flow);
  await c.send(); await c.send(PIN);
  assert.match(await c.send('4'), /בוצע/);
  await c.hangup();
  assert.equal(tasks.get(t.id)!.heard, true);
});

test('שם פרויקט שנאמר בקול מוקרא לאישור', async () => {
  const { flow } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('3'); await c.send('1');
  assert.match(await c.send('1'), /voice/);
  assert.match(await c.send('בדיקה'), /שם הפרויקט: בדיקה.*לאישור/);
});

test('הגדרות: מעבר לקריאה בלבד וחזרה, והמצב מוקרא בכניסה', async () => {
  const { flow, store } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN);
  assert.match(await c.send('7'), /פקודות מגיעות אליך לאישור.*לשינוי מצב העבודה הקש 1/);
  assert.match(await c.send('1'), /לקריאה בלבד 1.*לאישור אוטומטי של כל הפעולות 3/);
  assert.match(await c.send('1'), /קריאה בלבד/);
  assert.equal(store.getSettings().editMode, 'readonly');
  const c2 = call(flow, 'CALL7');
  await c2.send();
  assert.match(await c2.send(PIN), /במצב קריאה בלבד/);
  assert.match(await c2.send('7'), /במצב קריאה בלבד/);
  await c2.send('1');
  assert.match(await c2.send('3'), /מאשר לעצמו את כל הפעולות/);
  assert.equal(store.getSettings().editMode, 'auto');
  const c3 = call(flow, 'CALL8');
  await c3.send();
  assert.match(await c3.send(PIN), /קלוד מאשר לעצמו את כל הפעולות/);
});

test('הגדרות: בחירת קול ומהירות מוחלת על השלוחה ונשמרת', async () => {
  const { flow, store, voiceCalls } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('7');
  assert.match(await c.send('2'), /קול נשי שני 5/);
  assert.match(await c.send('5'), /נבחר קול נשי שני/);
  assert.deepEqual(voiceCalls.at(-1), ['Sivan', 0]);
  await c.send('3');
  await c.send('3');
  assert.deepEqual(voiceCalls.at(-1), ['Sivan', 4]);
  assert.deepEqual(store.getSettings(), { editMode: 'edit', voice: 'Sivan', rate: 4, notify: 'on', model: 'default', effort: 'default', readback: 'full' });
});

function doneTask(tasks: Tasks, projId: string, resultText: string, resultSummary: string) {
  const t = tasks.create({ projectId: projId, source: 'phone', prompt: 'x' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); tasks.transition(t.id, 'running', 'x');
  return tasks.transition(t.id, 'done', 'x', undefined, { resultText, resultSummary });
}

test('תוצאה: ברירת המחדל מקריאה את התשובה המלאה בתוך read (ניתנת לקטיעה), מקש 4 עובר לסיכום', async () => {
  const { flow, tasks, proj } = setup();
  const long = 'הוספתי את הכפתור.\n---\n## פירוט\n- הקובץ `header.tsx` עודכן\n```js\nconsole.log(1)\n```\nהכל עובד. ' + 'מילה '.repeat(120);
  doneTask(tasks, proj.id, long, 'הוספתי את הכפתור');
  const c = call(flow);
  await c.send(); await c.send(PIN);
  const body = await c.send('4');
  // הכל בפקודת read אחת, בלי id_list_message, והטקסט המלא מפוצל למקטעי t-
  assert.doesNotMatch(body, /id_list_message/);
  assert.match(body, /^read=t-/);
  assert.match(body, /הכל עובד/);
  assert.match(body, /קוד מופיע בלוח הבקרה/);
  assert.doesNotMatch(body, /```|##/);
  assert.match(body, /לסיכום הקצר 4/);
  assert.match(body, /Ok,EMPTY/);
  const summary = await c.send('4');
  assert.match(summary, /הוספתי את הכפתור/);
  assert.doesNotMatch(summary, /הכל עובד/);
  assert.match(summary, /לתשובה המלאה 4/);
  // תום ההמתנה בלי הקשה: לתפריט, בלי להקריא הכל שוב
  assert.match(await c.send('EMPTY'), /לא התקבלה בחירה.*להמשך שיחה 2/);
});

test('הגדרות: מקש 7 קובע סיכום בלבד, וזה חל על ההקראה הבאה', async () => {
  const { flow, tasks, store, proj } = setup();
  doneTask(tasks, proj.id, 'סיכום קצר.\n---\nפירוט ארוך מאוד', 'סיכום קצר');
  const c = call(flow);
  await c.send(); await c.send(PIN);
  assert.match(await c.send('7'), /בסיום משימה מוקראת התשובה המלאה.*למה מוקרא בסיום משימה 7/);
  assert.match(await c.send('7'), /להקראת הסיכום הקצר בלבד 2/);
  assert.match(await c.send('2'), /מעכשיו בסיום משימה מוקרא הסיכום הקצר/);
  assert.equal(store.getSettings().readback, 'summary');
  await c.send('0');
  const body = await c.send('4');
  assert.match(body, /סיכום קצר/);
  assert.doesNotMatch(body, /פירוט ארוך/);
});

test('סולמית לבד ברשימה עוברת לעמוד הבא', async () => {
  const { flow, store } = setup();
  for (let i = 0; i < 12; i++) store.addProject({ name: 'פ' + i, path: '/tmp/p' + i });
  const c = call(flow);
  await c.send(); await c.send(PIN);
  // עמוד ראשון: פרויקט חדש במקש 1, ואז שמונה פרויקטים (אתר, פ0..פ6) במקשים 2 עד 9
  const first = await c.send('3');
  assert.match(first, /לפרויקט חדש הקש 1.*לאתר הקש 2.*לפ6 הקש 9.*לעמוד הבא הקש סולמית/);
  assert.doesNotMatch(first, /לפ7 הקש/);
  const second = await c.send('EMPTY');
  assert.match(second, /לפרויקט חדש הקש 1.*לפ7 הקש 2.*לפ11 הקש 6/);
  assert.match(await c.send('2'), /שיחה חדשה בפרויקט פ7/);
});

test('רשימת השיחות: מקש 1 פותח שיחה חדשה (רשימת הפרויקטים), השיחות ממקש 2', async () => {
  const { flow, store, proj } = setup();
  store.upsertConversation({ id: 'sess-a', projectId: proj.id, title: 'שיחה א', source: 'phone' });
  const c = call(flow);
  await c.send(); await c.send(PIN);
  const list = await c.send('2');
  assert.match(list, /^read=t-/);
  assert.match(list, /לשיחה חדשה הקש 1.*2 אתר שיחה א/);
  assert.match(await c.send('2'), /המשך השיחה שיחה א.*record/);
  const c2 = call(flow, 'CALL2');
  await c2.send(); await c2.send(PIN); await c2.send('2');
  assert.match(await c2.send('1'), /לפרויקט חדש הקש 1.*לאתר הקש 2/);
});

function pendingReq(store: StoreT, tasks: Tasks, projId: string, toolName: string, input: any, summary: string) {
  const t = tasks.create({ projectId: projId, source: 'phone', prompt: 'x' });
  tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x'); tasks.transition(t.id, 'running', 'x');
  return store.addPermissionRequest({ taskId: t.id, projectId: projId, toolName, input, summary,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), decision: null, decidedAt: null, decidedVia: null, explanation: null });
}

test('בקשת הרשאה מוצגת מיד בכניסה, ו-1 מאשר', async () => {
  const { flow, store, tasks, proj } = setup();
  const req = pendingReq(store, tasks, proj.id, 'Bash', { command: 'npm install' }, 'התקנת תלויות. הפקודה: npm install');
  const c = call(flow);
  await c.send();
  const shown = await c.send(PIN);
  assert.match(shown, /בקשה אחת שממתינה.*קלוד מבקש אישור: התקנת תלויות הפקודה: npm install.*לאישור 1/);
  assert.match(await c.send('1'), /אושר/);
  assert.equal(store.getPermissionRequest(req.id)!.decision, 'allow');
});

test('דחייה עם הסבר בהקלטה (8): ההסבר מתומלל, מוקרא, ונשלח עם הדחייה', async () => {
  const { flow, store, tasks, proj } = setup();
  const req = pendingReq(store, tasks, proj.id, 'Bash', { command: 'npm install' }, 'הפקודה: npm install');
  const c = call(flow);
  await c.send(); await c.send(PIN);
  assert.match(await c.send('8'), /record/);
  assert.match(await c.send('/9/x.wav'), /go_to_folder/);
  assert.match(await c.send(), /התמלול: תשתמש ב pnpm במקום/);
  assert.match(await c.send('1'), /נדחה וההסבר נשלח/);
  const r2 = store.getPermissionRequest(req.id)!;
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.explanation, 'תשתמש ב-pnpm במקום');
});

test('שאלה של Claude: בחירת אפשרות במקש שולחת תשובה', async () => {
  const { flow, store, tasks, proj } = setup();
  const q = { questions: [{ question: 'איזה צבע לכפתור?', header: 'צבע', multiSelect: false, options: [{ label: 'כחול', description: '' }, { label: 'ירוק', description: '' }] }] };
  const req = pendingReq(store, tasks, proj.id, 'AskUserQuestion', q, 'איזה צבע לכפתור?');
  const c = call(flow);
  await c.send();
  assert.match(await c.send(PIN), /קלוד שואל: איזה צבע לכפתור\?.*לכחול הקש 1 לירוק הקש 2.*בהקלדה 9/);
  assert.match(await c.send('2'), /התשובה נשלחה/);
  const r2 = store.getPermissionRequest(req.id)!;
  assert.equal(r2.decision, 'answer');
  assert.deepEqual(JSON.parse(r2.explanation!), { 'איזה צבע לכפתור?': 'ירוק' });
});

test('בקשה שכבר טופלה (למשל מהמחשב) לא מאושרת שוב', async () => {
  const { flow, store, tasks, proj } = setup();
  const req = pendingReq(store, tasks, proj.id, 'Bash', { command: 'ls' }, 'הפקודה: ls');
  const c = call(flow);
  await c.send(); await c.send(PIN);
  store.decidePermission(req.id, 'deny', 'dashboard');
  assert.match(await c.send('1'), /כבר טופלה/);
  assert.equal(store.getPermissionRequest(req.id)!.decision, 'deny');
});

test('בקשה שפג תוקפה לא מוצגת ולא מאושרת', async () => {
  const { flow, store, tasks, proj } = setup();
  const req = pendingReq(store, tasks, proj.id, 'Bash', { command: 'ls' }, 'הפקודה: ls');
  store.db.prepare('UPDATE permission_requests SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', req.id);
  const c = call(flow);
  await c.send();
  assert.doesNotMatch(await c.send(PIN), /מבקש אישור/);
  assert.equal(store.decidePermission(req.id, 'allow', 'phone'), 'expired');
});

test('הגדרות: כיבוי והפעלה של צינתוקים', async () => {
  const { flow, store } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('7');
  assert.match(await c.send('4'), /הצינתוקים כובו/);
  assert.equal(store.getSettings().notify, 'off');
});

test('מודל: לבקשה הזו (4 במסך האישור) ובהגדרות (7, 5)', async () => {
  const { flow, tasks, store, kicks } = setup();
  const c = call(flow);
  await c.send(); await c.send(PIN); await c.send('3'); await c.send('2'); await c.send('/9/x.wav');
  assert.match(await c.send(), /לשליחה עם מודל אחר 4/);
  assert.match(await c.send('4'), /להייקו 5/);
  assert.match(await c.send('5'), /נשלח עם הייקו/);
  assert.equal(tasks.getByNum(1)!.model, 'haiku');
  assert.equal(tasks.getByNum(1)!.state, 'queued');
  assert.equal(kicks.length, 1);
  const c2 = call(flow, 'CALL2');
  await c2.send(); await c2.send(PIN);
  assert.match(await c2.send('7'), /המודל: ברירת המחדל.*לבחירת מודל 5/);
  await c2.send('5');
  assert.match(await c2.send('2'), /נבחר פייבל/);
  assert.equal(store.getSettings().model, 'fable');
  await c2.send('6');
  assert.match(await c2.send('4'), /רמת החשיבה: גבוהה/);
  assert.equal(store.getSettings().effort, 'high');
});

test('מקש 9: הסבר על המערכת, נושא, וחזרה לתפריט', async () => {
  const { flow } = setup();
  const c = call(flow);
  await c.send();
  assert.match(await c.send(PIN), /להסבר על המערכת 9/);
  const menu = await c.send('9');
  assert.match(menu, /מה המערכת עושה הקש 1/);
  assert.match(menu, /הגדרות הקש 7/);
  const topic = await c.send('4');
  assert.match(topic, /שיחות קוורק שנשמרו בענן/);
  assert.match(topic, /לנושא אחר בחר מספר/);
  assert.match(await c.send('8'), /בחירה לא תקינה/);
  assert.match(await c.send('0'), /להמשך שיחה 2/);
});
