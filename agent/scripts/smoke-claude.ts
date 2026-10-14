// בדיקת עשן: הרצה אמיתית של מנוע הביצוע מול Claude (Agent SDK) בפרויקט זמני, בלי טלפון.
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Store } from '../src/store/db.ts';
import { Tasks } from '../src/store/tasks.ts';
import { Worker } from '../src/claude/worker.ts';

const dir = mkdtempSync(join(tmpdir(), 'cp-smoke-'));
const store = new Store(':memory:'); const tasks = new Tasks(store);
const p = store.addProject({ name: 'smoke', path: dir });
const w = new Worker({ store, tasks, query: query as any, maxTurns: 6, permissionMinutes: 10 });
const mk = (prompt: string, conv: string | null = null) => { const t = tasks.create({ projectId: p.id, source: 'phone', prompt, conversationId: conv }); tasks.transition(t.id, 'awaiting_transcript', 'x'); return tasks.transition(t.id, 'queued', 'x'); };
const wait = async (id: string) => { const t0 = Date.now(); while (!['done','failed','cancelled','needs_review'].includes(tasks.get(id)!.state)) { await new Promise(r => setTimeout(r, 300)); if (Date.now() - t0 > 180000) throw new Error('timeout'); } return tasks.get(id)!; };
const t1 = mk('צור קובץ hello.txt עם המילה shalom, ואז הרץ את הפקודה dir.');
w.kick(); const r1 = await wait(t1.id);
console.log('T1', r1.state, '| file:', existsSync(join(dir, 'hello.txt')) && readFileSync(join(dir, 'hello.txt'), 'utf8').trim(), '| summary:', r1.resultSummary);
console.log('perms:', store.listPermissionRequests(t1.id).map(x => `${x.toolName}:${x.decision}`).join(', '));
const t2 = mk('מה ביקשתי ממך קודם? משפט אחד.', r1.conversationId);
w.kick(); const r2 = await wait(t2.id);
console.log('T2', r2.state, '| same conv:', r2.conversationId === r1.conversationId, '| summary:', r2.resultSummary);
process.exit(0);
