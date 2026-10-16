import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/claude/policy.ts';
import { runClaude } from '../src/claude/runner.ts';
import { chromePolicy, chromeAppend, parseBrowsers, listChromeBrowsers, speakableChrome } from '../src/claude/chrome.ts';

const PERMS = { editInsideProject: true, runCommands: false };
const T = (t: string) => `mcp__claude-in-chrome__${t}`;

test('Chrome: כבוי נדחה; פעיל: קריאה וניווט לבד, לחיצה והקלדה לפי מצב העבודה', () => {
  const off = { enabled: ['claude_ai_Gmail'] };
  assert.equal(decide(T('navigate'), { url: 'https://mail.google.com' }, '/p', PERMS, 'auto', off).action, 'deny');
  const on = { enabled: ['claude-in-chrome'], labels: { 'claude-in-chrome': 'הדפדפן Chrome' }, chrome: { browser: 'first' } };
  for (const t of ['tabs_context_mcp', 'list_connected_browsers', 'get_page_text', 'read_page', 'navigate', 'tabs_create_mcp'])
    assert.equal(decide(T(t), {}, '/p', PERMS, 'readonly', on).action, 'allow', t);
  assert.equal(decide(T('computer'), { action: 'screenshot' }, '/p', PERMS, 'readonly', on).action, 'allow');
  const type = decide(T('computer'), { action: 'type', text: 'שלום' }, '/p', PERMS, 'edit', on);
  assert.equal(type.action, 'ask');
  assert.equal(type.summary, 'דפדפן: להקליד "שלום"');
  assert.equal(decide(T('computer'), { action: 'left_click' }, '/p', PERMS, 'readonly', on).action, 'deny');
  assert.equal(decide(T('computer'), { action: 'left_click' }, '/p', PERMS, 'auto', on).action, 'allow');
  assert.equal(decide(T('form_input'), { value: 'x' }, '/p', PERMS, 'edit', on).action, 'ask');
  assert.equal(decide(T('javascript_tool'), {}, '/p', PERMS, 'edit', on).summary, 'דפדפן: להריץ קוד בדף');
  // רצף: כולו קריאה רץ לבד גם בקריאה בלבד; עם הקלדה: לפי מצב העבודה
  const readBatch = { actions: [{ tool: 'navigate', input: { url: 'https://example.com' } }, { tool: 'get_page_text', input: {} }] };
  assert.equal(decide(T('browser_batch'), readBatch, '/p', PERMS, 'readonly', on).action, 'allow');
  const typeBatch = { actions: [{ tool: 'navigate', input: { url: 'https://example.com' } }, { tool: 'computer', input: { action: 'type', text: 'x' } }] };
  const tb = decide(T('browser_batch'), typeBatch, '/p', PERMS, 'edit', on);
  assert.equal(tb.action, 'ask');
  assert.equal(tb.summary, 'דפדפן: רצף של 2 פעולות: לפתוח את example.com, להקליד "x"');
  assert.equal(decide(T('browser_batch'), typeBatch, '/p', PERMS, 'readonly', on).action, 'deny');
  assert.equal(decide(T('browser_batch'), typeBatch, '/p', PERMS, 'auto', on).action, 'allow');
});

test('Chrome: בחירת דפדפן לפי ההגדרה', () => {
  const pol = (browser: string) => ({ enabled: ['claude-in-chrome'], chrome: { browser, browserName: 'Browser 2' } });
  assert.equal(decide(T('select_browser'), { deviceId: 'a' }, '/p', PERMS, 'readonly', pol('first')).action, 'allow');
  assert.equal(decide(T('select_browser'), { deviceId: 'a' }, '/p', PERMS, 'edit', pol('ask')).action, 'allow');
  assert.equal(decide(T('select_browser'), { deviceId: 'b' }, '/p', PERMS, 'edit', pol('b')).action, 'allow');
  const wrong = decide(T('select_browser'), { deviceId: 'a' }, '/p', PERMS, 'auto', pol('b'));
  assert.equal(wrong.action, 'deny');
  assert.match(wrong.reason, /Browser 2/);
});

