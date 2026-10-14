// בדיקה (באישור המשתמש, על שיחה שהוא בחר): המשך שיחת Cowork מקומית באותה שיחה.
// התמליל המקורי מקבל קישור קשיח (hard link) בתוך ~/.claude/projects, כך ש-Claude Code כותב ישירות לקובץ של Desktop.
// לפני כן נשמר גיבוי של התמליל ב-agent/data/backup. בסוף מסירים רק את הקישור (הקובץ המקורי נשאר).
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, unlinkSync, linkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';

const TITLE = 'כעחחיעל';
const root = join(process.env.APPDATA!, 'Claude', 'local-agent-mode-sessions');
let hit: { j: any; t: string; d: string } | null = null;
for (const a of readdirSync(root).map(x => join(root, x)).filter(x => statSync(x).isDirectory()))
  for (const o of readdirSync(a).map(x => join(a, x)).filter(x => statSync(x).isDirectory()))
    for (const f of readdirSync(o).filter(f => /^local_.*\.json$/.test(f))) {
      const j = JSON.parse(readFileSync(join(o, f), 'utf8'));
      if (j.title !== TITLE) continue;
      const projDir = join(o, f.replace('.json', ''), '.claude', 'projects');
      for (const d of existsSync(projDir) ? readdirSync(projDir) : []) {
        const t = join(projDir, d, j.cliSessionId + '.jsonl');
        if (existsSync(t)) hit = { j, t, d };
      }
    }
if (!hit) { console.log('השיחה לא נמצאה'); process.exit(1); }
const age = (Date.now() - statSync(hit.t).mtimeMs) / 60000;
if (age < 3) { console.log('השיחה פעילה כרגע ב-Desktop; לא ממשיכים'); process.exit(1); }

const backupDir = join(process.cwd(), 'data', 'backup'); mkdirSync(backupDir, { recursive: true });
const backup = join(backupDir, `cowork-${hit.j.cliSessionId}-${Date.now()}.jsonl`);
copyFileSync(hit.t, backup);
const before = statSync(hit.t).size;
console.log('גיבוי נשמר. גודל לפני:', before);

const destDir = join(homedir(), '.claude', 'projects', hit.d);
const madeDir = !existsSync(destDir);
mkdirSync(destDir, { recursive: true });
const link = join(destDir, hit.j.cliSessionId + '.jsonl');
if (existsSync(link)) { console.log('כבר קיים קובץ בשם הזה ב-~/.claude/projects; עוצר'); process.exit(1); }
linkSync(hit.t, link);
let sid = '';
try {
  const q = query({ prompt: 'זו בדיקה מהטלפון (ClaudePhone). בלי כלים, ענה רק: "בדיקת טלפון הצליחה", ואחריה במילים ספורות על מה הייתה השיחה.', options: {
    resume: hit.j.cliSessionId, cwd: hit.j.cwd, maxTurns: 1,
    disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
    settingSources: [], strictMcpConfig: true, mcpServers: {},
  } as any });
  for await (const m of q as any) {
    if (m.type === 'system' && m.subtype === 'init') sid = m.session_id;
    if (m.type === 'result') console.log('תשובה:', String(m.result ?? '').slice(0, 120));
  }
} finally {
  unlinkSync(link);
  if (madeDir) { try { rmdirSync(destDir); } catch { /* */ } }
}
console.log('אותו מזהה שיחה:', sid === hit.j.cliSessionId, '| גודל אחרי:', statSync(hit.t).size, '| נוסף:', statSync(hit.t).size - before);
