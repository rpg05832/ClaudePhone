// Claude in Chrome במשימות מהטלפון (לבקשת המשתמש, 16.10).
//
// התוסף Claude in Chrome עובד בתוך Chrome הרגיל של המשתמש, עם החשבונות שהוא מחובר אליהם. Claude Code טוען את הכלים שלו
// (mcp__claude-in-chrome__*) רק כשהוא מופעל עם --chrome; ב-SDK זה extraArgs: { chrome: null } (נבדק 16.10: נטען, בחר דפדפן,
// פתח לשונית בקבוצה משלו, נכנס לדף וקרא אותו, וכל פעולה עברה דרך canUseTool).
//
// כמה דפדפנים (פרופילים של Chrome) יכולים להיות מחוברים לאותו חשבון. לפני הפעולה הראשונה Claude בוחר אחד (select_browser).
// המשתמש קובע בלוח הבקרה: הראשון ברשימה (ברירת המחדל), דפדפן מסוים לפי מזהה, או לשאול אותו בטלפון בכל משימה.
import type { QueryFn } from './runner.ts';
import type { EditMode } from '../store/db.ts';

export const CHROME_SLUG = 'claude-in-chrome';
export const CHROME_LABEL = 'הדפדפן Chrome';

export interface ChromeBrowser { deviceId: string; name: string; osPlatform?: string; isLocal?: boolean }

/** 'first': הראשון ברשימה; 'ask': לשאול בטלפון בכל משימה; אחרת: מזהה הדפדפן (deviceId). */
export type ChromeBrowserChoice = 'first' | 'ask' | string;

export interface ChromeSettings { enabled: boolean; browser: ChromeBrowserChoice; browsers: ChromeBrowser[]; browsersAt: string | null }

/** מה שהמשימה צריכה לדעת: איזה דפדפן, ושם להקראה ולהנחיה. */
export interface ChromePolicy { browser: ChromeBrowserChoice; browserName?: string }

export function chromePolicy(s: ChromeSettings): ChromePolicy {
  const name = s.browser === 'first' || s.browser === 'ask' ? s.browsers[0]?.name : s.browsers.find(b => b.deviceId === s.browser)?.name;
  return { browser: s.browser, ...(name ? { browserName: name } : {}) };
}

/** כלים שרק קוראים או מנווטים בלי לשנות דבר בחשבון: רשימת לשוניות, קריאת דף, פתיחת כתובת, צילום מסך, גלילה. */
const READ_TOOLS = new Set(['tabs_context_mcp', 'list_connected_browsers', 'get_page_text', 'read_page', 'find', 'read_console_messages', 'read_network_requests', 'shortcuts_list', 'navigate', 'tabs_create_mcp', 'tabs_close_mcp', 'resize_window']);
const READ_COMPUTER_ACTIONS = new Set(['screenshot', 'scroll', 'scroll_to', 'zoom', 'wait', 'hover', 'mouse_move', 'cursor_position']);
const SELECT_TOOLS = new Set(['select_browser', 'switch_browser']);

export interface ChromeDecision { action: 'allow' | 'deny' | 'ask'; reason: string }

/** החלטה לכלי של Claude in Chrome (אחרי שנבדק שהחיבור הופעל). */
export function decideChrome(tool: string, input: Record<string, unknown>, editMode: EditMode, chrome: ChromePolicy | undefined): ChromeDecision {
  if (SELECT_TOOLS.has(tool)) {
    const want = chrome?.browser ?? 'first';
    if (want === 'first' || want === 'ask' || !input.deviceId || input.deviceId === want) return { action: 'allow', reason: 'בחירת הדפדפן' };
    return { action: 'deny', reason: `המשתמש קבע בלוח הבקרה את הדפדפן ${chrome?.browserName ?? want}; בחר בו (deviceId ${want})` };
  }
  // רצף פעולות: נבדק חלק אחרי חלק. כולו קריאה: לבד; חלק נדחה: הכל נדחה; אחרת לפי מצב העבודה
  if (tool === 'browser_batch') {
    const parts = batchActions(input).map(a => decideChrome(a.tool, a.input, editMode, chrome));
    if (parts.length && parts.every(d => d.action === 'allow' && d.reason !== 'אישור אוטומטי (נקבע בטלפון)')) return { action: 'allow', reason: 'קריאה או ניווט בדפדפן' };
    const denied = parts.find(d => d.action === 'deny');
    if (denied) return denied;
  }
  const isRead = READ_TOOLS.has(tool) || (tool === 'computer' && READ_COMPUTER_ACTIONS.has(String(input.action ?? '')));
  if (isRead) return { action: 'allow', reason: 'קריאה או ניווט בדפדפן' };
  if (editMode === 'auto') return { action: 'allow', reason: 'אישור אוטומטי (נקבע בטלפון)' };
  if (editMode === 'readonly') return { action: 'deny', reason: 'המערכת במצב קריאה בלבד (נקבע בטלפון)' };
  return { action: 'ask', reason: 'פעולה בדפדפן: נדרש אישור בטלפון' };
}

