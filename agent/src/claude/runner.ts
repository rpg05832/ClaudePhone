// הרצת Claude Code דרך Agent SDK (הוחלט בשלב 0): שיחה חדשה או המשך לפי מזהה, עם canUseTool ועצירה.
import type { Project } from '@claude-phone/shared';
import { decide, type McpPolicy } from './policy.ts';
import type { EditMode } from '../store/db.ts';
import { log } from '../log.ts';

export interface RunInput {
  project: Project;
  prompt: string;
  resumeId: string | null;
  maxTurns: number;
  model?: string;
  /** רמת חשיבה (low..max); בלי: ברירת המחדל של Claude Code */
  effort?: string;
  editMode: EditMode;
  abort: AbortController;
  onSession: (sessionId: string) => void;
  /** המשך שיחת Cowork: תיקיית העבודה של השיחה, ותיקיות נוספות שהיא עובדת עליהן. */
  cwd?: string;
  additionalDirectories?: string[];
  /** תיקיות שמותר לערוך בהן בלי לשאול (ברירת מחדל: תיקיית הפרויקט). */
  editRoots?: string[];
  /**
   * חיבורי MCP שפתוחים למשימה (לוח הבקרה, הגדרות). ריק: Claude רץ בלי שום חיבור (strictMcpConfig).
   * לא ריק: Claude טוען את החיבורים כמו במחשב, הכלים של שרתים שלא נבחרו מוסתרים (known שלא ב-enabled), והמדיניות חוסמת כל שאר.
   */
  mcp?: McpPolicy & { known?: string[] };
  /** החלטה של המדיניות בלבד (allow/deny) נרשמת ביומן. */
  onPermission: (p: { toolName: string; input: Record<string, unknown>; allowed: boolean; reason: string; summary: string }) => void;
  /** בקשה שדורשת את המשתמש: מחכה להחלטה בטלפון ומחזירה את התשובה ל-Claude. */
  askUser: (p: { toolName: string; input: Record<string, unknown>; summary: string; signal: AbortSignal }) => Promise<AskResult>;
}

/** תוצאת בקשה מהמשתמש. answers: לשאלה (טקסט השאלה -> תשובה). */
export type AskResult =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; explanation?: string }
  | { kind: 'answer'; answers: Record<string, string> };

export interface RunResult { sessionId: string | null; text: string; isError: boolean; errorText?: string; turns: number; }

export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;

/** ההנחיה שמתווספת ל-Claude: המשתמש בטלפון, והתשובה מוקראת. */
export const PHONE_APPEND = [
  'המשתמש שולח את המשימה מטלפון כשר דרך מערכת קולית, והתשובה הסופית שלך תוקרא לו בקול.',
  'פתח את ההודעה הסופית בסיכום של עד שלושה משפטים קצרים בעברית פשוטה: מה עשית, מה התוצאה, ומה נדרש ממנו אם בכלל.',
  'בסיכום אין קוד, אין סימני Markdown, אין נתיבים ארוכים ואין כתובות. אחרי הסיכום כתוב שורה שמכילה רק --- ואחריה כל הפירוט שתרצה.',
  'גם הפירוט שאחרי הקו עשוי להיות מוקרא בקול, לכן כתוב אותו במשפטים ברורים בעברית ובלי טבלאות; קוד, אם צריך, בבלוק קוד (הוא מוחלף בהקראה בהפניה ללוח הבקרה).',
  'עריכת קבצים בתוך תיקיית הפרויקט מאושרת מראש. כל פקודה דורשת אישור של המשתמש בטלפון, והיא מוקראת לו במלואה: הרץ רק פקודות נחוצות, קצרות וברורות, ותן לכל פקודה תיאור קצר בעברית בשדה description.',
  'אם חסרה החלטה של המשתמש, שאל באמצעות AskUserQuestion: שאלה אחת קצרה בעברית עם 2 עד 4 אפשרויות קצרות. אל תשאל על דברים שאפשר להחליט בעצמך באופן סביר.',
  'פעולות מחוץ לתיקיית הפרויקט אינן זמינות. אם פעולה נדחתה, אל תנסה לעקוף אותה בדרך אחרת; אם הצטרף הסבר מהמשתמש, פעל לפיו. ציין בסיכום מה לא בוצע.',
].join('\n');

/** במצב קריאה בלבד: Claude מתבקש לא לשנות כלום, ובנוסף כלי העריכה חסומים במדיניות. */
export const READONLY_APPEND = 'המשתמש בחר במצב קריאה בלבד: אל תשנה, תיצור או תמחק קבצים. קרא, בדוק, הסבר והצע מה כדאי לעשות, וציין בסיכום שאפשר להפעיל שינויים מתפריט ההגדרות בטלפון.';

/** חיבורים שפתוחים למשימה: Claude מתבקש להשתמש בהם ישירות (ולא לשאול "איך לחבר"), וכל שינוי דרכם מוקרא לאישור. */
export function mcpAppend(mcp: McpPolicy): string {
  const names = mcp.enabled.map(s => mcp.labels?.[s] ?? s.replace(/^claude_ai_/, '').replace(/_/g, ' '));
  return `החיבורים הבאים זמינים לך ככלי MCP ואפשר להשתמש בהם ישירות, בלי לשאול את המשתמש איך להתחבר: ${names.join(', ')}. פעולות קריאה (חיפוש, קריאה) רצות בלי אישור; פעולה שמשנה משהו (שליחת מייל, מחיקה, יצירת אירוע) מוקראת למשתמש לאישור, לכן לפני שליחה ודא שהנמען, הנושא והתוכן מוכנים ומדויקים. חיבורים אחרים שאינם ברשימה אינם זמינים.`;
}

