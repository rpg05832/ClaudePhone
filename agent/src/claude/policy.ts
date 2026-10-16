// מדיניות ההרשאות (אפיון 5). שלוש תוצאות:
// - allow: עריכת קבצים בתוך תיקיית הפרויקט כשהמערכת במצב שינויים (נבדק גם מול קישורים ויציאה מהתיקייה).
// - ask:   פקודות, רשת וכלים אחרים: נשאל בטלפון (שלב 2). שאלה של Claude (AskUserQuestion) תמיד נשאלת.
// - deny:  עריכה מחוץ לפרויקט; במצב קריאה בלבד כל מה שאינו קריאה או שאלה.
// במצב אישור אוטומטי (auto) הכול מאושר מלבד שאלות, שעדיין מגיעות למשתמש.
// כלי קריאה (Read, Glob, Grep...) Claude Code מאשר לבד ולא מגיעים לכאן. לעולם לא bypassPermissions.
import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import type { ProjectPermissions } from '@claude-phone/shared';
import type { EditMode } from '../store/db.ts';
import { parseMcpTool, isReadOnlyMcpTool, speakableMcp } from './mcp.ts';

/** חיבורי MCP שפתוחים למשימות מהטלפון: מזהי שרתים (slug) ושם להקראה. */
export interface McpPolicy { enabled: string[]; labels?: Record<string, string> }

export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
export const QUESTION_TOOL = 'AskUserQuestion';
/**
 * כלי עזר פנימיים של Claude Code שלא נוגעים בקבצים ולא יוצאים החוצה: טעינת הגדרות של כלים (ToolSearch: בלעדיו
 * Claude לא יכול להשתמש בכלי MCP, נבדק 16.10), רשימת משימות פנימית, קריאת מקורות MCP. מאושרים בכל מצב עבודה.
 */
export const SAFE_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Skill']);

export interface PolicyDecision { action: 'allow' | 'deny' | 'ask'; reason: string; summary: string; }

export function decide(toolName: string, input: Record<string, unknown>, projectPath: string | string[], perms: ProjectPermissions, editMode: EditMode = 'edit', mcp?: McpPolicy): PolicyDecision {
  const roots = Array.isArray(projectPath) ? projectPath : [projectPath];
  const summary = speakableSummary(toolName, input, mcp?.labels);
  if (toolName === QUESTION_TOOL) return { action: 'ask', reason: 'שאלה למשתמש', summary };
  if (SAFE_TOOLS.has(toolName)) return { action: 'allow', reason: 'כלי עזר פנימי', summary };
  // חיבורי MCP: רק שרת שהמשתמש פתח לטלפון; קריאה לבד, שינוי לפי מצב העבודה. שרת שלא נפתח נדחה גם באישור אוטומטי.
  const mt = parseMcpTool(toolName);
  if (mt) {
    if (!mcp?.enabled.includes(mt.slug)) return { action: 'deny', reason: 'החיבור הזה לא הופעל למשימות מהטלפון (לוח הבקרה, הגדרות)', summary };
    if (isReadOnlyMcpTool(mt.tool)) return { action: 'allow', reason: 'קריאה מחיבור שהופעל', summary };
    if (editMode === 'auto') return { action: 'allow', reason: 'אישור אוטומטי (נקבע בטלפון)', summary };
    if (editMode === 'readonly') return { action: 'deny', reason: 'המערכת במצב קריאה בלבד (נקבע בטלפון)', summary };
    return { action: 'ask', reason: 'פעולה שמשנה דרך חיבור: נדרש אישור בטלפון', summary };
  }
  // מצב אישור אוטומטי (בחירת המשתמש בטלפון): כל פעולה מאושרת ונרשמת ביומן. שאלות עדיין נשאלות.
  if (editMode === 'auto') return { action: 'allow', reason: 'אישור אוטומטי (נקבע בטלפון)', summary };
  if (EDIT_TOOLS.has(toolName)) {
    const p = String(input.file_path ?? input.notebook_path ?? '');
    if (editMode === 'readonly') return { action: 'deny', reason: 'המערכת במצב קריאה בלבד (נקבע בטלפון)', summary };
    if (!perms.editInsideProject) return { action: 'deny', reason: 'עריכת קבצים כבויה בפרויקט הזה', summary };
    if (!p) return { action: 'deny', reason: 'לא צוין נתיב קובץ', summary };
    if (!roots.some(r => isInside(r, p))) return { action: 'deny', reason: 'הקובץ מחוץ לתיקיית הפרויקט', summary };
    return { action: 'allow', reason: 'עריכה בתוך הפרויקט', summary };
  }
  if (editMode === 'readonly') return { action: 'deny', reason: 'המערכת במצב קריאה בלבד (נקבע בטלפון)', summary };
  return { action: 'ask', reason: 'נדרש אישור בטלפון', summary };
}

/** תיאור הבקשה כפי שיוקרא בטלפון. פקודה מוקראת במלואה, כדי שהאישור יהיה על מה שירוץ בפועל. */
export function speakableSummary(toolName: string, input: Record<string, unknown>, mcpLabels?: Record<string, string>): string {
  const mt = parseMcpTool(toolName);
  if (mt) return speakableMcp(mt.slug, mt.tool, input, mcpLabels?.[mt.slug]);
  if (toolName === QUESTION_TOOL) {
    const qs = (input.questions as any[]) ?? [];
    return qs.map(q => String(q.question ?? '')).join(' ');
  }
  if (SHELL_TOOLS.has(toolName)) {
    const desc = String(input.description ?? '').trim();
    const cmd = String(input.command ?? '').trim();
    return `${desc ? desc + '. ' : ''}הפקודה: ${cmd}`;
  }
  if (EDIT_TOOLS.has(toolName)) return `לערוך את הקובץ ${String(input.file_path ?? input.notebook_path ?? '')}`;
  if (toolName === 'WebFetch') return `לפתוח את הכתובת ${String(input.url ?? '')}`;
  if (toolName === 'WebSearch') return `לחפש באינטרנט: ${String(input.query ?? '')}`;
  return `להשתמש בכלי ${toolName}`;
}

/** האם הנתיב נמצא בתוך התיקייה, אחרי פתרון קישורים (גם לקובץ שעוד לא קיים: בודקים את התיקייה הקיימת הקרובה). */
export function isInside(root: string, target: string): boolean {
  const realRoot = safeReal(root);
  const abs = isAbsolute(target) ? target : resolve(root, target);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    probe = parent;
  }
  const realTarget = resolve(safeReal(probe), ...tail);
  const rel = relative(realRoot, realTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeReal(p: string): string { try { return realpathSync.native(p); } catch { return resolve(p); } }