/** הפעולות שבתוך browser_batch: שם הכלי (בלי הקידומת) והקלט של כל אחת. */
export function batchActions(input: Record<string, unknown>): { tool: string; input: Record<string, unknown> }[] {
  const list = Array.isArray(input.actions) ? input.actions as any[] : [];
  return list.map(a => {
    const tool = String(a?.tool ?? a?.name ?? a?.tool_name ?? 'computer').replace(/^mcp__claude-in-chrome__/, '');
    const inner = a?.input ?? a?.args ?? a?.arguments ?? a?.params;
    return { tool, input: (inner && typeof inner === 'object' ? inner : a ?? {}) as Record<string, unknown> };
  });
}

const clip = (t: string, n = 100) => (t.length > n ? t.slice(0, n) + '...' : t);
const host = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return clip(u, 60); } };

/** תיאור להקראה בטלפון: "דפדפן: להקליד "שלום"". */
export function speakableChrome(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => { const v = input[k]; return v === undefined || v === null ? '' : typeof v === 'object' ? '' : String(v); };
  const p = 'דפדפן: ';
  switch (tool) {
    case 'navigate': return `${p}לפתוח את ${host(s('url'))}`;
    case 'select_browser': case 'switch_browser': return `${p}לבחור דפדפן`;
    case 'form_input': return `${p}למלא שדה בערך "${clip(s('value'), 80)}"`;
    case 'javascript_tool': return `${p}להריץ קוד בדף`;
    case 'file_upload': case 'upload_image': return `${p}להעלות קובץ לדף`;
    case 'shortcuts_execute': return `${p}להפעיל קיצור ${clip(s('name') || s('shortcut'), 60)}`;
    case 'gif_creator': return `${p}להקליט את המסך`;
    case 'browser_batch': {
      const actions = batchActions(input);
      const parts = actions.slice(0, 4).map(a => speakableChrome(a.tool, a.input).replace(p, ''));
      return `${p}רצף של ${actions.length || 'כמה'} פעולות${parts.length ? ': ' + parts.join(', ') : ''}${actions.length > 4 ? ' ועוד' : ''}`;
    }
    case 'computer': {
      const a = s('action');
      if (a === 'type') return `${p}להקליד "${clip(s('text'), 120)}"`;
      if (a === 'key') return `${p}להקיש ${clip(s('text'), 40)}`;
      if (/click/.test(a)) return `${p}ללחוץ בדף${s('ref') ? ' על ' + s('ref') : ''}`;
      if (a === 'left_click_drag') return `${p}לגרור בדף`;
      return `${p}${a.replace(/_/g, ' ') || 'פעולה בדף'}`;
    }
    default: return `${p}${tool.replace(/_/g, ' ')}`;
  }
}