/** במצב אישור אוטומטי: הפקודות לא נשאלות, ולכן Claude מתבקש לנהוג בזהירות כפולה. */
export const AUTO_APPEND = 'המשתמש בחר באישור אוטומטי: הפקודות שלך ירוצו בלי לשאול אותו. עבוד רק בתוך תיקיית הפרויקט, אל תמחק או תשנה דברים מחוץ לה, אל תדחוף לשרתים ואל תפרסם שום דבר בלי שהמשתמש ביקש זאת במפורש במשימה. בפעולה בלתי הפיכה, שאל קודם עם AskUserQuestion.';

export async function runClaude(query: QueryFn, i: RunInput): Promise<RunResult> {
  let sessionId: string | null = i.resumeId;
  let text = '';
  let isError = false;
  let errorText: string | undefined;
  let turns = 0;
  const mcpOpen = !!i.mcp?.enabled.length;
  const options: Record<string, unknown> = {
    cwd: i.cwd ?? i.project.path,
    permissionMode: 'default',
    maxTurns: i.maxTurns,
    resume: i.resumeId ?? undefined,
    // בלי חיבורים: מצב מחמיר ורשימה ריקה (גם המחברים של claude.ai לא נטענים). עם חיבורים: כמו Claude Code במחשב,
    // והכלים של כל שרת מוכר שלא נבחר מוסתרים מ-Claude (המדיניות חוסמת גם שרת שלא מוכר).
    strictMcpConfig: !mcpOpen,
    mcpServers: {},
    ...(mcpOpen && i.mcp!.known?.length ? { disallowedTools: i.mcp!.known.filter(s => !i.mcp!.enabled.includes(s)).map(s => `mcp__${s}`) } : {}),
    // רק הגדרות הפרויקט (כולל CLAUDE.md). בלי הגדרות המשתמש, כדי שכללי "אשר תמיד" כלליים לא יעקפו את המדיניות.
    settingSources: ['project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: PHONE_APPEND + (i.editMode === 'readonly' ? '\n' + READONLY_APPEND : i.editMode === 'auto' ? '\n' + AUTO_APPEND : '') + (mcpOpen ? '\n' + mcpAppend(i.mcp!) : '') },
    abortController: i.abort,
    canUseTool: async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
      const d = decide(toolName, input, i.editRoots ?? i.project.path, i.project.permissions, i.editMode, i.mcp);
      if (d.action !== 'ask') {
        i.onPermission({ toolName, input, allowed: d.action === 'allow', reason: d.reason, summary: d.summary });
        log('claude', `${d.action === 'allow' ? 'מאושר' : 'נדחה'}: ${d.summary.slice(0, 160)} (${d.reason})`);
        return d.action === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: `לא אושר: ${d.reason}. אל תנסה דרך אחרת לבצע את אותה פעולה; ציין בסיכום מה נדרש.` };
      }
      log('claude', `ממתין למשתמש: ${d.summary.slice(0, 160)}`);
      const res = await i.askUser({ toolName, input, summary: d.summary, signal: opts?.signal ?? i.abort.signal });
      if (res.kind === 'allow') return { behavior: 'allow', updatedInput: input };
      if (res.kind === 'answer') return { behavior: 'allow', updatedInput: { ...input, answers: res.answers } };
      const msg = res.explanation
        ? `המשתמש לא אישר את הפעולה הזו, והסביר: "${res.explanation}". פעל לפי ההסבר שלו.`
        : `לא אושר: ${res.reason}. אל תנסה דרך אחרת לבצע את אותה פעולה; ציין בסיכום מה לא בוצע.`;
      return { behavior: 'deny', message: msg };
    },
  };
  if (i.model) options.model = i.model;
  if (i.effort) options.effort = i.effort;
  if (i.additionalDirectories?.length) options.additionalDirectories = i.additionalDirectories;

  const prompt = i.editMode === 'readonly' ? `[מצב קריאה בלבד: אל תשנה קבצים]\n${i.prompt}` : i.prompt;
  for await (const m of query({ prompt, options })) {
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
      if (m.session_id !== sessionId) { sessionId = m.session_id; }
      i.onSession(m.session_id);
    } else if (m.type === 'result') {
      turns = m.num_turns ?? 0;
      if (m.session_id) sessionId = m.session_id;
      if (m.subtype === 'success' && !m.is_error) text = String(m.result ?? '');
      else { isError = true; errorText = String(m.result ?? m.subtype ?? 'error'); text = String(m.result ?? ''); }
    }
  }
  return { sessionId, text, isError, errorText, turns };
}

/** מפריד בין הסיכום להקראה לבין הפירוט (לפי שורת ---). אם אין, מנקה Markdown ולוקח התחלה. */
export function splitSummary(text: string): { summary: string; details: string } {
  const parts = text.split(/^\s*-{3,}\s*$/m);
  if (parts.length > 1 && parts[0].trim()) return { summary: cleanForSpeech(parts[0]), details: parts.slice(1).join('---').trim() };
  const clean = cleanForSpeech(text);
  return { summary: clean.length > 600 ? clean.slice(0, 600).replace(/\s+\S*$/, '') + '. התשובה המלאה בלוח הבקרה' : clean, details: text };
}

export function cleanForSpeech(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' (קוד מופיע בלוח הבקרה) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[*_|>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
