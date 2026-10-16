// חיבורי MCP למשימות מהטלפון (לבקשת המשתמש, 16.10).
//
// Claude Code במחשב טוען חיבורי MCP משלושה מקורות: המחברים של claude.ai (Gmail, Drive, יומן...; מסתנכרנים אוטומטית
// לפי ההתחברות של המנוי), שרתים ש-Claude Code הוגדר איתם (~/.claude.json), ושרתים של תוספים. ברירת המחדל של
// המערכת היא לחסום את כולם במשימות מהטלפון (strictMcpConfig + רשימה ריקה). כאן המשתמש בוחר אילו חיבורים לפתוח.
//
// גילוי: מריצים את Claude פעם אחת במצב לא-מחמיר, קוראים את הודעת ה-init (רשימת השרתים ורשימת הכלים) ומבטלים מיד.
// אכיפה: במשימה עם חיבורים פתוחים הסוכן רץ במצב לא-מחמיר, מסתיר כלים של שרתים שלא נבחרו (disallowedTools),
// ובמדיניות כל כלי mcp__ של שרת שלא נבחר נדחה; כלי של שרת שנבחר: קריאה לבד, שינוי לפי מצב העבודה (policy.ts).
import type { QueryFn } from './runner.ts';

export interface McpServerInfo {
  /** המזהה כפי שמופיע בשמות הכלים: mcp__<slug>__<tool> */
  slug: string;
  /** השם כפי ש-Claude Code מציג אותו ("claude.ai Gmail", "desktop-commander", "plugin:firebase:firebase") */
  name: string;
  status: string;
  source: 'claude.ai' | 'plugin' | 'local';
  tools: string[];
  /** הודעת השגיאה של Claude Code כששרת לא מתחבר (קצרה, להצגה בלוח) */
  error?: string;
}

/** מה ש-Claude Code מחזיר ב-mcpServerStatus(): המצב העדכני של כל שרת, כולל הכלים שלו ושגיאה אם נכשל. */
export interface McpStatusLike { name: string; status: string; error?: string; tools?: { name: string }[] }

export interface McpScan { at: string; claudeCodeVersion: string | null; servers: McpServerInfo[] }

/** איך Claude Code הופך שם שרת לקידומת בשמות הכלים: תווים שאינם אותיות, ספרות, קו תחתון או מקף הופכים ל-_ אחד. */
export function serverSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

export function serverSource(name: string): McpServerInfo['source'] {
  if (name.startsWith('claude.ai ')) return 'claude.ai';
  if (name.startsWith('plugin:')) return 'plugin';
  return 'local';
}

/** שם ידידותי להצגה ולהקראה: "Gmail" במקום "claude.ai Gmail", "firebase" במקום "plugin:firebase:firebase". */
export function serverLabel(name: string): string {
  if (name.startsWith('claude.ai ')) return name.slice('claude.ai '.length);
  if (name.startsWith('plugin:')) return name.split(':').pop() || name;
  return name;
}

/** פירוק שם כלי: mcp__<slug>__<tool>, או null אם זה לא כלי MCP. */
export function parseMcpTool(toolName: string): { slug: string; tool: string } | null {
  const m = toolName.match(/^mcp__(.+?)__(.+)$/);
  return m ? { slug: m[1], tool: m[2] } : null;
}

/** בונה את רשימת השרתים מהודעת ה-init של Claude Code. */
export function serversFromInit(init: { mcp_servers?: { name: string; status: string }[]; tools?: string[] }): McpServerInfo[] {
  const tools = (init.tools ?? []).filter(t => t.startsWith('mcp__'));
  const byPrefix = new Map<string, string[]>();
  for (const t of tools) { const p = parseMcpTool(t); if (!p) continue; const a = byPrefix.get(p.slug) ?? []; a.push(p.tool); byPrefix.set(p.slug, a); }
  const out: McpServerInfo[] = [];
  const seen = new Set<string>();
  for (const s of init.mcp_servers ?? []) {
    const slug = serverSlug(s.name);
    seen.add(slug);
    out.push({ slug, name: s.name, status: s.status, source: serverSource(s.name), tools: byPrefix.get(slug) ?? [] });
  }
  // כלים של שרת שלא הופיע ברשימה (לא אמור לקרות): מוצגים לפי הקידומת שלהם
  for (const [slug, list] of byPrefix) if (!seen.has(slug)) out.push({ slug, name: slug, status: 'connected', source: 'local', tools: list });
  return out;
}

