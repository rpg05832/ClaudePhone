// בדיקת תאימות: המשך שיחה שנפתחה ב-Claude Desktop, דרך ה-Agent SDK (כמו שהסוכן עושה מהטלפון).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeHistory, samePath, parseSessionMeta } from '../src/history/claude-history.ts';
import { homedir } from 'node:os';
const projectPath = join(homedir(), 'Desktop', 'ClaudeProjects', 'בדיקה טלפונית');
const h = new ClaudeHistory();
const cands = h.list().filter(s => s.source === 'desktop' && samePath(s.cwd, projectPath));
const out: any = { found: cands.map(c => ({ id: c.id, title: c.title, last: c.lastActiveAt, n: c.messageCount })) };
const s = cands[0];
if (!s) { writeFileSync('data/desktop-resume.json', JSON.stringify(out, null, 1)); process.exit(0); }
out.before = { lines: h.messages(s.id).length };
let sid: string | null = null, text = '', err = '';
try {
  for await (const m of query({ prompt: 'מה המילה שביקשתי ממך לזכור? ענה במילה אחת בלבד.', options: {
    cwd: projectPath, resume: s.id, permissionMode: 'default', maxTurns: 2, strictMcpConfig: true, mcpServers: {}, settingSources: ['project', 'local'],
    canUseTool: async () => ({ behavior: 'deny', message: 'no tools in this test' }) } }) as any) {
    if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
    if (m.type === 'result') text = String(m.result ?? m.subtype);
  }
} catch (e: any) { err = e.message; }
const after = parseSessionMeta(s.file, s.id, Date.now());
out.result = { resumedSessionId: sid, sameSession: sid === s.id, answer: text, error: err, afterMessages: h.messages(s.id).length, entrypointAfter: after?.entrypoint, titleAfter: after?.title };
writeFileSync('data/desktop-resume.json', JSON.stringify(out, null, 1));
