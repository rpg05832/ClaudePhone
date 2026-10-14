// ערוץ הטלפון לשיחה פתוחה של Claude Code (שלב 5, Channels research preview).
// Claude Code מפעיל את הקובץ הזה כשרת MCP (stdio) כשמריצים: claude --mcp-config <live-mcp.json> --dangerously-load-development-channels server:claudephone
// הערוץ נרשם אצל הסוכן המקומי, מקבל ממנו הודעות מהטלפון ומכניס אותן לשיחה, ומעביר בחזרה את התשובה (כלי phone_reply)
// ובקשות הרשאה (permission relay). כל התקשורת ב-127.0.0.1 עם אסימון מקומי מקובץ.
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const AGENT = process.env.CP_AGENT_URL || 'http://127.0.0.1:7788';
const TOKEN = readFileSync(process.env.CP_LIVE_TOKEN_FILE, 'utf8').trim();
const err = (...a) => process.stderr.write(`[claudephone] ${a.join(' ')}\n`);   // stdout שמור לפרוטוקול

const INSTRUCTIONS = [
  'הודעות שמגיעות כ-<channel source="claudephone" chat_id="..."> נשלחו מהטלפון הכשר של המשתמש דרך מערכת קולית.',
  'טפל בהן כמו בבקשה רגילה בשיחה הזו. כשסיימת, חובה לענות בכלי phone_reply עם אותו chat_id: התשובה תוקרא למשתמש בקול.',
  'בתשובה: פתח בסיכום של עד שלושה משפטים קצרים בעברית פשוטה (מה עשית, מה התוצאה, מה נדרש ממנו), בלי קוד, בלי Markdown ובלי נתיבים ארוכים.',
  'אחרי הסיכום אפשר להוסיף שורה עם --- ואחריה פירוט. אם צריך החלטה מהמשתמש, שאל אותה בתוך phone_reply והוא יענה בהודעה הבאה.',
].join('\n');

const mcp = new Server(
  { name: 'claudephone', version: '0.5.0' },
  {
    capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
    instructions: INSTRUCTIONS,
  },
);

let session = null;

async function call(method, path, body) {
  const r = await fetch(AGENT + path, {
    method, headers: { 'content-type': 'application/json', 'x-cp-live': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'phone_reply',
    description: 'שליחת התשובה למשתמש בטלפון (תוקרא לו בקול). להשתמש בסוף כל טיפול בהודעה שהגיעה מ-claudephone.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'ה-chat_id מהתג של ההודעה' },
        text: { type: 'string', description: 'התשובה: סיכום קצר בעברית, ואחרי שורת --- פירוט אם צריך' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'phone_reply') throw new Error(`כלי לא מוכר: ${req.params.name}`);
  const { chat_id, text } = req.params.arguments ?? {};
  const r = await call('POST', '/live/reply', { s: session, chat_id: String(chat_id ?? ''), text: String(text ?? '') });
  return { content: [{ type: 'text', text: r.delivered ? 'נשלח לטלפון' : 'לא נמצאה הודעה מהטלפון שמחכה לתשובה' }] };
});

// בקשת הרשאה מ-Claude Code: מועברת לטלפון (רק כשיש הודעה מהטלפון בטיפול). חלון האישור בטרמינל נשאר פתוח.
mcp.setNotificationHandler(z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
}), async ({ params }) => {
  try { await call('POST', '/live/permission', { s: session, ...params }); } catch (e) { err('permission relay failed:', e.message); }
});

async function register() {
  const r = await call('POST', '/live/register', { cwd: process.cwd(), pid: process.ppid });
  session = r.session;
  err('registered', session);
}

async function loop() {
  for (;;) {
    try {
      if (!session) await register();
      const r = await call('GET', `/live/poll?s=${encodeURIComponent(session)}`);
      for (const ev of r.events ?? []) {
        if (ev.type === 'message') {
          await mcp.notification({ method: 'notifications/claude/channel', params: { content: ev.text, meta: { chat_id: ev.chat_id, from: 'phone' } } });
        } else if (ev.type === 'permission') {
          await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: ev.request_id, behavior: ev.behavior } });
        }
      }
    } catch (e) {
      if (e.status === 410) session = null;          // הסוכן אותחל: נרשמים מחדש
      else { err('agent unreachable:', e.message); await new Promise(r => setTimeout(r, 5000)); }
    }
  }
}

await mcp.connect(new StdioServerTransport());
loop();

const bye = async () => { try { if (session) await call('POST', '/live/bye', { s: session }); } catch { /* */ } process.exit(0); };
process.stdin.on('close', bye);
process.on('SIGTERM', bye);
