import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverSlug, serversFromInit, parseMcpTool, isReadOnlyMcpTool, speakableMcp, discoverMcp } from '../src/claude/mcp.ts';
import { decide } from '../src/claude/policy.ts';
import { runClaude } from '../src/claude/runner.ts';

const PERMS = { editInsideProject: true, runCommands: false };

test('slug של שרת כמו בשמות הכלים של Claude Code', () => {
  assert.equal(serverSlug('claude.ai Gmail'), 'claude_ai_Gmail');
  assert.equal(serverSlug('claude.ai Google Calendar'), 'claude_ai_Google_Calendar');
  assert.equal(serverSlug('claude.ai גיטהאב (2)'), 'claude_ai_2');
  assert.equal(serverSlug('desktop-commander'), 'desktop-commander');
  assert.equal(serverSlug('plugin:firebase:firebase'), 'plugin_firebase_firebase');
  assert.deepEqual(parseMcpTool('mcp__claude_ai_Gmail__send_message'), { slug: 'claude_ai_Gmail', tool: 'send_message' });
  assert.equal(parseMcpTool('Bash'), null);
});

test('רשימת השרתים מהודעת init: מקור, מצב וכלים לכל שרת', () => {
  const servers = serversFromInit({
    mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }, { name: 'desktop-commander', status: 'pending' }, { name: 'plugin:firebase:firebase', status: 'failed' }],
    tools: ['Bash', 'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__send_message', 'mcp__desktop-commander__start_process'],
  });
  assert.deepEqual(servers.map(s => [s.slug, s.source, s.status, s.tools.length]), [
    ['claude_ai_Gmail', 'claude.ai', 'connected', 2], ['desktop-commander', 'local', 'pending', 1], ['plugin_firebase_firebase', 'plugin', 'failed', 0],
  ]);
});

test('מדיניות: שרת שלא נפתח נדחה (גם באישור אוטומטי); שרת פתוח: קריאה לבד, שינוי לפי מצב העבודה', () => {
  const mcp = { enabled: ['claude_ai_Gmail'], labels: { claude_ai_Gmail: 'Gmail' } };
  const send = { to: 'a@b.com', subject: 'שלום' };
  // בלי חיבורים בכלל: הכל נדחה
  assert.equal(decide('mcp__claude_ai_Gmail__search_threads', {}, '/p', PERMS, 'edit').action, 'deny');
  assert.equal(decide('mcp__claude_ai_Gmail__search_threads', {}, '/p', PERMS, 'auto').action, 'deny');
  // שרת שלא נבחר נדחה גם באישור אוטומטי
  assert.equal(decide('mcp__desktop-commander__start_process', {}, '/p', PERMS, 'auto', mcp).action, 'deny');
  // שרת שנבחר
  assert.equal(decide('mcp__claude_ai_Gmail__search_threads', {}, '/p', PERMS, 'edit', mcp).action, 'allow');
  assert.equal(decide('mcp__claude_ai_Gmail__search_threads', {}, '/p', PERMS, 'readonly', mcp).action, 'allow');
  const ask = decide('mcp__claude_ai_Gmail__send_message', send, '/p', PERMS, 'edit', mcp);
  assert.equal(ask.action, 'ask');
  assert.equal(ask.summary, 'Gmail: לשלוח מייל אל a@b.com בנושא שלום');
  assert.equal(decide('mcp__claude_ai_Gmail__send_message', send, '/p', PERMS, 'readonly', mcp).action, 'deny');
  assert.equal(decide('mcp__claude_ai_Gmail__send_message', send, '/p', PERMS, 'auto', mcp).action, 'allow');
  // כלים רגילים לא מושפעים
  assert.equal(decide('Bash', { command: 'ls' }, '/p', PERMS, 'edit', mcp).action, 'ask');
});

test('כלי קריאה לפי שם, ותיאורים להקראה', () => {
  for (const t of ['search_threads', 'get_message', 'list_labels', 'read_file_content', 'find_definition']) assert.equal(isReadOnlyMcpTool(t), true, t);
  for (const t of ['send_message', 'create_draft', 'trash_message', 'reply', 'delete_event', 'start_process', 'export_design']) assert.equal(isReadOnlyMcpTool(t), false, t);
  assert.equal(speakableMcp('claude_ai_Gmail', 'reply', { body: 'תודה רבה' }, 'Gmail'), 'Gmail: להשיב למייל: תודה רבה');
  assert.equal(speakableMcp('claude_ai_Google_Calendar', 'create_event', { summary: 'פגישה', start: '2026-10-20T10:00' }, 'Google Calendar'), 'Google Calendar: ליצור אירוע פגישה ב-2026-10-20T10:00');
  assert.equal(speakableMcp('desktop-commander', 'start_process', { command: 'dir' }), 'desktop-commander: start process (dir)');
});

test('גילוי: נעצר אחרי הודעת init ומחזיר את השרתים', async () => {
  let aborted = false;
  const query = async function* (args: any) {
    assert.equal(args.options.strictMcpConfig, false);
    args.options.abortController.signal.addEventListener('abort', () => { aborted = true; });
    yield { type: 'system', subtype: 'init', claude_code_version: '2.1.296', mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }], tools: ['mcp__claude_ai_Gmail__send_message'] };
    yield { type: 'assistant' };
    yield { type: 'result', subtype: 'success', result: 'x' };
  };
  const scan = await discoverMcp(query as any, '/tmp');
  assert.equal(aborted, true);
  assert.equal(scan.claudeCodeVersion, '2.1.296');
  assert.deepEqual(scan.servers.map(s => s.slug), ['claude_ai_Gmail']);
});

test('הרצה: בלי חיבורים מצב מחמיר; עם חיבורים לא-מחמיר, כלים של שרתים אחרים מוסתרים, וההנחיה מזכירה את החיבור', async () => {
  const seen: any[] = [];
  const query = async function* (args: any) { seen.push(args.options); yield { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, session_id: 's1' }; };
  const base = { project: { id: 'p', name: 'p', spokenName: 'p', path: '/p', phoneEnabled: true, permissions: PERMS, createdAt: '' } as any, prompt: 'x', resumeId: null, maxTurns: 5, editMode: 'edit' as const, abort: new AbortController(), onSession: () => {}, onPermission: () => {}, askUser: async () => ({ kind: 'allow' as const }) };
  await runClaude(query as any, base);
  assert.equal(seen[0].strictMcpConfig, true);
  assert.equal(seen[0].disallowedTools, undefined);
  await runClaude(query as any, { ...base, mcp: { enabled: ['claude_ai_Gmail'], labels: { claude_ai_Gmail: 'Gmail' }, known: ['claude_ai_Gmail', 'desktop-commander', 'claude_ai_Canva'] } });
  assert.equal(seen[1].strictMcpConfig, false);
  assert.deepEqual(seen[1].disallowedTools, ['mcp__desktop-commander', 'mcp__claude_ai_Canva']);
  assert.match(seen[1].systemPrompt.append, /זמינים לך ככלי MCP.*Gmail/);
});
