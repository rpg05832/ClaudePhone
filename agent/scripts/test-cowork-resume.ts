// בדיקת היתכנות (באישור המשתמש): המשך שיחת Cowork מקומית דרך ה-SDK, בלי לגעת במקור.
// מעתיקים את התמליל של השיחה הקטנה ביותר לתיקיית ~/.claude/projects, ממשיכים עם forkSession (נוצר מזהה חדש),
// ובסוף מוחקים את ההעתק ואת הפיצול. מדפיסים רק אם ההקשר נשמר, לא את תוכן השיחה.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';

const root = join(process.env.APPDATA!, 'Claude', 'local-agent-mode-sessions');
let best: { j: any; t: string; d: string; size: number } | null = null;
for (const a of readdirSync(root).map(x => join(root, x)).filter(x => statSync(x).isDirectory())) {
  for (const o of readdirSync(a).map(x => join(a, x)).filter(x => statSync(x).isDirectory())) {
    for (const f of readdirSync(o).filter(f => /^local_.*\.json$/.test(f))) {
      const j = JSON.parse(readFileSync(join(o, f), 'utf8'));
      if (!j.hostLoopMode || j.isArchived || !/\\outputs$/.test(j.cwd ?? '')) continue;
      const projDir = join(o, f.replace('.json', ''), '.claude', 'projects');
      if (!existsSync(projDir)) continue;
      for (const d of readdirSync(projDir)) {
        const t = join(projDir, d, j.cliSessionId + '.jsonl');
        if (existsSync(t)) { const size = statSync(t).size; if (!best || size < best.size) best = { j, t, d, size }; }
      }
    }
  }
}
if (!best) { console.log('לא נמצאה שיחה מקומית מתאימה'); process.exit(1); }
const titleWords = String(best.j.title ?? '').split(/\s+/).filter(w => w.length > 2);
console.log('נבחרה שיחה בגודל', best.size, '| תיקיית העבודה קיימת:', existsSync(best.j.cwd));

const destDir = join(homedir(), '.claude', 'projects', best.d);
const madeDir = !existsSync(destDir);
mkdirSync(destDir, { recursive: true });
const copy = join(destDir, best.j.cliSessionId + '.jsonl');
const hadCopy = existsSync(copy);
if (!hadCopy) copyFileSync(best.t, copy);
let forkId = '';
let answer = '';
try {
  const q = query({ prompt: 'בלי להשתמש בכלים: מה הכותרת או הנושא של השיחה הזו, בשלוש מילים לכל היותר?', options: {
    resume: best.j.cliSessionId, forkSession: true, cwd: best.j.cwd, maxTurns: 1,
    disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
    settingSources: [], strictMcpConfig: true, mcpServers: {},
  } as any });
  for await (const m of q as any) {
    if (m.type === 'system' && m.subtype === 'init') forkId = m.session_id;
    if (m.type === 'result') { answer = String(m.result ?? ''); console.log('סיום:', m.subtype, '| טוקנים בקלט:', m.usage?.input_tokens, '+ מטמון', m.usage?.cache_read_input_tokens ?? 0, m.usage?.cache_creation_input_tokens ?? 0); }
  }
  const hit = titleWords.some(w => answer.includes(w));
  console.log('ההקשר נשמר:', hit, '| כותרת:', best.j.title, '| תשובה:', answer.slice(0, 80));
} finally {
  if (!hadCopy && existsSync(copy)) unlinkSync(copy);
  if (forkId) { const f = join(destDir, forkId + '.jsonl'); if (existsSync(f)) unlinkSync(f); }
  if (madeDir) { try { rmdirSync(destDir); } catch { /* נשארו קבצים נוספים */ } }
  console.log('ניקוי בוצע. המקור לא השתנה:', statSync(best.t).size === best.size, '| fork:', forkId ? 'נוצר ונמחק' : 'לא נוצר');
}
