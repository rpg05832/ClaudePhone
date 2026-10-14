// בדיקת עשן לשלב 2 מול Claude אמיתי: בקשת הרשאה לפקודה (מאושרת אוטומטית כאן) ושאלה (נענית אוטומטית).
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { Worker } from '../src/claude/worker.ts';
import { PermissionBroker } from '../src/claude/broker.ts';

const dir = mkdtempSync(join(tmpdir(), 'cp-smoke2-'));
const store = new Store(':memory:'); const tasks = new Tasks(store);
const p = store.addProject({ name: 'smoke2', path: dir });
const broker: PermissionBroker = new PermissionBroker({ store, tasks, minutes: 2, onEvent: (kind, id) => {
  const r = store.getPermissionRequest(id)!;
  console.log('EVENT', kind, '|', r.toolName, '|', r.summary);
  setTimeout(() => {
    if (kind === 'question') {
      const q = (r.input.questions as any[])[0];
      console.log('  options:', q.options.map((o: any) => o.label).join(' / '));
      console.log('  decide:', broker.decide(id, { decision: 'answer', answers: { [q.question]: q.options[1].label } }, 'phone'));
    } else console.log('  decide:', broker.decide(id, { decision: 'allow' }, 'phone'));
  }, 500);
} });
const w = new Worker({ store, tasks, query: query as any, maxTurns: 8, permissionMinutes: 2, broker });
const t = tasks.create({ projectId: p.id, source: 'phone', prompt: process.argv[2] ?? 'x' });
tasks.transition(t.id, 'awaiting_transcript', 'x'); tasks.transition(t.id, 'queued', 'x');
w.kick();
const t0 = Date.now();
while (!['done', 'failed', 'cancelled', 'needs_review'].includes(tasks.get(t.id)!.state)) { await new Promise(r => setTimeout(r, 300)); if (Date.now() - t0 > 240000) break; }
const f = tasks.get(t.id)!;
console.log('FINAL', f.state, '|', f.resultSummary ?? f.error);
console.log('STATES', tasks.events(t.id).map((e: any) => e.to_state).join(' > '));
console.log('REQS', store.listPermissionRequests(t.id).map(r => `${r.toolName}:${r.decision}`).join(', '));
process.exit(0);
