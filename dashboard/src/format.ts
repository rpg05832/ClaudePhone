import type { TaskState } from './api';

const dtf = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

export function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return `לפני ${min} דק׳`;
  const today = new Date().toDateString() === d.toDateString();
  return today ? `היום ${tf.format(d)}` : dtf.format(d);
}

export function full(iso: string | null | undefined): string { return iso ? dtf.format(new Date(iso)) : ''; }

export const STATE_LABEL: Record<TaskState, string> = {
  draft: 'טיוטה', awaiting_transcript: 'ממתינה לאישור תמלול', queued: 'בתור', running: 'רצה',
  awaiting_permission: 'ממתינה לאישור', awaiting_answer: 'ממתינה לתשובה', stop_requested: 'בעצירה',
  done: 'הסתיימה', failed: 'נכשלה', cancelled: 'בוטלה', needs_review: 'דורשת בדיקה',
};

export function stateTone(s: TaskState): 'ok' | 'warn' | 'bad' | 'busy' | 'muted' {
  if (s === 'done') return 'ok';
  if (s === 'failed' || s === 'needs_review') return 'bad';
  if (s === 'awaiting_permission' || s === 'awaiting_answer') return 'warn';
  if (s === 'running' || s === 'queued' || s === 'stop_requested') return 'busy';
  return 'muted';
}

export const SOURCE_LABEL: Record<string, string> = { phone: 'טלפון', desktop: 'Desktop', cli: 'טרמינל', vscode: 'VS Code', sdk: 'תוכנה', cowork: 'Cowork', unknown: 'לא ידוע', dashboard: 'לוח בקרה' };

export const DECISION_LABEL: Record<string, string> = {
  allow: 'אושר', deny: 'נדחה', answer: 'נענה', expired: 'פג תוקף', cancelled: 'נסגר',
};

export const VIA_LABEL: Record<string, string> = { phone: 'בטלפון', dashboard: 'בלוח', policy: 'לפי מדיניות', system: 'מערכת' };

export const EFFORT_LABEL: Record<string, string> = { default: 'ברירת מחדל', low: 'נמוכה (מהיר)', medium: 'בינונית', high: 'גבוהה', xhigh: 'גבוהה מאוד', max: 'מקסימלית (איטי)' };

export const MODEL_LABEL: Record<string, string> = { default: 'ברירת המחדל של החשבון', fable: 'Fable (הדור החזק ביותר)', opus: 'Opus (חזק מאוד)', sonnet: 'Sonnet (מאוזן)', haiku: 'Haiku (מהיר וחסכוני)' };

export const MODE_LABEL = { readonly: 'קריאה בלבד', edit: 'שינויים, פקודות באישור', auto: 'אישור אוטומטי לכל הפעולות' } as const;

export const VOICE_LABEL: Record<string, string> = {
  ymMale: 'גברי ראשון', Elik_2100: 'גברי שני', Jacob: 'גברי שלישי', ymFemale: 'נשי ראשון', Sivan: 'נשי שני', Osnat: 'נשי שלישי',
};

export const PHONE_KIND: Record<string, string> = {
  call_start: 'שיחה נכנסת', pin_ok: 'כניסה עם PIN', pin_fail: 'PIN שגוי', pin_locked: 'כניסה חסומה', rejected_number: 'מספר לא מורשה',
  recorded: 'הקלטה', task_sent: 'משימה נשלחה', hangup: 'ניתוק', project_created: 'פרויקט חדש', decision: 'החלטה על בקשה',
  stop_requested: 'בקשת עצירה', setting_editMode: 'שינוי מצב עבודה', setting_voice: 'שינוי קול', setting_notify: 'צינתוקים', setting_model: 'שינוי מודל',
  setting_effort: 'שינוי רמת חשיבה', setting_readback: 'שינוי מה מוקרא בסיום', setting_stt: 'שינוי מנוע התמלול', free_tzintuk_signup: 'הרשמה לצינתוקים חינמיים',
  duplicate_event: 'אירוע כפול (סונן)', no_pin_configured: 'אין PIN מוגדר',
};

/** זמן עתידי: "בעוד 8 דק׳". */
export function until(iso: string | null | undefined): string {
  if (!iso) return '';
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (min <= 0) return 'עכשיו';
  return min < 60 ? `בעוד ${min} דק׳` : `בעוד ${Math.round(min / 60)} שעות`;
}
