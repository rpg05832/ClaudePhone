// בדיקת תאימות: המשך מהטלפון (Agent SDK) של שיחה שנפתחה ב-Claude Code בטרמינל, ושל שיחה בסגנון VS Code.
// יוצר שיחות בדיקה חדשות בתיקיית בדיקה בלבד (לא נוגע בשיחות אמיתיות). מודל haiku כדי לחסוך.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeHistory, samePath } from '../src/history/claude-history.ts';

const dir = resolve('data', 'cli-resume-test');
mkdirSync(dir, { recursive: true });
const h = new ClaudeHistory();
const out: any = {};

function cliSession(entry: string | null, word: string) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (entry) env.CLAUDE_CODE_ENTRYPOINT = entry;
  const raw = execFileSync('cmd.exe', ['/c', 'claude', '-p', `זכור את המילה ${word}. ענה רק: בסדר`, '--model', 'haiku', '--output-format', 'json'], { cwd: dir, env, encoding: 'utf8', timeout: 180_000 });
  const j = JSON.parse(raw.trim().split('\n').pop()!);
  return j.session_id as string;
}

async function resume(id: string) {
  let sid: string | null = null, text = '', err = '';
  try {
    for await (const m of query({ prompt: 'מה המילה שביקשתי ממך לזכור? ענה במילה אחת בלבד.', options: {
      cwd: dir, resume: id, model: 'haiku', permissionMode: 'default', maxTurns: 2, strictMcpConfig: true, mcpServers: {}, settingSources: ['project', 'local'],
      canUseTool: async () => ({ behavior: 'deny', message: 'no tools in this test' }) } }) as any) {
      if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
      if (m.type === 'result') text = String(m.result ?? m.subtype);
    }
  } catch (e: any) { err = e.message; }
  return { sameSession: sid === id, answer: text, error: err };
}

for (const [label, entry, word] of [['cli', null, 'תפוז'], ['vscode', 'claude-vscode', 'אגס']] as const) {
  try {
    const id = cliSession(entry, word);
    const meta = h.list().find(s => s.id === id);
    out[label] = { id, entrypoint: meta?.entrypoint, source: meta?.source, cwdMatches: samePath(meta?.cwd, dir), ...(await resume(id)), expected: word };
  } catch (e: any) { out[label] = { error: e.message }; }
}
writeFileSync('data/cli-resume.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
