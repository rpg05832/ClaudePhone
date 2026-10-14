// בדיקת הערוץ בלי Claude Code: מפעיל את שרת הערוץ כמו ש-Claude Code מפעיל אותו (לפי live-mcp.json),
// עושה לחיצת יד MCP, בודק שהוא נרשם אצל הסוכן, מעביר הודעה דמה ומחזיר תשובה דרך הכלי phone_reply.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const dataDir = process.argv[2];
const cfg = JSON.parse(readFileSync(join(dataDir, 'live-mcp.json'), 'utf8')).mcpServers.claudephone;
const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'], cwd: process.argv[3] ?? process.cwd() });
let buf = ''; const msgs = [];
child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) msgs.push(JSON.parse(l)); } });
child.stderr.on('data', d => process.stdout.write('[stderr] ' + d));
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const wait = async (pred, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = msgs.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 50)); } return null; };
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
const init = await wait(m => m.id === 1);
console.log('capabilities:', JSON.stringify(init?.result?.capabilities), '| protocol', init?.result?.protocolVersion, '| instructions', (init?.result?.instructions ?? '').length, 'chars');
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const tools = await wait(m => m.id === 2);
console.log('tools:', tools?.result?.tools?.map(t => t.name).join(','));
const token = readFileSync(cfg.env.CP_LIVE_TOKEN_FILE, 'utf8').trim();
const dashTok = readFileSync(join(dataDir, 'dashboard.token'), 'utf8').trim();
await new Promise(r => setTimeout(r, 1500));
const live = await (await fetch(cfg.env.CP_AGENT_URL + '/api/live', { headers: { cookie: 'cp_token=' + dashTok } })).json();
console.log('live sessions:', live.map(s => `${s.id} ${s.name}`).join(' | '));
child.kill();
