// טיפוסים משותפים לסוכן (ולגישור המובנה בתוכו). מקור האמת: האפיון, סעיפים 3 עד 5.

/** מצבי משימה (אפיון 4, "מחזור חיים"). */
export type TaskState =
  | 'draft'                 // טיוטה: הקלטה התקבלה, טרם תומללה או אושרה
  | 'awaiting_transcript'   // ממתינה לאישור תמלול בטלפון
  | 'queued'                // בתור: מאושרת, ממתינה למחשב פנוי
  | 'running'               // רצה ב-Claude
  | 'awaiting_permission'   // Claude ביקש הרשאה
  | 'awaiting_answer'       // Claude שאל שאלה
  | 'stop_requested'        // התבקשה עצירה, טרם הוכח שהתהליך עצר
  | 'done'                  // הסתיימה, תוצאה שמורה
  | 'failed'
  | 'cancelled'
  | 'needs_review';         // נתקעה או התהליך נעלם; לא מריצים שוב אוטומטית

/** מעברים מותרים. כל מעבר אחר נדחה ונרשם. */
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  draft: ['awaiting_transcript', 'cancelled'],
  awaiting_transcript: ['queued', 'draft', 'cancelled'],
  queued: ['running', 'cancelled', 'needs_review'],
  running: ['awaiting_permission', 'awaiting_answer', 'stop_requested', 'done', 'failed', 'needs_review'],
  awaiting_permission: ['running', 'stop_requested', 'failed', 'needs_review'],
  awaiting_answer: ['running', 'stop_requested', 'failed', 'needs_review'],
  stop_requested: ['cancelled', 'done', 'failed', 'needs_review'],
  done: [], failed: [], cancelled: [], needs_review: ['queued', 'cancelled'],
};

/** מצבים שבהם המשימה נחשבת "פעילה" (תפריט 5 בטלפון). */
export const ACTIVE_STATES: TaskState[] = ['queued', 'running', 'awaiting_permission', 'awaiting_answer', 'stop_requested'];

export type TaskSource = 'phone' | 'dashboard' | 'desktop' | 'unknown';

export interface Project {
  id: string;
  name: string;            // שם לתצוגה
  spokenName: string;      // השם שמוקרא בטלפון
  path: string;            // תיקיית העבודה
  phoneEnabled: boolean;
  permissions: ProjectPermissions;
  createdAt: string;
  /** נתיבים קודמים (אחרי העברת תיקיית הפרויקטים): שיחות ישנות נרשמו איתם. */
  formerPaths?: string[];
}

/** הרשאות ברירת מחדל לפרויקט (אפיון 5; החלטה 11 בתוכנית). */
export interface ProjectPermissions {
  /** עריכת קבצים בתוך תיקיית הפרויקט בלי לשאול */
  editInsideProject: boolean;
  /** הרצת פקודות (Bash) בלי לשאול: לעולם לא בגרסת הבסיס */
  runCommands: boolean;
}

export interface Conversation {
  id: string;              // session id של Claude
  projectId: string;
  title: string;           // השם שמוקרא: תחילת ההודעה הראשונה
  source: TaskSource;
  createdAt: string;
  lastActiveAt: string;
}

export interface Task {
  id: string;                       // מזהה ייחודי (uuid)
  num: number;                      // מספר קצר להקראה
  projectId: string;
  conversationId: string | null;    // מזהה שיחה של Claude (session id); null עד שנפתחה
  state: TaskState;
  source: TaskSource;
  prompt: string;
  /** מודל לבקשה הזו (opus/sonnet/haiku), או null לפי ההגדרה הכללית. */
  model?: string | null;                   // התמלול המאושר
  recordingPath: string | null;
  resultText: string | null;        // התשובה המלאה של Claude
  resultSummary: string | null;     // הסיכום שהוכן להקראה
  error: string | null;
  heard: boolean;                   // "נשמעה" (אפיון 3): רק אחרי השמעה או אישור
  phone: string | null;             // המספר ששלח (להתראות)
  createdAt: string; updatedAt: string; expiresAt: string | null;
}

/** בקשת הרשאה (אפיון 5). ההחלטה הראשונה שנשמרה קובעת. */
export interface PermissionRequest {
  id: string; taskId: string; projectId: string;
  toolName: string; input: Record<string, unknown>; summary: string;
  createdAt: string; expiresAt: string;
  /** answer = תשובה לשאלה (AskUserQuestion); expired/cancelled = נסגרה בלי החלטה */
  decision: 'allow' | 'deny' | 'answer' | 'expired' | 'cancelled' | null;
  decidedAt: string | null; decidedVia: 'phone' | 'dashboard' | 'policy' | 'system' | null;
  explanation: string | null;       // מקש 8: הסבר בהקלטה במקום אישור/דחייה
}

export interface PhoneLogEntry {
  callId: string; phone: string; at: string; kind: string; detail: string | null;
}