/** עדכון רשימת השרתים לפי המצב העדכני מ-mcpServerStatus(): שרת שהיה "מתחבר" ב-init מקבל את מצבו הסופי, את הכלים שלו ואת השגיאה. */
export function mergeStatuses(servers: McpServerInfo[], statuses: McpStatusLike[]): McpServerInfo[] {
  for (const st of statuses) {
    if (!st?.name) continue;
    const slug = serverSlug(st.name);
    const status = st.status === 'needs-auth' ? 'needs_auth' : String(st.status ?? 'pending');
    const tools = (st.tools ?? []).map(t => t?.name).filter((n): n is string => typeof n === 'string' && !!n);
    const error = st.error ? String(st.error).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const s = servers.find(x => x.slug === slug);
    if (s) {
      s.status = status;
      if (tools.length && !s.tools.length) s.tools = tools;
      if (error) s.error = error; else delete s.error;
    } else {
      servers.push({ slug, name: st.name, status, source: serverSource(st.name), tools, ...(error ? { error } : {}) });
    }
  }
  return servers;
}

/**
 * דגימת מצב השרתים כל שנייה עד שאף שרת מהרשימה ההתחלתית לא "מתחבר", או עד תום הזמן. שרת שחסר בדגימה שומר את מצבו הקודם.
 * שגיאה בודדת (דגימה שנכשלה) נסלחת; שתיים ברצף (למשל התהליך כבר נסגר) מחזירות את מה שנאסף עד כה.
 */
async function settleStatuses(q: { mcpServerStatus: () => Promise<McpStatusLike[]> }, initial: { name: string; status: string }[], ms: number): Promise<McpStatusLike[] | null> {
  const deadline = Date.now() + ms;
  const state = new Map<string, McpStatusLike>(initial.map(s => [s.name, { name: s.name, status: s.status }]));
  let polled = false;
  let errors = 0;
  for (;;) {
    try {
      const cur = await Promise.race([q.mcpServerStatus(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      if (Array.isArray(cur)) { for (const s of cur) if (s?.name) state.set(s.name, s); polled = true; errors = 0; }
    } catch { if (++errors >= 2) break; }
    if (![...state.values()].some(s => s.status === 'pending') || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return polled ? [...state.values()] : null;
}

/**
 * גילוי החיבורים במחשב: הרצה קצרה של Claude במצב לא-מחמיר. הודעת ה-init נותנת את רשימת השרתים והכלים; שרתים מקומיים
 * שעדיין עולים באותו רגע ("מתחבר") נדגמים עוד כמה שניות דרך mcpServerStatus() כדי לקבל את מצבם הסופי, הכלים והשגיאה, ואז ביטול.
 * השרתים המקומיים (stdio) מופעלים לרגע כדי שיופיעו עם המצב שלהם, בדיוק כמו בפתיחת Claude Code.
 */
export async function discoverMcp(query: QueryFn, cwd: string, timeoutMs = 90_000, settleMs = 15_000): Promise<McpScan> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let init: any = null;
  let settle: Promise<McpStatusLike[] | null> | null = null;
  // קלט בזרם (ולא מחרוזת): כך Claude Code נשאר פתוח גם אחרי שענה, עד שמשחררים אותו, והדגימה של השרתים האיטיים לא נקטעת
  let release: () => void = () => {};
  const released = new Promise<void>(r => { release = r; });
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: '.' }, parent_tool_use_id: null, session_id: '' };
    await released;
  }
  try {
    // הגדרות המשתמש נדרשות: בלעדיהן Claude Code לא טוען שום חיבור, גם לא את המחברים של claude.ai (נבדק 16.10)
    const q: any = query({ prompt: input(), options: { cwd, maxTurns: 1, model: 'haiku', strictMcpConfig: false, permissionMode: 'default', settingSources: ['user', 'project', 'local'], abortController: abort, canUseTool: async () => ({ behavior: 'deny', message: 'סריקה בלבד' }) } });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        init = m;
        const pending = (m.mcp_servers ?? []).some((s: any) => s?.status === 'pending');
        if (pending && typeof q.mcpServerStatus === 'function') {
          settle = settleStatuses(q, (m.mcp_servers ?? []).filter((s: any) => s?.name), settleMs);
          void settle.finally(() => { release(); abort.abort(); });
        } else { release(); abort.abort(); break; }
      }
      if (m.type === 'result' && !settle) break;
    }
  } catch (e) {
    if (!init) throw e;   // ביטול אחרי init הוא הדרך הרגילה לסיים
  } finally { clearTimeout(timer); release(); }
  if (!init) throw new Error('Claude Code לא החזיר את רשימת החיבורים');
  const servers = serversFromInit(init);
  const statuses = settle ? await settle.catch(() => null) : null;
  if (statuses) mergeStatuses(servers, statuses);
  return { at: new Date().toISOString(), claudeCodeVersion: init.claude_code_version ?? null, servers };
}