/** ההנחיה ל-Claude כשהדפדפן פתוח למשימה: איזה דפדפן לבחור, ומה מותר. */
export function chromeAppend(c: ChromePolicy): string {
  const pick = c.browser === 'ask'
    ? 'לפני הפעולה הראשונה בדפדפן, קרא ל-list_connected_browsers ושאל את המשתמש באמצעות AskUserQuestion באיזה דפדפן להשתמש: אפשרות לכל דפדפן לפי השם שלו. אחר כך בחר בו עם select_browser.'
    : c.browser === 'first'
      ? 'לפני הפעולה הראשונה בדפדפן, קרא ל-list_connected_browsers ובחר עם select_browser את הדפדפן הראשון ברשימה. אל תשאל את המשתמש איזה דפדפן.'
      : `לפני הפעולה הראשונה בדפדפן, בחר עם select_browser את הדפדפן${c.browserName ? ` "${c.browserName}"` : ''} (deviceId ${c.browser}). אל תשאל את המשתמש איזה דפדפן. אם הוא לא מחובר כרגע, עצור וציין זאת בסיכום.`;
  return [
    `הדפדפן Chrome של המשתמש זמין לך דרך הכלים mcp__claude-in-chrome (טען אותם עם ToolSearch). אתה עובד בלשוניות חדשות בתוך Chrome הרגיל שלו, עם החשבונות שהוא כבר מחובר אליהם (כולל מעבר בין חשבונות Google שמורים).`,
    pick,
    'קריאה, ניווט וצילום מסך רצים בלי אישור. לחיצה, הקלדה ומילוי טפסים מוקראים למשתמש לאישור (לפי מצב העבודה), לכן העדף מעט פעולות ברורות. אל תקליד סיסמאות, קודי אימות או פרטי תשלום; אם נדרשים, עצור וציין זאת בסיכום. לפני שליחה סופית (מייל, טופס, הודעה) ודא שהנמען והתוכן מדויקים.',
  ].join('\n');
}

/**
 * רשימת הדפדפנים שמחוברים לחשבון: הרצה קצרה של Claude עם --chrome שקוראת ל-list_connected_browsers.
 * כל כלי אחר נדחה. התוצאה נקראת מתוך תשובת הכלי (JSON), לא מהטקסט של Claude.
 */
export async function listChromeBrowsers(query: QueryFn, cwd: string, timeoutMs = 120_000): Promise<ChromeBrowser[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let toolUseId: string | null = null;
  let found: ChromeBrowser[] | null = null;
  let lastText = '';
  try {
    const q = query({
      prompt: 'Load mcp__claude-in-chrome__list_connected_browsers with ToolSearch (retry if the server is still connecting), call it once, then reply with the single word OK. Do not call any other browser tool.',
      options: {
        cwd, maxTurns: 6, model: 'haiku', permissionMode: 'default', settingSources: ['user', 'project', 'local'], extraArgs: { chrome: null }, abortController: abort,
        canUseTool: async (name: string, input: Record<string, unknown>) => /^(ToolSearch|Skill|mcp__claude-in-chrome__list_connected_browsers)$/.test(name)
          ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'רק רשימת הדפדפנים' },
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant') for (const c of m.message?.content ?? []) if (c.type === 'tool_use' && /list_connected_browsers$/.test(c.name)) toolUseId = c.id;
      if (m.type === 'user' && Array.isArray(m.message?.content)) for (const c of m.message.content) {
        if (c.type !== 'tool_result' || (toolUseId && c.tool_use_id !== toolUseId)) continue;
        const texts = Array.isArray(c.content) ? c.content.filter((x: any) => x?.type === 'text').map((x: any) => String(x.text)) : [String(c.content ?? '')];
        lastText = texts.join(' ');
        const parsed = parseBrowsers(texts);
        if (parsed) found = parsed;
      }
      if (found) { abort.abort(); break; }
      if (m.type === 'result') break;
    }
  } catch (e) {
    if (!found) throw e;
  } finally { clearTimeout(timer); }
  if (!found) throw new Error(lastText ? `התוסף לא החזיר רשימה: ${clip(lastText.replace(/\s+/g, ' '), 160)}` : 'התוסף Claude in Chrome לא ענה. ודא ש-Chrome פתוח והתוסף מחובר.');
  return found;
}

/** מוצא בתשובת הכלי את מערך הדפדפנים (JSON). */
export function parseBrowsers(texts: string[]): ChromeBrowser[] | null {
  for (const t of texts) {
    const i = t.indexOf('[');
    const j = t.lastIndexOf(']');
    if (i < 0 || j <= i) continue;
    try {
      const arr = JSON.parse(t.slice(i, j + 1));
      if (!Array.isArray(arr)) continue;
      const out = arr.filter((b: any) => b && typeof b.deviceId === 'string').map((b: any) => ({
        deviceId: String(b.deviceId), name: String(b.name ?? b.deviceId),
        ...(b.osPlatform ? { osPlatform: String(b.osPlatform) } : {}), ...(typeof b.isLocal === 'boolean' ? { isLocal: b.isLocal } : {}),
      }));
      if (out.length || arr.length === 0) return out;
    } catch { /* לא JSON: ממשיכים */ }
  }
  return null;
}