test('Chrome: הנחיה ושם הדפדפן לפי הבחירה', () => {
  const browsers = [{ deviceId: 'a', name: 'Browser 1' }, { deviceId: 'b', name: 'Browser 2' }];
  assert.deepEqual(chromePolicy({ enabled: true, browser: 'first', browsers, browsersAt: null }), { browser: 'first', browserName: 'Browser 1' });
  assert.deepEqual(chromePolicy({ enabled: true, browser: 'b', browsers, browsersAt: null }), { browser: 'b', browserName: 'Browser 2' });
  assert.match(chromeAppend({ browser: 'ask' }), /AskUserQuestion/);
  assert.match(chromeAppend({ browser: 'first' }), /הראשון ברשימה/);
  assert.match(chromeAppend({ browser: 'b', browserName: 'Browser 2' }), /"Browser 2" \(deviceId b\)/);
  assert.match(speakableChrome('navigate', { url: 'https://www.example.com/x?y' }), /example\.com$/);
});

test('Chrome: ההרצה מוסיפה --chrome רק כשהדפדפן פתוח', async () => {
  const seen: any[] = [];
  const query = async function* (args: any) { seen.push(args.options); yield { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, session_id: 's1' }; };
  const base = { project: { id: 'p', name: 'p', spokenName: 'p', path: '/p', phoneEnabled: true, permissions: PERMS, createdAt: '' } as any, prompt: 'x', resumeId: null, maxTurns: 5, editMode: 'edit' as const, abort: new AbortController(), onSession: () => {}, onPermission: () => {}, askUser: async () => ({ kind: 'allow' as const }) };
  await runClaude(query as any, base);
  assert.equal(seen[0].extraArgs, undefined);
  await runClaude(query as any, { ...base, mcp: { enabled: ['claude_ai_Gmail'] } });
  assert.deepEqual(seen[1].extraArgs, { 'no-chrome': null });
  assert.doesNotMatch(seen[1].systemPrompt.append, /claude-in-chrome/);
  await runClaude(query as any, { ...base, mcp: { enabled: ['claude-in-chrome'], labels: { 'claude-in-chrome': 'הדפדפן Chrome' }, chrome: { browser: 'ask' } } });
  assert.deepEqual(seen[2].extraArgs, { chrome: null });
  assert.equal(seen[2].strictMcpConfig, false);
  assert.match(seen[2].systemPrompt.append, /mcp__claude-in-chrome/);
});

test('Chrome: רשימת הדפדפנים נקראת מתשובת הכלי', async () => {
  const json = '[{"deviceId":"a","name":"Browser 1","osPlatform":"Windows","isLocal":true},{"deviceId":"b","name":"Browser 2"}]';
  assert.deepEqual(parseBrowsers([json, 'none selected']), [{ deviceId: 'a', name: 'Browser 1', osPlatform: 'Windows', isLocal: true }, { deviceId: 'b', name: 'Browser 2' }]);
  assert.equal(parseBrowsers(['no json here']), null);
  let opts: any;
  const query = async function* (args: any) {
    opts = args.options;
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__claude-in-chrome__list_connected_browsers', input: {} }] } };
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: json }] }] } };
    yield { type: 'result', subtype: 'success', result: 'OK', num_turns: 2 };
  };
  const list = await listChromeBrowsers(query as any, '/p');
  assert.equal(list.length, 2);
  assert.deepEqual(opts.extraArgs, { chrome: null });
  assert.equal((await opts.canUseTool('mcp__claude-in-chrome__navigate', {})).behavior, 'deny');
  assert.equal((await opts.canUseTool('mcp__claude-in-chrome__list_connected_browsers', {})).behavior, 'allow');
  const failing = async function* () { yield { type: 'result', subtype: 'success', result: 'OK', num_turns: 1 }; };
  await assert.rejects(listChromeBrowsers(failing as any, '/p'), /לא ענה/);
});