/** כלים שרק קוראים (לפי שם): רצים בלי לשאול במצב עריכה, ומותרים גם במצב קריאה בלבד. */
const READ_TOOL = /^(get|list|search|read|fetch|find|query|describe|lookup|check|count|view|show|download|resolve|whoami|help|status|suggest|preview)(_|$)/i;
export function isReadOnlyMcpTool(tool: string): boolean { return READ_TOOL.test(tool); }

/** תיאור להקראה בטלפון: "ג'ימייל: לשלוח מייל אל x בנושא y". */
export function speakableMcp(slug: string, tool: string, input: Record<string, unknown>, label?: string): string {
  const server = label ?? slug.replace(/^claude_ai_/, '').replace(/_/g, ' ');
  const s = (k: string) => { const v = input[k]; return v === undefined || v === null || v === '' ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? '' : String(v); };
  const clip = (t: string, n = 120) => (t.length > n ? t.slice(0, n) + '...' : t);
  if (/^claude_ai_Gmail$/i.test(slug)) {
    if (tool === 'send_message') return `${server}: לשלוח מייל אל ${s('to')}${s('subject') ? ' בנושא ' + clip(s('subject'), 80) : ''}`;
    if (tool === 'reply') return `${server}: להשיב למייל${s('body') ? ': ' + clip(s('body'), 100) : ''}`;
    if (tool === 'forward') return `${server}: להעביר מייל אל ${s('to')}`;
    if (tool === 'create_draft' || tool === 'update_draft') return `${server}: לשמור טיוטה${s('to') ? ' אל ' + s('to') : ''}${s('subject') ? ' בנושא ' + clip(s('subject'), 80) : ''}`;
    if (tool.startsWith('trash')) return `${server}: להעביר מייל לאשפה`;
    if (tool.includes('spam')) return `${server}: לסמן כספאם`;
  }
  if (/^claude_ai_Google_Calendar$/i.test(slug)) {
    if (tool === 'create_event') return `${server}: ליצור אירוע${s('summary') || s('title') ? ' ' + clip(s('summary') || s('title'), 80) : ''}${s('start') ? ' ב-' + s('start') : ''}`;
    if (tool === 'delete_event') return `${server}: למחוק אירוע`;
    if (tool === 'update_event') return `${server}: לעדכן אירוע`;
  }
  const human = tool.replace(/_/g, ' ');
  const detail = ['to', 'subject', 'title', 'name', 'summary', 'query', 'q', 'path', 'file_path', 'command', 'url'].map(k => s(k)).find(Boolean);
  return `${server}: ${human}${detail ? ' (' + clip(detail, 100) + ')' : ''}`;
}
