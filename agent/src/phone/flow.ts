// זרימת השיחה בטלפון (אפיון 3 ו-5): PIN, מקשים 1/2/3/4/5/6/7/9/0, עמודים, פרויקט חדש, הקלטה ואישור תמלול, אישורים ושאלות.
//
// ימות שולחת בכל בקשה את כל הערכים שנקלטו מתחילת השיחה. לכן כל קליטה מקבלת שם ייחודי לפי מספר צעד
// (v1, v2, ...), והקלט הנוכחי הוא q[`v${step}`]. בקשה חוזרת עם אותו צעד ואותו ערך מקבלת את אותה תשובה
// (מניעת כפילויות: אירוע כפול לא יוצר משימה נוספת).
import type { Task, Project, Conversation, PermissionRequest } from '@claude-phone/shared';
import type { DecideResult } from '../claude/broker.ts';
import type { ConversationEntry } from '../history/conversations.ts';
import { r, san, EMPTY_VALUE, type YemotResponse, type YemotQuery } from './response.ts';
import { VOICES, MODELS, EFFORTS, READBACKS, STT_ENGINES, type Store, type EditMode, type ModelChoice, type EffortChoice, type ReadbackChoice } from '../store/db.ts';
import { cleanForSpeech } from '../claude/runner.ts';

const MODE_NAMES: Record<EditMode, string> = {
  readonly: 'כרגע קלוד במצב קריאה בלבד',
  edit: 'כרגע קלוד עורך קבצים, ופקודות מגיעות אליך לאישור',
  auto: 'כרגע קלוד מאשר לעצמו את כל הפעולות',
};
import type { Tasks } from '../store/tasks.ts';
import { verifyPin, PinLockout } from '../util/pin.ts';
import { log, logError } from '../log.ts';
import { spokenHebrew, keyWord, shortTitle } from './translit.ts';

export interface FlowDeps {
  /** הודעה חד-פעמית אחרי עדכון גרסה (מוקראת בכניסה, ורק פעם אחת). */
  whatsNew?: () => string | null;
  store: Store;
  tasks: Tasks;
  allowedPhones: () => string[];
  pinHash: () => string | null;
  lockout: PinLockout;
  limits: { recordSeconds: number; transcriptConfirmSeconds: number; queuedTaskHours: number; waitOnCallMinutes: number };
  /** מוריד הקלטה מימות ומתמלל. מחזיר טקסט (ריק אם לא זוהה דיבור). */
  transcribeRecording: (yemotPath: string, taskId: string) => Promise<string>;
  /** יוצר פרויקט חדש בתוך תיקיית-האם. זורק שגיאה עם הודעה בעברית אם השם לא תקין או קיים. */
  createProject: (name: string) => Promise<Project>;
  /** מעיר את מנוע הביצוע אחרי שמשימה נכנסה לתור. */
  kickWorker: () => void;
  /** בקשת עצירה למשימה רצה. */
  requestStop: (taskId: string, actor: string) => void;
  /** מחיל קול ומהירות הקראה על השלוחה בימות. */
  applyVoice: (voice: string, rate: number) => Promise<void>;
  /** החלטה על בקשת הרשאה או שאלה (המתווך). */
  decide: (id: string, d: { decision: 'allow' } | { decision: 'deny'; explanation?: string } | { decision: 'answer'; answers: Record<string, string> }, via: 'phone') => DecideResult;
  /** מוריד הקלטה מימות ומתמלל, בלי לקשור אותה למשימה (הסבר או תשובה בקול). */
  transcribeAudio: (yemotPath: string) => Promise<string>;
  /** רשימת השיחות המאוחדת (שלב 3: כולל היסטוריית Claude). בלי זה: רק שיחות מהמאגר. */
  conversations?: () => ConversationEntry[];
  /** שיחות Claude Code פתוחות במחשב עם ערוץ הטלפון (שלב 5). projectId: הפרויקט של התיקייה (נוצר אם צריך). */
  liveSessions?: () => { id: string; name: string; projectId: string }[];
  /** מקש 8: כל השיחות במחשב, גם מחוץ לפרויקטים. */
  allConversations?: () => ConversationEntry[];
  /** רישום אוטומטי של תיקיית שיחה מחוץ לפרויקטים (לא מופיעה במקש 3). מחזיר מזהה פרויקט, או זורק שגיאה עם סיבה להקראה. */
  ensureProject?: (folder: string) => string;
  /** התשובה האחרונה של Claude בשיחה (טקסט להקראה), לשיחות שאי אפשר להמשיך. */
  lastAnswer?: (conversationId: string) => string | null;
  /** חיבורי MCP שפתוחים למשימות מהטלפון (שמות להקראה), להודעה בהגדרות. */
  mcpConnections?: () => string[];
  /** אחרי מעבר למנוע תמלול מקומי: טעינת המודל מראש */
  sttChanged?: () => void;
  /** צינתוקים חינמיים: הנתיב של שלוחת ההרשמה (למשל /9/1), והודעה אחרי שהמשתמש הופנה אליה. null: לא מופעל. */
  freeTzintuk?: () => { folder: string; onRedirect: () => void } | null;
  /** מאגרי GitHub כפרויקטים (טוקן בלוח הבקרה). בלי זה, או בלי טוקן: אין אפשרות GitHub בתפריט. */
  github?: { enabled: () => boolean; list: () => Promise<{ fullName: string; spokenName: string }[]>; open: (fullName: string) => Promise<Project>;
    /** מאגרים מהירים (מההגדרות): מקשים 4 עד 9 בתפריט הפרויקט החדש פותחים אותם ישירות, בלי לעבור על הרשימה. */
    quick?: () => { fullName: string; spokenName: string }[] };
  /** שיחות ענן: רשימה ושליחת הודעה (חד-כיוונית). בלי זה, או ברשימה ריקה: אין אפשרות ענן. */
  cloud?: { list: () => { id: string; name: string }[]; send: (id: string, text: string) => Promise<void> };
  /** עיכוב (נדרס בבדיקות). */
  sleep?: (ms: number) => Promise<void>;
}

type Target = { kind: 'new'; projectId: string } | { kind: 'continue'; conversationId: string; projectId: string };

type Screen =
  | 'pin' | 'main'
  | 'convList' | 'projList' | 'liveList'
  | 'newProjMode' | 'newProjName' | 'newProjConfirm' | 'ghList' | 'ghOpening' | 'newProjRecorded' | 'newProjTranscribing' | 'moreMenu' | 'cloudList' | 'cloudRecorded' | 'cloudTranscribing' | 'cloudConfirm'
  | 'record' | 'transcribing' | 'confirmTranscript'
  | 'waiting'
  | 'settings' | 'settingsVoice' | 'settingsRate' | 'settingsMode' | 'settingsModel' | 'taskModel' | 'settingsEffort' | 'settingsReadback' | 'settingsStt'
  | 'results' | 'resultMenu'
  | 'activeList' | 'activeMenu' | 'stopConfirm'
  | 'approval' | 'approvalText' | 'explainRecorded' | 'explainTranscribing' | 'explainConfirm'
  | 'help';

interface CallState {
  callId: string; phone: string; ext: string;
  step: number;                 // מספר הקליטה הנוכחית (שם המשתנה בימות)
  screen: Screen;
  authed: boolean;
  page: number;
  target?: Target;
  taskId?: string;              // המשימה בטיוטה / שנשלחה
  transcript?: string;
  transcribeDone?: boolean;
  transcribeError?: string;
  newProjName?: string;
  resultIds?: string[];         // תוצאות להשמעה בתפריט 4
  resultIdx?: number;
  resultMode?: ReadbackChoice;  // מה מוקרא בשיחה הזו: התשובה המלאה או הסיכום (מקש 4 מחליף; מתחיל מההגדרה)
  activeIds?: string[];
  selectedTaskId?: string;
  waitStart?: number;
  confirmStart?: number;
  lastInputStep?: number;       // הצעד והערך של הקלט האחרון שטופל (מניעת כפילויות)
  lastInputValue?: string;
  lastResponse?: string;
  recCount: number;
  recFile?: string;
  newProjByKeyboard?: boolean;
  ghRepos?: { fullName: string; spokenName: string }[];   // תמונת מצב של רשימת המאגרים שהוקראה
  projVoice?: { file: string; text?: string; error?: string; done: boolean };
  cloudSel?: { id: string; name: string; file?: string; text?: string; error?: string; done: boolean };
  ghJob?: { done: boolean; error?: string; project?: Project; since: number };
  liveIds?: string[];
  convIds?: string[];           // תמונת מצב של רשימת השיחות שהוקראה (כדי שהבחירה תתאים למה שנשמע)
  convAll?: boolean;            // מקש 8: כל השיחות במחשב (ולא רק של פרויקטים בטלפון)
  approvalId?: string;          // הבקשה שמוצגת כעת (מקש 6 / בכניסה / בזמן המתנה)
  approvalQIdx?: number;        // אינדקס השאלה הנוכחית (Claude יכול לשאול עד 4 שאלות בבקשה אחת)
  approvalAnswers?: Record<string, string>;
  approvalReturn?: 'main' | 'waiting';
  skippedApprovals?: string[];
  explain?: { text?: string; done: boolean; error?: string; file: string; mode: 'deny' | 'answer' };
  expectInput: boolean;         // האם התשובה האחרונה ביקשה קליטה (אחרת זו לולאת המתנה, והערכים הישנים אינם קלט חדש)
}

const PAGE = 9;
/** ברשימות שבהן מקש 1 הוא "חדש" (פרויקטים, שיחות): שמונה פריטים בעמוד, במקשים 2 עד 9. */
const ITEMS = PAGE - 1;

export class PhoneFlow {
  private calls = new Map<string, CallState>();
  private sleep: (ms: number) => Promise<void>;

  constructor(private d: FlowDeps) {
    this.sleep = d.sleep ?? (ms => new Promise(res => setTimeout(res, ms)));
  }

  /** נקודת הכניסה: כל בקשה מימות. מחזיר את גוף התשובה. */
  async handle(q: YemotQuery): Promise<string> {
    const callId = q.ApiCallId || '';
    const phone = (q.ApiPhone || '').trim();
    if (!callId) return r().hangup().toString();

    if (q.hangup === 'yes') { this.onHangup(callId); return ''; }

    // סינון מספר: שכבת סינון בלבד (אפיון 5). לא חושפים אם המספר קיים.
    const allowed = this.d.allowedPhones();
    if (!allowed.includes(phone)) {
      this.d.store.phoneLog({ callId, phone, kind: 'rejected_number' });
      return r().say('מספר לא מורשה').hangup().toString();
    }

    let c = this.calls.get(callId);
    if (!c) {
      c = { callId, phone, ext: (q.ApiExtension || '').replace(/^\/+/, ''), step: 0, screen: 'pin', authed: false, page: 0, recCount: 0, expectInput: false };
      this.calls.set(callId, c);
      this.d.store.phoneLog({ callId, phone, kind: 'call_start', detail: c.ext });
    }

    // בקשה כפולה: ימות שלחה שוב את הקלט הקודם (אותו צעד ואותו ערך) ועדיין אין קלט לצעד הנוכחי.
    // מחזירים את אותה תשובה בלי לבצע שוב (אירוע כפול לא יוצר משימה נוספת).
    if (c.expectInput && q[`v${c.step}`] === undefined && c.lastInputStep !== undefined
        && q[`v${c.lastInputStep}`] === c.lastInputValue && c.lastResponse !== undefined) {
      this.d.store.phoneLog({ callId, phone, kind: 'duplicate_event', detail: `v${c.lastInputStep}` });
      return c.lastResponse;
    }
    const raw = c.expectInput ? q[`v${c.step}`] : undefined;
    // סולמית בלי ספרות (עמוד הבא) מגיעה כ-EMPTY_VALUE; בתוך הזרימה היא ערך ריק
    const input = raw === EMPTY_VALUE || raw === 'None' ? '' : raw;
    const inputStep = c.step;
    const eventKey = `${callId}:${inputStep}:${input ?? ''}`;

    let res: string;
    try {
      res = (await this.dispatch(c, input)).toString();
    } catch (e) {
      logError('phone', e, `call ${callId} screen ${c.screen}`);
      res = r().say('אירעה תקלה. חוזרים לתפריט הראשי').toString() + '&' + this.mainMenu(c).toString();
    }
    c.expectInput = res.includes(`=v${c.step},`);
    if (input !== undefined) {
      c.lastInputStep = inputStep; c.lastInputValue = raw; c.lastResponse = res;
      this.d.store.savePhoneEvent(eventKey, callId, res);
    }
    return res;
  }

  private onHangup(callId: string): void {
    const c = this.calls.get(callId);
    this.calls.delete(callId);
    if (!c) return;
    this.d.store.phoneLog({ callId, phone: c.phone, kind: 'hangup', detail: c.screen });
    // ניתוק אחרי שהתוצאה הוקראה עד הסוף (ימות כבר עברה לשאלת התפריט שאחריה): התוצאה נשמעה
    if (c.screen === 'resultMenu' && c.selectedTaskId) this.d.tasks.markHeard(c.selectedTaskId);
    // ניתוק לפני אישור השליחה אינו מפעיל משימה (אפיון 3)
    if (c.taskId) {
      const t = this.d.tasks.get(c.taskId);
      if (t && (t.state === 'draft' || t.state === 'awaiting_transcript')) this.d.tasks.transition(t.id, 'cancelled', 'phone', 'ניתוק לפני אישור השליחה');
    }
  }

  /** שם המשתנה לקליטה הבאה. כל קליטה מקדמת את הצעד. */
  private next(c: CallState): string { c.step += 1; return `v${c.step}`; }

  // ===================== ניתוב לפי מסך =====================

  private async dispatch(c: CallState, input: string | undefined): Promise<YemotResponse> {
    if (!c.authed && c.screen !== 'pin') c.screen = 'pin';
    switch (c.screen) {
      case 'pin': return this.onPin(c, input);
      case 'main': return this.onMain(c, input);
      case 'convList': return this.onConvList(c, input);
      case 'liveList': return this.onLiveList(c, input);
      case 'projList': return this.onProjList(c, input);
      case 'newProjMode': return this.onNewProjMode(c, input);
      case 'newProjName': return this.onNewProjName(c, input);
      case 'newProjConfirm': return this.onNewProjConfirm(c, input);
      case 'newProjRecorded': return this.onNewProjRecorded(c);
      case 'newProjTranscribing': return this.onNewProjTranscribing(c);
      case 'moreMenu': return this.onMoreMenu(c, input);
      case 'cloudList': return this.onCloudList(c, input);
      case 'cloudRecorded': return this.onCloudRecorded(c);
      case 'cloudTranscribing': return this.onCloudTranscribing(c);
      case 'cloudConfirm': return this.onCloudConfirm(c, input);
      case 'ghList': return this.onGhList(c, input);
      case 'ghOpening': return this.onGhOpening(c);
      case 'record': return this.onRecorded(c, input);
      case 'transcribing': return this.onTranscribing(c);
      case 'confirmTranscript': return this.onConfirmTranscript(c, input);
      case 'settings': return this.onSettings(c, input);
      case 'settingsVoice': return this.onSettingsVoice(c, input);
      case 'settingsRate': return this.onSettingsRate(c, input);
      case 'settingsMode': return this.onSettingsMode(c, input);
      case 'settingsModel': return this.onSettingsModel(c, input);
      case 'taskModel': return this.onTaskModel(c, input);
      case 'settingsEffort': return this.onSettingsEffort(c, input);
      case 'settingsReadback': return this.onSettingsReadback(c, input);
      case 'settingsStt': return this.onSettingsStt(c, input);
      case 'waiting': return this.onWaiting(c, input);
      case 'results': return this.onResults(c);
      case 'resultMenu': return this.onResultMenu(c, input);
      case 'activeList': return this.onActiveList(c, input);
      case 'activeMenu': return this.onActiveMenu(c, input);
      case 'stopConfirm': return this.onStopConfirm(c, input);
      case 'approval': return this.onApproval(c, input);
      case 'approvalText': return this.onApprovalText(c, input);
      case 'explainRecorded': return this.onExplainRecorded(c);
      case 'explainTranscribing': return this.onExplainTranscribing(c);
      case 'explainConfirm': return this.onExplainConfirm(c, input);
      case 'help': return this.onHelp(c, input);
    }
  }

  // ===================== כניסה ו-PIN =====================

  private onPin(c: CallState, input: string | undefined): YemotResponse {
    const hash = this.d.pinHash();
    if (!hash) {
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'no_pin_configured' });
      return r().say('המערכת עדיין לא הוגדרה. יש להגדיר קוד במחשב').hangup();
    }
    if (this.d.lockout.isLocked(c.phone)) {
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'pin_locked' });
      return r().say('הכניסה נחסמה זמנית. נסה שוב מאוחר יותר').hangup();
    }
    if (input === undefined) {
      return r().readDigits('שלום. הקש את הקוד האישי וסולמית', this.next(c), { max: 8, min: 4, timeout: 20 });
    }
    if (input && verifyPin(input, hash)) {
      c.authed = true;
      this.d.lockout.reset(c.phone);
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'pin_ok' });
      // בקשות ממתינות מוצגות מיד אחרי הכניסה (אפיון 3: "עדכון קצר על תוצאות ואישורים ממתינים")
      const pending = this.pendingFor(c);
      if (pending.length) { c.approvalReturn = 'main'; return this.presentApproval(c, pending[0], this.loginSummary()); }
      return this.mainMenu(c, [this.d.whatsNew?.(), this.loginSummary()].filter(Boolean).join('. '));
    }
    this.d.lockout.recordFailure(c.phone);
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'pin_fail' });
    if (this.d.lockout.isLocked(c.phone)) return r().say('הכניסה נחסמה זמנית').hangup();
    return r().readDigits('הקוד שגוי. הקש שוב את הקוד וסולמית', this.next(c), { max: 8, min: 4, timeout: 20 });
  }

  /** עדכון קצר בכניסה: תוצאות שלא נשמעו ומשימות פעילות. */
  private loginSummary(): string {
    const unheard = this.d.tasks.listUnheardResults().length;
    const active = this.d.tasks.listActive().length;
    const parts: string[] = [];
    const mode = this.d.store.getSettings().editMode;
    if (mode === 'readonly') parts.push('שים לב, המערכת במצב קריאה בלבד');
    if (mode === 'auto') parts.push('שים לב, קלוד מאשר לעצמו את כל הפעולות');
    if (unheard) parts.push(unheard === 1 ? 'יש תוצאה אחת חדשה' : `יש ${unheard} תוצאות חדשות`);
    if (active) parts.push(active === 1 ? 'משימה אחת פעילה' : `${active} משימות פעילות`);
    const pending = this.d.store.pendingPermissionRequests().length;
    if (pending) parts.push(pending === 1 ? 'יש בקשה אחת שממתינה לך' : `יש ${pending} בקשות שממתינות לך`);
    return parts.join('. ');
  }

  // ===================== תפריט ראשי =====================

  private mainMenu(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'main'; c.page = 0;
    const res = r();
    if (prefix) res.say(prefix);
    const pending = this.d.store.pendingPermissionRequests().length ? 'לבקשות שממתינות לך 6. ' : '';
    const live = this.d.liveSessions?.().length ? 'לשיחה הפתוחה במחשב 1. ' : '';
    const more = this.d.allConversations ? (this.hasCloud() ? 'לשיחות נוספות, ושיחות ענן 8. ' : 'לכל השיחות במחשב 8. ') : '';
    return res.readDigits(`${pending}${live}להמשך שיחה 2. לשיחה חדשה 3. לתוצאות 4. למשימות פעילות 5. להגדרות 7. ${more}להסבר על המערכת 9. לסיום 0`, this.next(c), { timeout: 20 });
  }

  private onMain(c: CallState, input: string | undefined): YemotResponse {
    switch (input) {
      case '1': return this.liveListScreen(c);
      case '2': c.page = 0; c.convAll = false; return this.convListScreen(c);
      case '8':
        if (!this.d.allConversations) return this.mainMenu(c, 'בחירה לא תקינה');
        if (this.hasCloud()) return this.moreMenuScreen(c);
        c.page = 0; c.convAll = true; return this.convListScreen(c);
      case '3': c.page = 0; return this.projListScreen(c);
      case '4': return this.resultsScreen(c);
      case '5': return this.activeListScreen(c);
      case '6': {
        c.skippedApprovals = [];
        const pending = this.pendingFor(c);
        if (!pending.length) return this.mainMenu(c, 'אין בקשות שממתינות לך');
        c.approvalReturn = 'main';
        return this.presentApproval(c, pending[0]);
      }
      case '7': return this.settingsScreen(c);
      case '9': return this.helpScreen(c);
      case '0': return r().say('להתראות').hangup();
      default: return this.mainMenu(c, 'בחירה לא תקינה');
    }
  }

  // ===================== 1: שיחה פתוחה במחשב (סשן חי) =====================

  private liveListScreen(c: CallState, prefix = ''): YemotResponse {
    const list = this.d.liveSessions?.() ?? [];
    if (!list.length) return this.mainMenu(c, 'אין כרגע שיחה של Claude Code שפתוחה במחשב עם חיבור לטלפון');
    if (list.length === 1) return this.chooseLive(c, list[0]);
    c.screen = 'liveList';
    c.liveIds = list.map(l => l.id);
    const res = r();
    if (prefix) res.say(prefix);
    res.say(list.slice(0, 9).map((l, i) => `ל${l.name} הקש ${i + 1}`).join('. '));
    return res.readDigits('בחר שיחה. לחזרה 0', this.next(c), { timeout: 20, min: 0 });
  }

  private onLiveList(c: CallState, input: string | undefined): YemotResponse {
    if (!input || input === '0') return this.mainMenu(c);
    const id = c.liveIds?.[Number(input) - 1];
    const live = id ? this.d.liveSessions?.().find(l => l.id === id) : undefined;
    if (!live) return this.liveListScreen(c, 'השיחה כבר לא פתוחה, או בחירה לא תקינה');
    return this.chooseLive(c, live);
  }

  private chooseLive(c: CallState, live: { id: string; name: string; projectId: string }): YemotResponse {
    c.target = { kind: 'continue', conversationId: `live:${live.id}`, projectId: live.projectId };
    return this.recordScreen(c, `הודעה לשיחה הפתוחה במחשב, ב${live.name}. Claude יקבל אותה ישירות בשיחה.`);
  }

  // ===================== 2: המשך שיחה קודמת =====================

  /** רשימת השיחות לטלפון: מהאינדקס המאוחד (כולל Desktop), או מהמאגר בלבד אם לא הוגדר אינדקס. */
  private phoneConversations(): ConversationEntry[] {
    if (this.d.conversations) return this.d.conversations();
    const projects = new Map(this.d.store.listProjects(true).map(p => [p.id, p]));
    return this.d.store.listConversations(200).filter(cv => projects.has(cv.projectId)).map(cv => ({
      id: cv.id, projectId: cv.projectId, projectName: projects.get(cv.projectId)!.spokenName, title: cv.title, source: 'phone' as const,
      createdAt: cv.createdAt, lastActiveAt: cv.lastActiveAt, active: !!this.d.store.conversationLockedBy(cv.id),
      canContinue: true, blockedReason: null, inHistory: false,
    }));
  }

  private listedConversations(c: CallState): ConversationEntry[] {
    return c.convAll && this.d.allConversations ? this.d.allConversations() : this.phoneConversations();
  }

  private convListScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'convList';
    const all = this.listedConversations(c);
    c.convIds = all.map(cv => cv.id);
    if (!all.length) return this.mainMenu(c, c.convAll ? 'לא נמצאו שיחות במחשב' : 'אין עדיין שיחות קודמות. לפתיחת שיחה חדשה הקש 3 בתפריט');
    const page = all.slice(c.page * ITEMS, c.page * ITEMS + ITEMS);
    if (!page.length) { c.page = 0; return this.convListScreen(c, 'אין עוד שיחות. חוזרים לעמוד הראשון'); }
    // "שיחה חדשה" תמיד מקש 1 (לבקשת המשתמש, 16.10); השיחות ממקש 2
    const lines = ['לשיחה חדשה הקש אחד', ...page.map((cv, i) => {
      const from = cv.source === 'desktop' ? ' מדסקטופ' : cv.source === 'cli' ? ' מהטרמינל' : cv.source === 'vscode' ? ' מויזואל סטודיו' : cv.source === 'cowork' ? ' מקוורק' : '';
      const state = cv.active ? ' פעילה כרגע' : !cv.canContinue ? ' לא זמינה להמשך' : '';
      // המספר בסוף ובמילים, והכותרת מקוצרת ובעברית: אחרת הקול עובר לאנגלית וקשה לדעת איזה מקש שייך לאיזו שיחה
      return `ל${spokenHebrew(cv.projectName ?? 'פרויקט לא ידוע')}. ${shortTitle(cv.title)}${from}. ${spokenAgo(cv.lastActiveAt)}${state}. הקש ${keyWord(i + 2)}`;
    })];
    const more = all.length > (c.page + 1) * ITEMS ? '. לעמוד הבא הקש סולמית' : '';
    // הכל בתוך read: הקשה באמצע ההקראה (גם באמצע "התשובה האחרונה" של שיחה שאי אפשר להמשיך) נקלטת מיד
    return r().readAfter([...(prefix ? [prefix] : []), lines.join('. '), `בחר שיחה${more}. לחזרה 0`], this.next(c), { timeout: 20, min: 0 });
  }

  private onConvList(c: CallState, input: string | undefined): YemotResponse {
    if (input === '0') return this.mainMenu(c);
    if (!input) { c.page += 1; return this.convListScreen(c); }
    if (input === '1') { c.page = 0; return this.projListScreen(c); }
    const id = c.convIds?.[c.page * ITEMS + Number(input) - 2];
    let conv = id ? this.listedConversations(c).find(cv => cv.id === id) : undefined;
    if (!conv) return this.convListScreen(c, 'בחירה לא תקינה');
    // שיחה מחוץ לפרויקטים: התיקייה שלה נרשמת אוטומטית, והשיחה ממשיכה במקום שבו היא נמצאת
    if (!conv.projectId && conv.autoFolder && conv.canContinue && this.d.ensureProject) {
      try { conv = { ...conv, projectId: this.d.ensureProject(conv.autoFolder) }; }
      catch (e) { return this.convListScreen(c, `${e instanceof Error ? e.message : 'לא ניתן להמשיך את השיחה'}. בחר שיחה אחרת`); }
    }
    const proj = conv.projectId ? this.d.store.getProject(conv.projectId) : null;
    if (!proj || !proj.phoneEnabled) return this.convListScreen(c, 'הפרויקט של השיחה הזו אינו זמין בטלפון');
    // שיחה שלנו שרצה עכשיו: ההודעה תמתין בתור. שיחה חיצונית פעילה או שלא אומתה: לא נפתחת ברקע (אפיון 4).
    const ours = conv.source === 'phone';
    if (!ours && !conv.canContinue) {
      // אי אפשר להמשיך: מקריאים את הסיבה ואת התשובה האחרונה בשיחה, וחוזרים לרשימה
      const last = this.d.lastAnswer?.(conv.id);
      const tail = last ? `. התשובה האחרונה בשיחה: ${last}` : '';
      return this.convListScreen(c, `${conv.blockedReason ?? 'השיחה לא זמינה להמשך'}${tail}. בחר שיחה אחרת`);
    }
    // שיחת Cowork לא נרשמת במאגר כשיחה שלנו: היא נשארת של Desktop
    if (!ours && conv.source !== 'cowork') this.d.store.upsertConversation({ id: conv.id, projectId: proj.id, title: conv.title, source: conv.source === 'desktop' ? 'desktop' : 'unknown' });
    c.target = { kind: 'continue', conversationId: conv.id, projectId: proj.id };
    const note = ours && conv.active ? 'השיחה בעבודה כרגע. ההודעה תמתין בתור עד שתסתיים. ' : '';
    return this.recordScreen(c, `${note}המשך השיחה ${conv.title} בפרויקט ${proj.spokenName}.`);
  }

  // ===================== 8: שיחות נוספות (כל השיחות במחשב, שיחות ענן) =====================

  private hasCloud(): boolean { return !!this.d.cloud && this.d.cloud.list().length > 0; }

  private moreMenuScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'moreMenu';
    const res = r();
    if (prefix) res.say(prefix);
    return res.readDigits('לכל השיחות במחשב 1. לשליחת הודעה לשיחת ענן 2. לחזרה 0', this.next(c), { timeout: 20 });
  }

  private onMoreMenu(c: CallState, input: string | undefined): YemotResponse {
    if (input === '0') return this.mainMenu(c);
    if (input === '1') { c.page = 0; c.convAll = true; return this.convListScreen(c); }
    if (input === '2' && this.hasCloud()) { c.page = 0; return this.cloudListScreen(c); }
    return this.moreMenuScreen(c, 'בחירה לא תקינה');
  }

  private cloudListScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'cloudList';
    const all = this.d.cloud?.list() ?? [];
    if (!all.length) return this.mainMenu(c, 'אין שיחות ענן שמורות');
    let page = all.slice(c.page * PAGE, c.page * PAGE + PAGE);
    if (!page.length) { c.page = 0; page = all.slice(0, PAGE); }
    const more = all.length > (c.page + 1) * PAGE ? '. לעמוד הבא הקש סולמית' : '';
    return r().readAfter([...(prefix ? [prefix] : []), page.map((x, i) => `ל${spokenHebrew(x.name)} הקש ${keyWord(i + 1)}`).join('. '), `בחר${more}. לחזרה 0`], this.next(c), { timeout: 20, min: 0 });
  }

  private onCloudList(c: CallState, input: string | undefined): YemotResponse {
    if (input === '0') return this.moreMenuScreen(c);
    if (!input) { c.page += 1; return this.cloudListScreen(c); }
    const s = /^[1-9]$/.test(input) ? (this.d.cloud?.list() ?? [])[c.page * PAGE + Number(input) - 1] : undefined;
    if (!s) return this.cloudListScreen(c, 'בחירה לא תקינה');
    return this.cloudRecordScreen(c, { id: s.id, name: s.name, done: false }, `הודעה לשיחת ${s.name}`);
  }

  private cloudRecordScreen(c: CallState, sel: NonNullable<CallState['cloudSel']>, prefix = ''): YemotResponse {
    c.recCount += 1;
    const file = `cp-${c.callId.replace(/[^A-Za-z0-9]/g, '').slice(-10)}-c${c.recCount}`;
    c.cloudSel = { id: sel.id, name: sel.name, file: `/${c.ext}/${file}.wav`, done: false };
    c.screen = 'cloudRecorded';
    const res = r();
    if (prefix) res.say(prefix);
    return res.record('הקלט את ההודעה. בסיום הקש סולמית', this.next(c), `/${c.ext}`, file);
  }

  private onCloudRecorded(c: CallState): YemotResponse {
    const sel = c.cloudSel!;
    this.d.transcribeAudio(sel.file!)
      .then(t => { sel.text = t.trim(); sel.done = true; })
      .catch(e => { logError('stt', e, 'cloud'); sel.error = 'התמלול נכשל'; sel.done = true; });
    c.screen = 'cloudTranscribing';
    return r().say('מתמלל').goto(`/${c.ext}`);
  }

  private async onCloudTranscribing(c: CallState): Promise<YemotResponse> {
    const sel = c.cloudSel!;
    const deadline = Date.now() + 9000;
    while (!sel.done && Date.now() < deadline) await this.sleep(250);
    if (!sel.done) return r().goto(`/${c.ext}`);
    if (sel.error || !sel.text) return this.cloudRecordScreen(c, sel, `${sel.error ?? 'לא זוהה דיבור'}. הקלט שוב.`);
    c.screen = 'cloudConfirm';
    return r().say(`התמלול: ${sel.text}`).readDigits(`ליעד: שיחת ${sel.name}. לשליחה הקש 1. להקלטה מחדש 2. לביטול 3`, this.next(c), { timeout: 30 });
  }

  private async onCloudConfirm(c: CallState, input: string | undefined): Promise<YemotResponse> {
    const sel = c.cloudSel;
    if (!sel?.text) return this.mainMenu(c);
    if (input === '2') return this.cloudRecordScreen(c, sel);
    if (input === '3' || input === '0') { c.cloudSel = undefined; return this.mainMenu(c, 'בוטל'); }
    if (input !== '1') return r().readDigits('לשליחה הקש 1. להקלטה מחדש 2. לביטול 3', this.next(c), { timeout: 30 });
    try {
      await this.d.cloud!.send(sel.id, sel.text);
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'cloud_sent', detail: sel.name });
      c.cloudSel = undefined;
      return this.mainMenu(c, `ההודעה נשלחה לשיחת ${sel.name}. התשובה תופיע בשיחה עצמה`);
    } catch (e) {
      logError('cloud', e, 'send');
      c.cloudSel = undefined;
      return this.mainMenu(c, e instanceof Error && e.message ? e.message : 'השליחה נכשלה');
    }
  }

  // ===================== 3: שיחה חדשה או פרויקט חדש =====================

  /** רשימת הפרויקטים: "פרויקט חדש" הוא תמיד מקש 1 (לבקשת המשתמש, 16.10), והפרויקטים ממקש 2, שמונה בכל עמוד. */
  private projListScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'projList';
    const projects = this.d.store.listMenuProjects();
    const page = projects.slice(c.page * ITEMS, c.page * ITEMS + ITEMS);
    if (!page.length && c.page > 0) { c.page = 0; return this.projListScreen(c, 'אין עוד פרויקטים. חוזרים לעמוד הראשון'); }
    const lines = ['לפרויקט חדש הקש אחד', ...page.map((p, i) => `ל${spokenHebrew(p.spokenName)} הקש ${keyWord(i + 2)}`)];
    const more = projects.length > (c.page + 1) * ITEMS ? '. לעמוד הבא הקש סולמית' : '';
    return r().readAfter([...(prefix ? [prefix] : []), lines.join('. '), `בחר${more}. לחזרה 0`], this.next(c), { timeout: 20, min: 0 });
  }

  private onProjList(c: CallState, input: string | undefined): YemotResponse {
    if (input === '0') return this.mainMenu(c);
    if (!input) { c.page += 1; return this.projListScreen(c); }
    if (input === '1') return this.newProjModeScreen(c);
    const projects = this.d.store.listMenuProjects();
    const proj = projects[c.page * ITEMS + Number(input) - 2];
    if (!proj) return this.projListScreen(c, 'בחירה לא תקינה');
    c.target = { kind: 'new', projectId: proj.id };
    return this.recordScreen(c, `שיחה חדשה בפרויקט ${proj.spokenName}.`);
  }

  private newProjModeScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'newProjMode';
    const res = r();
    if (prefix) res.say(prefix);
    const gh = this.d.github?.enabled() ? ' לבחירת מאגר מ-GitHub הקש 3.' : '';
    const quick = this.quickRepos().map((x, i) => ` ל${spokenHebrew(x.spokenName)} הקש ${keyWord(i + 4)}.`).join('');
    return res.readDigits(`פרויקט חדש. לאמירת השם הקש 1. להקלדת השם במקלדת הקש 2.${gh}${quick} לחזרה 0`, this.next(c), { timeout: 20 });
  }

  private onNewProjMode(c: CallState, input: string | undefined): YemotResponse {
    if (input === '0') { c.page = 0; return this.projListScreen(c); }
    if (input === '3' && this.d.github?.enabled()) return this.ghListScreen(c, true);
    const quick = /^[4-9]$/.test(input ?? '') ? this.quickRepos()[Number(input) - 4] : undefined;
    if (quick) return this.openGhRepo(c, quick);
    c.newProjByKeyboard = input === '2';
    // שם בקול: הקלטה ותמלול במחשב (לא זיהוי הדיבור של ימות, שעולה יחידות)
    if (input === '1') return this.newProjRecordScreen(c);
    c.screen = 'newProjName';
    if (input === '2') return r().readText('הקלד את שם הפרויקט וסולמית', this.next(c), { max: 40 });
    return this.newProjModeScreen(c, 'בחירה לא תקינה');
  }

  /** מאגרים מהירים מההגדרות: עד שישה, במקשים 4 עד 9. רק כשהחיבור ל-GitHub פעיל. */
  private quickRepos(): { fullName: string; spokenName: string }[] {
    return this.d.github?.enabled() ? (this.d.github.quick?.() ?? []).slice(0, 6) : [];
  }

  /** מאגרי GitHub: תשעה בכל עמוד, במקשים 1 עד 9. סולמית לעמוד הבא, 0 לחזרה. */
  private async ghListScreen(c: CallState, fresh = false, prefix = ''): Promise<YemotResponse> {
    c.screen = 'ghList';
    if (fresh) {
      c.page = 0;
      try { c.ghRepos = await this.d.github!.list(); }
      catch (e) { return this.newProjModeScreen(c, e instanceof Error ? e.message : 'לא הצלחתי לקרוא את המאגרים'); }
    }
    const repos = c.ghRepos ?? [];
    if (!repos.length) return this.newProjModeScreen(c, 'לא נמצאו מאגרים בחשבון');
    let page = repos.slice(c.page * PAGE, c.page * PAGE + PAGE);
    if (!page.length) { c.page = 0; page = repos.slice(0, PAGE); }
    const more = repos.length > (c.page + 1) * PAGE ? '. לעמוד הבא הקש סולמית' : '';
    return r().readAfter([...(prefix ? [prefix] : []), page.map((x, i) => `ל${spokenHebrew(x.spokenName)} הקש ${keyWord(i + 1)}`).join('. '), `בחר${more}. לחזרה אפס`], this.next(c), { timeout: 20, min: 0 });
  }

  private async onGhList(c: CallState, input: string | undefined): Promise<YemotResponse> {
    if (input === '0') return this.newProjModeScreen(c);
    if (!input) { c.page += 1; return this.ghListScreen(c); }
    const repo = (c.ghRepos ?? [])[c.page * PAGE + Number(input) - 1];
    if (!repo || !/^[1-9]$/.test(input)) return this.ghListScreen(c, false, 'בחירה לא תקינה');
    return this.openGhRepo(c, repo);
  }

  private openGhRepo(c: CallState, repo: { fullName: string; spokenName: string }): YemotResponse {
    // שכפול יכול להימשך זמן: רץ ברקע, והשיחה ממתינה עם מוזיקה (כמו בתמלול)
    const job: NonNullable<CallState['ghJob']> = { done: false, since: Date.now() };
    c.ghJob = job;
    this.d.github!.open(repo.fullName)
      .then(p => { job.project = p; })
      .catch(e => { job.error = e instanceof Error ? e.message : 'פתיחת המאגר נכשלה'; })
      .finally(() => { job.done = true; });
    c.screen = 'ghOpening';
    return r().say(`פותח את ${spokenHebrew(repo.spokenName)}. בפעם הראשונה זה יכול לקחת כמה דקות`).goto(`/${c.ext}`);
  }

  private async onGhOpening(c: CallState): Promise<YemotResponse> {
    const job = c.ghJob;
    if (!job) return this.newProjModeScreen(c);
    const deadline = Date.now() + 9000;
    while (!job.done && Date.now() < deadline) await this.sleep(250);
    if (!job.done) {
      if (Date.now() - job.since > 10 * 60_000) return this.newProjModeScreen(c, 'פתיחת המאגר נמשכת יותר מדי. בדוק בלוח הבקרה');
      return r().goto(`/${c.ext}`);
    }
    c.ghJob = undefined;
    if (job.error || !job.project) return this.newProjModeScreen(c, job.error ?? 'פתיחת המאגר נכשלה');
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'project_created', detail: `github:${job.project.name}` });
    c.target = { kind: 'new', projectId: job.project.id };
    return this.recordScreen(c, `הפרויקט ${spokenHebrew(job.project.spokenName)} מוכן.`);
  }

  private newProjRecordScreen(c: CallState, prefix = ''): YemotResponse {
    c.recCount += 1;
    const file = `cp-${c.callId.replace(/[^A-Za-z0-9]/g, '').slice(-10)}-n${c.recCount}`;
    c.projVoice = { file: `/${c.ext}/${file}.wav`, done: false };
    c.screen = 'newProjRecorded';
    const res = r();
    if (prefix) res.say(prefix);
    return res.record('אמור את שם הפרויקט אחרי הצליל. בסיום הקש סולמית', this.next(c), `/${c.ext}`, file);
  }

  private onNewProjRecorded(c: CallState): YemotResponse {
    const pv = c.projVoice!;
    this.d.transcribeAudio(pv.file)
      .then(t => { pv.text = t.trim(); pv.done = true; })
      .catch(e => { logError('stt', e, 'newProjName'); pv.error = 'התמלול נכשל'; pv.done = true; });
    c.screen = 'newProjTranscribing';
    return r().say('מתמלל').goto(`/${c.ext}`);
  }

  private async onNewProjTranscribing(c: CallState): Promise<YemotResponse> {
    const pv = c.projVoice!;
    const deadline = Date.now() + 9000;
    while (!pv.done && Date.now() < deadline) await this.sleep(250);
    if (!pv.done) return r().goto(`/${c.ext}`);
    if (pv.error || !pv.text) return this.newProjRecordScreen(c, `${pv.error ?? 'לא זוהה דיבור'}. אמור שוב.`);
    c.projVoice = undefined;
    return this.onNewProjName(c, pv.text);
  }

  private async onNewProjName(c: CallState, input: string | undefined): Promise<YemotResponse> {
    const name = (input || '').trim();
    if (!name) return this.newProjModeScreen(c, 'לא התקבל שם');
    c.newProjName = name;
    // שם שהוקלד במקלדת מדויק: יוצרים מיד. שם שנאמר בקול מוקרא לאישור, כי זיהוי הדיבור עלול לטעות.
    if (c.newProjByKeyboard) return this.onNewProjConfirm(c, '1');
    c.screen = 'newProjConfirm';
    return r().say(`שם הפרויקט: ${name}`).readDigits('לאישור הקש 1. לשם אחר 2. לביטול 3', this.next(c), { timeout: 20 });
  }

  private async onNewProjConfirm(c: CallState, input: string | undefined): Promise<YemotResponse> {
    if (input === '2') return this.newProjModeScreen(c);
    if (input === '3' || input === '0') return this.mainMenu(c, 'בוטל');
    if (input !== '1' || !c.newProjName) return r().readDigits('לאישור הקש 1. לשם אחר 2. לביטול 3', this.next(c), { timeout: 20 });
    try {
      const proj = await this.d.createProject(c.newProjName);
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'project_created', detail: proj.name });
      c.target = { kind: 'new', projectId: proj.id };
      return this.recordScreen(c, `הפרויקט ${proj.spokenName} נוצר.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'יצירת הפרויקט נכשלה';
      return this.newProjModeScreen(c, msg);
    }
  }

  // ===================== הקלטה, תמלול ואישור =====================

  private recordScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'record';
    c.recCount += 1;
    const file = `cp-${c.callId.replace(/[^A-Za-z0-9]/g, '').slice(-10)}-${c.recCount}`;
    c.recFile = `/${c.ext}/${file}.wav`;
    const res = r();
    if (prefix) res.say(prefix);
    return res.record(`הקלט את המשימה אחרי הצליל. בסיום הקש סולמית`, this.next(c), `/${c.ext}`, file);
  }

  private async onRecorded(c: CallState, _input: string | undefined): Promise<YemotResponse> {
    if (!c.target) return this.mainMenu(c);
    const recPath = c.recFile!;
    // יוצרים טיוטה (או מעדכנים את הקיימת בהקלטה מחדש)
    let task = c.taskId ? this.d.tasks.get(c.taskId) : null;
    if (!task || (task.state !== 'draft' && task.state !== 'awaiting_transcript')) {
      task = this.d.tasks.create({
        projectId: c.target.projectId, source: 'phone', phone: c.phone,
        conversationId: c.target.kind === 'continue' ? c.target.conversationId : null,
        recordingPath: recPath, expiresHours: this.d.limits.queuedTaskHours,
      });
      c.taskId = task.id;
    } else {
      if (task.state === 'awaiting_transcript') task = this.d.tasks.transition(task.id, 'draft', 'phone', 'הקלטה מחדש');
      this.d.tasks.patch(task.id, { recordingPath: recPath });
    }
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'recorded', detail: `משימה ${task.num}` });
    c.transcript = undefined; c.transcribeDone = false; c.transcribeError = undefined;
    const taskId = task.id;
    this.d.transcribeRecording(recPath, taskId)
      .then(text => { c.transcript = text.trim(); c.transcribeDone = true; })
      .catch(err => { logError('stt', err, `task ${taskId}`); c.transcribeError = 'התמלול נכשל'; c.transcribeDone = true; });
    c.screen = 'transcribing';
    c.waitStart = Date.now();
    return r().say('ההקלטה התקבלה. מתמלל').goto(`/${c.ext}`);
  }

  /** לולאת המתנה עם מוזיקה עד שהתמלול מוכן (עד 10 שניות לכל סבב, כפי שנבדק בשלב 0). */
  private async onTranscribing(c: CallState): Promise<YemotResponse> {
    const deadline = Date.now() + 9000;
    while (!c.transcribeDone && Date.now() < deadline) await this.sleep(250);
    if (!c.transcribeDone) {
      if (Date.now() - (c.waitStart ?? Date.now()) > 5 * 60_000) return this.recordScreen(c, 'התמלול נמשך יותר מדי. נסה להקליט שוב.');
      return r().goto(`/${c.ext}`);
    }
    if (c.transcribeError) return this.recordScreen(c, `${c.transcribeError}. הקלט שוב.`);
    if (!c.transcript) return this.recordScreen(c, 'לא זוהה דיבור בהקלטה. הקלט שוב.');
    const task = this.d.tasks.get(c.taskId!)!;
    this.d.tasks.transition(task.id, 'awaiting_transcript', 'phone', 'תמלול מוכן', { prompt: c.transcript });
    c.confirmStart = Date.now();
    return this.confirmScreen(c);
  }

  private confirmScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'confirmTranscript';
    const live = c.target?.kind === 'continue' && c.target.conversationId.startsWith('live:');
    // הכול בפקודת קליטה אחת: הקשה באמצע ההקראה נקלטת מיד, ולכן אפשר לשלוח בלי לשמוע את התמלול עד הסוף
    const texts = [
      ...(prefix ? [prefix] : []),
      'לשליחה מיד הקש 1 בכל רגע',
      `התמלול: ${c.transcript}`,
      `${this.targetDescription(c)}. לשליחה הקש 1. להקלטה מחדש 2. לביטול 3${live ? '' : '. לשליחה עם מודל אחר 4'}`,
    ];
    return r().readAfter(texts, this.next(c), { timeout: Math.min(this.d.limits.transcriptConfirmSeconds, 60) });
  }

  private targetDescription(c: CallState): string {
    const t = c.target!;
    const proj = this.d.store.getProject(t.projectId);
    if (t.kind === 'new') return `יעד: שיחה חדשה בפרויקט ${proj?.spokenName ?? ''}`;
    const conv = this.d.store.getConversation(t.conversationId);
    return `יעד: המשך השיחה ${conv?.title ?? ''}`;
  }

  private onConfirmTranscript(c: CallState, input: string | undefined, sentNote = ''): YemotResponse {
    const task = this.d.tasks.get(c.taskId!);
    if (!task || task.state !== 'awaiting_transcript') return this.mainMenu(c, 'הטיוטה כבר אינה זמינה');
    // פקיעת הזמן מבטלת טיוטה רק כשלא הוקש כלום: מי שמקיש 1 (גם אחרי הקראה ארוכה) שולח בכל מקרה
    const expired = !input && Date.now() - (c.confirmStart ?? Date.now()) > this.d.limits.transcriptConfirmSeconds * 1000 * 2;
    if (input === '1') {
      const queued = this.d.tasks.transition(task.id, 'queued', 'phone', 'אושר בטלפון');
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'task_sent', detail: `משימה ${queued.num}` });
      this.d.kickWorker();
      c.screen = 'waiting';
      c.waitStart = Date.now();
      return r().say(`נשלח${sentNote ? ' ' + sentNote : ''}. משימה ${queued.num}. ממתינים לתשובה. אפשר לנתק בכל רגע ולשמוע אותה אחר כך במקש 4`).goto(`/${c.ext}`);
    }
    if (input === '2') return this.recordScreen(c);
    if (input === '4' && !(c.target?.kind === 'continue' && c.target.conversationId.startsWith('live:'))) {
      c.screen = 'taskModel';
      return r().readDigits(this.modelMenuText(), this.next(c), { timeout: 20 });
    }
    if (input === '3' || expired) {
      this.d.tasks.transition(task.id, 'cancelled', 'phone', expired ? 'פג זמן האישור' : 'בוטל בטלפון');
      c.taskId = undefined;
      return this.mainMenu(c, expired ? 'פג זמן האישור. הטיוטה בוטלה' : 'בוטל');
    }
    // אין הקשה (פקיעת זמן ראשונה): תזכורת אחת
    return this.confirmScreen(c, 'לא התקבלה בחירה');
  }

  /** המתנה בקו לסיום המשימה. */
  private async onWaiting(c: CallState, _input: string | undefined): Promise<YemotResponse> {
    const id = c.taskId!;
    const deadline = Date.now() + 9000;
    let t = this.d.tasks.get(id);
    const pendingForTask = () => this.d.store.pendingPermissionRequests().filter(p => p.taskId === id);
    while (t && !isFinal(t) && !pendingForTask().length && Date.now() < deadline) { await this.sleep(500); t = this.d.tasks.get(id); }
    if (!t) return this.mainMenu(c);
    if (isFinal(t)) { c.taskId = undefined; return this.playResult(c, t, true); }
    // Claude ביקש אישור או שאל, והמשתמש עדיין בקו: מציגים מיד
    const req = pendingForTask()[0];
    if (req) { c.approvalReturn = 'waiting'; return this.presentApproval(c, req); }
    if (Date.now() - (c.waitStart ?? 0) > this.d.limits.waitOnCallMinutes * 60_000) {
      c.taskId = undefined;
      return this.mainMenu(c, 'המשימה עדיין רצה. את התשובה תשמע בכניסה הבאה במקש 4');
    }
    return r().goto(`/${c.ext}`);
  }

  // ===================== 4: תוצאות =====================

  private resultsScreen(c: CallState): YemotResponse {
    const unheard = this.d.tasks.listUnheardResults();
    const list = unheard.length ? unheard : [this.d.tasks.latestResult()].filter(Boolean) as Task[];
    if (!list.length) return this.mainMenu(c, 'אין עדיין תוצאות');
    c.resultIds = list.map(t => t.id);
    c.resultIdx = 0;
    const head = unheard.length ? (unheard.length === 1 ? 'תוצאה אחת חדשה' : `${unheard.length} תוצאות חדשות`) : 'אין תוצאות חדשות. התוצאה האחרונה';
    return this.playResult(c, list[0], false, head);
  }

  private onResults(c: CallState): YemotResponse { return this.resultsScreen(c); }

  /**
   * השמעת תוצאה. כל הטקסט נכנס לתוך פקודת read (ולא id_list_message), כדי שהקשה באמצע ההקראה תיקלט מיד:
   * גם תשובה ארוכה של כמה דקות אפשר לקטוע בכל רגע. מה מוקרא (התשובה המלאה או הסיכום) לפי ההגדרה, ומקש 4 מחליף.
   */
  private playResult(c: CallState, t: Task, fromWaiting: boolean, prefix = ''): YemotResponse {
    c.screen = 'resultMenu';
    c.selectedTaskId = t.id;
    if (fromWaiting) { c.resultIds = [t.id]; c.resultIdx = 0; }
    c.resultMode ??= this.d.store.getSettings().readback;
    const proj = this.d.store.getProject(t.projectId);
    const full = c.resultMode === 'full';
    const hasNext = (c.resultIdx ?? 0) + 1 < (c.resultIds?.length ?? 0);
    const texts = [
      ...(prefix ? [prefix] : []),
      `משימה ${t.num}. ${proj?.spokenName ?? ''}. ${full ? fullResultSpeech(t) : resultSpeech(t)}`,
      `לשמיעה חוזרת 1.${hasNext ? ' לתוצאה הבאה 2.' : ''} להמשך השיחה 3. ${full ? 'לסיכום הקצר' : 'לתשובה המלאה'} 4. לתפריט 0`,
    ];
    return r().readAfter(texts, this.next(c), { timeout: 20, min: 0 });
  }

  private onResultMenu(c: CallState, input: string | undefined): YemotResponse {
    const id = c.selectedTaskId!;
    const t = this.d.tasks.get(id);
    // הגיע לכאן אחרי ההשמעה ובחר משהו (או שההקראה הסתיימה ולא הוקש כלום): התוצאה נשמעה (אפיון 3)
    if (t && input !== undefined) this.d.tasks.markHeard(id);
    if (!t) return this.mainMenu(c);
    if (input === '1') return this.playResult(c, t, false);
    if (input === '4') {
      c.resultMode = c.resultMode === 'full' ? 'summary' : 'full';
      return this.playResult(c, t, false);
    }
    // ההקראה הסתיימה ולא הוקש כלום: לא חוזרים על הכל, אלא לתפריט
    if (input === '' || input === EMPTY_VALUE) return this.mainMenu(c, 'לא התקבלה בחירה');
    if (input === '2') {
      const nextIdx = (c.resultIdx ?? 0) + 1;
      const nextId = c.resultIds?.[nextIdx];
      const nt = nextId ? this.d.tasks.get(nextId) : null;
      if (!nt) return this.mainMenu(c, 'אין עוד תוצאות');
      c.resultIdx = nextIdx;
      return this.playResult(c, nt, false);
    }
    if (input === '3' && t.conversationId) {
      const proj = this.d.store.getProject(t.projectId);
      if (proj?.phoneEnabled) {
        c.target = { kind: 'continue', conversationId: t.conversationId, projectId: proj.id };
        c.taskId = undefined;
        return this.recordScreen(c, 'המשך השיחה.');
      }
    }
    if (input === undefined) return this.playResult(c, t, false);
    return this.mainMenu(c);
  }

  // ===================== 5: משימות פעילות =====================

  private activeListScreen(c: CallState, prefix = ''): YemotResponse {
    const active = this.d.tasks.listActive();
    if (!active.length) return this.mainMenu(c, (prefix ? prefix + '. ' : '') + 'אין משימות פעילות');
    c.screen = 'activeList';
    c.activeIds = active.slice(0, PAGE).map(t => t.id);
    const res = r();
    if (prefix) res.say(prefix);
    res.say(active.slice(0, PAGE).map((t, i) => `${i + 1}. משימה ${t.num}. ${stateSpeech(t)}`).join('. '));
    return res.readDigits('בחר משימה. לחזרה 0', this.next(c), { timeout: 20 });
  }

  private onActiveList(c: CallState, input: string | undefined): YemotResponse {
    if (input === '0' || !input) return this.mainMenu(c);
    const id = c.activeIds?.[Number(input) - 1];
    const t = id ? this.d.tasks.get(id) : null;
    if (!t) return this.activeListScreen(c, 'בחירה לא תקינה');
    c.selectedTaskId = t.id;
    c.screen = 'activeMenu';
    const proj = this.d.store.getProject(t.projectId);
    return r().say(`משימה ${t.num}. ${proj?.spokenName ?? ''}. ${stateSpeech(t)}. ${t.prompt.slice(0, 200)}`)
      .readDigits('לבקשת עצירה הקש 9. לחזרה 0', this.next(c), { timeout: 20 });
  }

  private onActiveMenu(c: CallState, input: string | undefined): YemotResponse {
    if (input === '9') {
      c.screen = 'stopConfirm';
      return r().readDigits('עצירה אינה מחזירה קבצים למצב קודם. לאישור העצירה הקש 1. לביטול 0', this.next(c), { timeout: 20 });
    }
    return this.activeListScreen(c);
  }

  private onStopConfirm(c: CallState, input: string | undefined): YemotResponse {
    if (input === '1' && c.selectedTaskId) {
      this.d.requestStop(c.selectedTaskId, 'phone');
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'stop_requested', detail: c.selectedTaskId });
      return this.mainMenu(c, 'בקשת העצירה נשלחה. המצב יתעדכן כשהעבודה תיעצר בפועל');
    }
    return this.activeListScreen(c);
  }

  // ===================== 6: אישורים ושאלות (שלב 2) =====================

  /** בקשות פתוחות שלא דולגו בשיחה הזו. */
  private pendingFor(c: CallState): PermissionRequest[] {
    return this.d.store.pendingPermissionRequests().filter(p => !(c.skippedApprovals ?? []).includes(p.id));
  }

  private isQuestion(req: PermissionRequest): boolean { return req.toolName === 'AskUserQuestion'; }

  private questionsOf(req: PermissionRequest): { question: string; options: { label: string; description?: string }[] }[] {
    return ((req.input.questions as any[]) ?? []).map(q => ({ question: String(q.question ?? ''), options: (q.options ?? []).map((o: any) => ({ label: String(o.label ?? ''), description: o.description })) }));
  }

  private presentApproval(c: CallState, req: PermissionRequest, prefix = ''): YemotResponse {
    c.screen = 'approval';
    if (c.approvalId !== req.id) { c.approvalId = req.id; c.approvalQIdx = 0; c.approvalAnswers = {}; }
    const t = this.d.tasks.get(req.taskId);
    const proj = this.d.store.getProject(req.projectId);
    const head = `משימה ${t?.num ?? ''} בפרויקט ${proj?.spokenName ?? ''}`;
    const res = r();
    if (prefix) res.say(prefix);
    if (this.isQuestion(req)) {
      const q = this.questionsOf(req)[c.approvalQIdx ?? 0];
      res.say(`${head}. קלוד שואל: ${q.question}`);
      const opts = q.options.slice(0, 7).map((o, i) => `ל${o.label} הקש ${i + 1}`).join('. ');
      return res.readDigits(`${opts}. לתשובה בהקלטה 8. בהקלדה 9. לדילוג 0`, this.next(c), { timeout: 30 });
    }
    const brief = this.commandBrief(req);
    res.say(`${head}. קלוד מבקש אישור: ${brief ?? req.summary}`);
    return res.readDigits(`לאישור 1. לדחייה 2. ${brief ? 'לשמיעת הפקודה עצמה 3. ' : ''}להסבר בהקלטה 8. לשמיעה חוזרת 7. לדילוג 0`, this.next(c), { timeout: 30 });
  }

  /** בקשת פקודה במצב "תיאור בלבד": התיאור הקצר ש-Claude כתב, בלי הפקודה. null: מקריאים את הכל (מצב מלא, לא פקודה, או שאין תיאור). */
  private commandBrief(req: PermissionRequest): string | null {
    if (this.d.store.getSettings().cmdReadback !== 'description') return null;
    if (req.toolName !== 'Bash' && req.toolName !== 'PowerShell') return null;
    const desc = String(req.input?.description ?? '').trim();
    return desc || null;
  }

  private async onApproval(c: CallState, input: string | undefined): Promise<YemotResponse> {
    const req = c.approvalId ? this.d.store.getPermissionRequest(c.approvalId) : null;
    if (!req) return this.afterApproval(c);
    if (req.decision !== null || Date.parse(req.expiresAt) <= Date.now()) return this.afterApproval(c, req.decision ? 'הבקשה כבר טופלה' : 'פג תוקף הבקשה');
    if (input === '0') { c.skippedApprovals = [...(c.skippedApprovals ?? []), req.id]; return this.afterApproval(c); }
    if (input === '7') return this.presentApproval(c, req);
    if (input === '3' && !this.isQuestion(req) && this.commandBrief(req)) {
      return r().say(`הפקודה עצמה: ${req.summary.replace(/^.*?הפקודה: /s, '')}`).readDigits('לאישור 1. לדחייה 2. להסבר בהקלטה 8. לשמיעה חוזרת 7. לדילוג 0', this.next(c), { timeout: 30 });
    }
    if (input === '8') return this.explainRecordScreen(c, this.isQuestion(req) ? 'answer' : 'deny');

    if (this.isQuestion(req)) {
      if (input === '9') { c.screen = 'approvalText'; return r().readText('הקלד את התשובה וסולמית', this.next(c), { max: 60 }); }
      const q = this.questionsOf(req)[c.approvalQIdx ?? 0];
      const opt = q.options[Number(input) - 1];
      if (!opt) return this.presentApproval(c, req, 'בחירה לא תקינה');
      return this.answerQuestion(c, req, opt.label);
    }
    if (input === '1') return this.finishDecision(c, req, { decision: 'allow' }, 'אושר');
    if (input === '2') return this.finishDecision(c, req, { decision: 'deny' }, 'נדחה');
    return this.presentApproval(c, req, 'בחירה לא תקינה');
  }

  private onApprovalText(c: CallState, input: string | undefined): YemotResponse {
    const req = c.approvalId ? this.d.store.getPermissionRequest(c.approvalId) : null;
    if (!req) return this.afterApproval(c);
    const text = (input ?? '').trim();
    if (!text) return this.presentApproval(c, req, 'לא התקבל טקסט');
    return this.answerQuestion(c, req, text);
  }

  /** תשובה לשאלה הנוכחית; כשכל השאלות נענו, נשלחת החלטה אחת. */
  private answerQuestion(c: CallState, req: PermissionRequest, answer: string): YemotResponse {
    const qs = this.questionsOf(req);
    const idx = c.approvalQIdx ?? 0;
    c.approvalAnswers = { ...(c.approvalAnswers ?? {}), [qs[idx].question]: answer };
    if (idx + 1 < qs.length) { c.approvalQIdx = idx + 1; return this.presentApproval(c, req); }
    return this.finishDecision(c, req, { decision: 'answer', answers: c.approvalAnswers }, 'התשובה נשלחה');
  }

  private finishDecision(c: CallState, req: PermissionRequest, d: Parameters<FlowDeps['decide']>[1], okText: string): YemotResponse {
    const res = this.d.decide(req.id, d, 'phone');
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'decision', detail: `${req.id.slice(0, 8)} ${d.decision} ${res}` });
    const msg = res === 'ok' ? okText : res === 'already' ? 'הבקשה כבר טופלה' : res === 'expired' ? 'פג תוקף הבקשה ולא בוצעה' : 'הבקשה לא נמצאה';
    c.approvalId = undefined; c.approvalAnswers = {}; c.approvalQIdx = 0;
    return this.afterApproval(c, msg);
  }

  /** אחרי טיפול בבקשה: הבקשה הבאה, או חזרה להמתנה בקו, או לתפריט. */
  private afterApproval(c: CallState, prefix = ''): YemotResponse {
    c.approvalId = undefined;
    if (c.approvalReturn === 'waiting' && c.taskId) {
      const nextForTask = this.pendingFor(c).find(p => p.taskId === c.taskId);
      if (nextForTask) return this.presentApproval(c, nextForTask, prefix);
      c.screen = 'waiting'; c.waitStart = Date.now();
      return r().say(prefix ? `${prefix}. ממשיכים להמתין` : 'ממשיכים להמתין').goto(`/${c.ext}`);
    }
    const next = this.pendingFor(c)[0];
    if (next) return this.presentApproval(c, next, prefix);
    return this.mainMenu(c, prefix);
  }

  // ----- מקש 8: הסבר או תשובה בהקלטה -----

  private explainRecordScreen(c: CallState, mode: 'deny' | 'answer', prefix = ''): YemotResponse {
    c.recCount += 1;
    const file = `cp-${c.callId.replace(/[^A-Za-z0-9]/g, '').slice(-10)}-x${c.recCount}`;
    c.explain = { done: false, file: `/${c.ext}/${file}.wav`, mode };
    c.screen = 'explainRecorded';
    const res = r();
    if (prefix) res.say(prefix);
    return res.record(mode === 'deny' ? 'הקלט מה לעשות במקום. בסיום הקש סולמית' : 'הקלט את התשובה. בסיום הקש סולמית', this.next(c), `/${c.ext}`, file);
  }

  private onExplainRecorded(c: CallState): YemotResponse {
    const ex = c.explain!;
    this.d.transcribeAudio(ex.file)
      .then(t => { ex.text = t.trim(); ex.done = true; })
      .catch(e => { logError('stt', e, 'explain'); ex.error = 'התמלול נכשל'; ex.done = true; });
    c.screen = 'explainTranscribing'; c.waitStart = Date.now();
    return r().say('מתמלל').goto(`/${c.ext}`);
  }

  private async onExplainTranscribing(c: CallState): Promise<YemotResponse> {
    const ex = c.explain!;
    const deadline = Date.now() + 9000;
    while (!ex.done && Date.now() < deadline) await this.sleep(250);
    if (!ex.done) return r().goto(`/${c.ext}`);
    if (ex.error || !ex.text) return this.explainRecordScreen(c, ex.mode, `${ex.error ?? 'לא זוהה דיבור'}. הקלט שוב.`);
    c.screen = 'explainConfirm';
    return r().say(`התמלול: ${ex.text}`).readDigits('לשליחה 1. להקלטה מחדש 2. לביטול 3', this.next(c), { timeout: 30 });
  }

  private onExplainConfirm(c: CallState, input: string | undefined): YemotResponse {
    const ex = c.explain!;
    const req = c.approvalId ? this.d.store.getPermissionRequest(c.approvalId) : null;
    if (!req) return this.afterApproval(c);
    if (input === '2') return this.explainRecordScreen(c, ex.mode);
    if (input !== '1') return this.presentApproval(c, req);
    if (ex.mode === 'answer') return this.answerQuestion(c, req, ex.text!);
    return this.finishDecision(c, req, { decision: 'deny', explanation: ex.text }, 'נדחה, וההסבר נשלח לקלוד');
  }

  /** האם המספר נמצא כרגע בשיחה (למניעת צינתוק מיותר). */
  isPhoneInCall(phone: string): boolean {
    for (const c of this.calls.values()) if (c.phone === phone && c.authed) return true;
    return false;
  }

  // ===================== 7: הגדרות =====================

  private settingsScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'settings';
    const st = this.d.store.getSettings();
    const voiceName = VOICES.find(v => v.id === st.voice)?.name ?? '';
    const res = r();
    if (prefix) res.say(prefix);
    res.say(MODE_NAMES[st.editMode]);
    const modelName = MODELS.find(m => m.id === st.model)?.spoken ?? '';
    const effortName = EFFORTS.find(m => m.id === st.effort)?.spoken ?? '';
    const readbackName = READBACKS.find(m => m.id === st.readback)?.spoken ?? '';
    const sttName = STT_ENGINES.find(m => m.id === st.stt)?.spoken ?? '';
    const conns = this.d.mcpConnections?.() ?? [];
    res.say(`המודל: ${modelName}. רמת החשיבה: ${effortName}. בסיום משימה מוקראת ${readbackName}. התמלול: ${sttName}${conns.length ? `. חיבורים פתוחים למשימות: ${conns.join(', ')}` : ''}`);
    return res.readDigits(`לשינוי מצב העבודה הקש 1. לבחירת קול 2. למהירות ההקראה 3. ${st.notify === 'on' ? 'לכיבוי הצינתוקים' : 'להפעלת הצינתוקים'} 4. לבחירת מודל 5. לרמת חשיבה 6. למה מוקרא בסיום משימה 7. למנוע התמלול 8. ${this.d.freeTzintuk?.() ? 'להרשמה לצינתוקים חינמיים 9. ' : ''}לחזרה 0`, this.next(c), { timeout: 20 });
  }

  private async onSettings(c: CallState, input: string | undefined): Promise<YemotResponse> {
    if (input === '9' && this.d.freeTzintuk?.()) {
      const ft = this.d.freeTzintuk()!;
      ft.onRedirect();
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'free_tzintuk_signup', detail: ft.folder });
      // השלוחה של ימות משמיעה תפריט משלה: 1 מוסיף את המספר של המתקשר לרשימה, ואז השיחה מתנתקת
      return r().say('מעביר להרשמה לצינתוקים חינמיים. בתפריט שיישמע, הקש 1 כדי להוסיף את המספר שלך לרשימה').goto(ft.folder);
    }
    if (input === '8') {
      c.screen = 'settingsStt';
      return r().readDigits('לתמלול בשירות של קלוד, בלי התקנה, הקש 1. לתמלול במחשב עם איברית איי איי 2. כל אחד מהם משמש גיבוי לשני. לחזרה 0', this.next(c), { timeout: 20 });
    }
    if (input === '7') {
      c.screen = 'settingsReadback';
      return r().readDigits('להקראת התשובה המלאה של קלוד הקש 1. להקראת הסיכום הקצר בלבד 2. לחזרה 0', this.next(c), { timeout: 20 });
    }
    if (input === '1') {
      c.screen = 'settingsMode';
      return r().readDigits(`לקריאה בלבד 1. לשינויים עם אישור שלך לכל פקודה 2. לאישור אוטומטי של כל הפעולות 3. ${this.d.store.getSettings().cmdReadback === 'description' ? 'להקראת הפקודה במלואה בכל בקשה' : 'להקראת תיאור קצר בלבד, והפקודה במקש 3'} 4. לחזרה 0`, this.next(c), { timeout: 20 });
    }
    if (input === '4') {
      const next = this.d.store.getSettings().notify === 'on' ? 'off' : 'on';
      this.d.store.setSetting('notify', next);
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_notify', detail: next });
      return this.mainMenu(c, next === 'on' ? 'הצינתוקים הופעלו' : 'הצינתוקים כובו. בקשות ותוצאות ישמעו רק כשתתקשר');
    }
    if (input === '6') {
      c.screen = 'settingsEffort';
      return r().readDigits(EFFORTS.map((m, i) => `ל${m.spoken} ${i + 1}`).join('. ') + '. לחזרה 0', this.next(c), { timeout: 20 });
    }
    if (input === '5') {
      c.screen = 'settingsModel';
      return r().readDigits(this.modelMenuText(), this.next(c), { timeout: 20 });
    }
    if (input === '2') {
      c.screen = 'settingsVoice';
      return r().readDigits(VOICES.map((v, i) => `ל${v.name} ${i + 1}`).join('. ') + '. לחזרה 0', this.next(c), { timeout: 20 });
    }
    if (input === '3') {
      c.screen = 'settingsRate';
      return r().readDigits('לאיטי הקש 1. לרגיל 2. למהיר 3. למהיר מאוד 4. לחזרה 0', this.next(c), { timeout: 20 });
    }
    return this.mainMenu(c);
  }

  private modelMenuText(): string {
    return MODELS.map((m, i) => `ל${m.spoken} ${i + 1}`).join('. ') + '. לחזרה 0';
  }

  private onSettingsModel(c: CallState, input: string | undefined): YemotResponse {
    const m = MODELS[Number(input) - 1];
    if (!m) return this.settingsScreen(c);
    this.d.store.setSetting('model', m.id as ModelChoice);
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_model', detail: m.id });
    return this.settingsScreen(c, `נבחר ${m.spoken} לכל המשימות`);
  }

  private onSettingsReadback(c: CallState, input: string | undefined): YemotResponse {
    const m = READBACKS[Number(input) - 1];
    if (!m) return this.settingsScreen(c);
    this.d.store.setSetting('readback', m.id);
    c.resultMode = m.id;
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_readback', detail: m.id });
    return this.settingsScreen(c, m.id === 'full' ? 'מעכשיו בסיום משימה מוקראת התשובה המלאה. אפשר להקיש מקש בכל רגע כדי לקטוע' : 'מעכשיו בסיום משימה מוקרא הסיכום הקצר. בתפריט התוצאות מקש 4 משמיע את התשובה המלאה');
  }

  private onSettingsStt(c: CallState, input: string | undefined): YemotResponse {
    const m = STT_ENGINES[Number(input) - 1];
    if (!m) return this.settingsScreen(c);
    this.d.store.setSetting('stt', m.id);
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_stt', detail: m.id });
    this.d.sttChanged?.();
    return this.settingsScreen(c, m.id === 'claude' ? 'מעכשיו ההקלטות מתומללות בשירות של קלוד' : 'מעכשיו ההקלטות מתומללות במחשב. אם המודל לא מותקן, התמלול יישאר אצל קלוד');
  }

  private onSettingsEffort(c: CallState, input: string | undefined): YemotResponse {
    const m = EFFORTS[Number(input) - 1];
    if (!m) return this.settingsScreen(c);
    this.d.store.setSetting('effort', m.id as EffortChoice);
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_effort', detail: m.id });
    return this.settingsScreen(c, `רמת החשיבה: ${m.spoken}`);
  }

  /** מודל לבקשה הזו בלבד (מסך אישור התמלול, מקש 4), ואז שליחה. */
  private onTaskModel(c: CallState, input: string | undefined): YemotResponse {
    const m = MODELS[Number(input) - 1];
    if (!m) return this.confirmScreen(c);
    const task = this.d.tasks.get(c.taskId!);
    if (!task || task.state !== 'awaiting_transcript') return this.mainMenu(c, 'הטיוטה כבר אינה זמינה');
    this.d.tasks.patch(task.id, { model: m.id });
    c.confirmStart = Date.now();
    return this.onConfirmTranscript(c, '1', `עם ${m.spoken}`);
  }

  private onSettingsMode(c: CallState, input: string | undefined): YemotResponse {
    if (input === '4') {
      const next = this.d.store.getSettings().cmdReadback === 'description' ? 'full' : 'description';
      this.d.store.setSetting('cmdReadback', next);
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_cmdReadback', detail: next });
      return this.settingsScreen(c, next === 'full' ? 'מעכשיו בכל בקשה מוקראים התיאור והפקודה במלואה' : 'מעכשיו בכל בקשה מוקרא תיאור קצר בלבד. את הפקודה עצמה שומעים במקש 3');
    }
    const modes: Record<string, EditMode> = { '1': 'readonly', '2': 'edit', '3': 'auto' };
    const next = input ? modes[input] : undefined;
    if (!next) return this.settingsScreen(c);
    this.d.store.setSetting('editMode', next);
    this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_editMode', detail: next });
    const msg = next === 'readonly' ? 'מעכשיו קלוד במצב קריאה בלבד ולא ישנה קבצים'
      : next === 'edit' ? 'מעכשיו קלוד עורך קבצים בפרויקט, וכל פקודה תגיע אליך לאישור'
      : 'מעכשיו קלוד מאשר לעצמו את כל הפעולות. שאלות עדיין יגיעו אליך';
    return this.mainMenu(c, msg);
  }

  private async onSettingsVoice(c: CallState, input: string | undefined): Promise<YemotResponse> {
    const v = VOICES[Number(input) - 1];
    if (!input || input === '0' || !v) return this.settingsScreen(c);
    return this.changeVoice(c, v.id, this.d.store.getSettings().rate, `נבחר ${v.name}`);
  }

  private async onSettingsRate(c: CallState, input: string | undefined): Promise<YemotResponse> {
    const rates: Record<string, number> = { '1': -4, '2': 0, '3': 4, '4': 8 };
    if (!input || !(input in rates)) return this.settingsScreen(c);
    return this.changeVoice(c, this.d.store.getSettings().voice, rates[input], 'המהירות עודכנה');
  }

  private async changeVoice(c: CallState, voice: string, rate: number, done: string): Promise<YemotResponse> {
    try {
      await this.d.applyVoice(voice, rate);
      this.d.store.setSetting('voice', voice);
      this.d.store.setSetting('rate', rate);
      this.d.store.phoneLog({ callId: c.callId, phone: c.phone, kind: 'setting_voice', detail: `${voice} ${rate}` });
      return this.settingsScreen(c, `${done}. כך נשמע הקול החדש`);
    } catch (e) {
      logError('phone', e, 'applyVoice');
      return this.settingsScreen(c, 'שינוי הקול נכשל');
    }
  }

  // ===================== 9: הסבר על המערכת =====================

  private helpScreen(c: CallState, prefix = ''): YemotResponse {
    c.screen = 'help';
    const res = r();
    if (prefix) res.say(prefix);
    return res.readDigits(`הסבר על המערכת. ${HELP_TOPICS.map((t, i) => `${t.title} הקש ${i + 1}`).join('. ')}. לחזרה לתפריט 0`, this.next(c), { timeout: 25 });
  }

  private onHelp(c: CallState, input: string | undefined): YemotResponse {
    if (input === '0') return this.mainMenu(c);
    const topic = HELP_TOPICS[Number(input) - 1];
    if (!topic) return this.helpScreen(c, input ? 'בחירה לא תקינה' : '');
    c.screen = 'help';
    const res = r();
    for (const line of topic.lines) res.say(line);   // כל משפט מקטע נפרד: הפסקה טבעית בהקראה
    return res.readDigits(`לנושא אחר בחר מספר. ${HELP_TOPICS.map((t, i) => `${t.title} הקש ${i + 1}`).join('. ')}. לחזרה לתפריט 0`, this.next(c), { timeout: 25 });
  }

  /** לבדיקות ולוח הבקרה */
  activeCalls(): number { return this.calls.size; }
}

// ===================== תוכן ההסבר בטלפון (מקש 9) =====================
// אותו תוכן, בהרחבה, נמצא בלשונית "עזרה" בלוח הבקרה. בלי פסיקים ומקפים: ימות מוחקת אותם.

export const HELP_TOPICS: { title: string; lines: string[] }[] = [
  { title: 'מה המערכת עושה', lines: [
    'המערכת מחברת את הטלפון לקלוד קוד שרץ על המחשב שלך',
    'אתה מקליט בקשה בקול ושומע את התמלול לאישור',
    'אחרי האישור קלוד מבצע את הבקשה על הקבצים שבמחשב ואתה שומע את התשובה',
    'אפשר לחכות בקו או לנתק בכל רגע ולשמוע את התשובה אחר כך במקש 4',
    'אם קלוד צריך אישור או שואל שאלה תקבל צינתוק ותחליט מהטלפון',
    'אפשר לפתוח שיחה חדשה בפרויקט להמשיך שיחה קודמת או לשלוח הודעה לשיחה שפתוחה עכשיו במחשב',
    'המערכת נבנתה על ידי ארי ממתמחים טופ בעזרת קלוד ומבוססת על הפרויקט של זביסווי לחיבור קלוד קוד לימות המשיח',
  ] },
  { title: 'התפריט הראשי', lines: [
    'מקש 1 שולח הודעה לשיחת קלוד קוד שפתוחה עכשיו בחלון טרמינל במחשב עם חיבור לטלפון והוא מופיע רק כשיש שיחה כזו',
    'מקש 2 ממשיך שיחה קודמת ובראש הרשימה מקש 1 פותח שיחה חדשה',
    'מקש 3 פותח שיחה חדשה בפרויקט ובראש רשימת הפרויקטים מקש 1 פותח פרויקט חדש',
    'מקש 4 משמיע את התוצאות של משימות שהסתיימו ואפשר להקיש מקש באמצע ההקראה כדי לקטוע אותה',
    'בתוך תוצאה מקש 1 משמיע שוב מקש 3 ממשיך את השיחה בהקלטה ומקש 4 מחליף בין התשובה המלאה לסיכום הקצר',
    'מקש 5 מציג משימות שרצות עכשיו ומשם מקש 9 מבקש לעצור משימה',
    'מקש 6 מופיע רק כשיש בקשות אישור או שאלות שממתינות לך',
    'מקש 7 להגדרות. מקש 8 לשיחות נוספות והוא מקריא את כל השיחות במחשב גם מחוץ לפרויקטים ואם הוגדרו שיחות ענן אפשר לבחור בהן ולשלוח להן הודעה. מקש 9 להסבר הזה',
    'ברשימות ארוכות סולמית עוברת לעמוד הבא ו 0 חוזר אחורה',
  ] },
  { title: 'הקלטה ושליחה', lines: [
    'אחרי שבחרת לאן לשלוח מקליטים את הבקשה אחרי הצליל ומסיימים בסולמית',
    'המחשב מתמלל ומקריא לך את התמלול',
    'מקש 1 שולח מקש 2 מקליט מחדש מקש 3 מבטל ומקש 4 שולח עם מודל אחר לבקשה הזו בלבד',
    'ניתוק לפני האישור לא שולח שום דבר',
    'דבר ברור ובמשפטים מלאים ואמור באיזה קובץ או נושא מדובר',
  ] },
  { title: 'אילו שיחות אפשר להמשיך', lines: [
    'במקש 2 מוקראות השיחות של הפרויקטים שזמינים בטלפון מהחדשה לישנה ובמקש 8 כל השיחות במחשב',
    'שיחה מחוץ לפרויקטים ממשיכה בתיקייה שלה והמערכת רושמת את התיקייה לבד',
    'אפשר להמשיך שיחות שנפתחו מהטלפון ושיחות של קלוד קוד מכל מקום במחשב באפליקציית הדסקטופ בטרמינל ובויזואל סטודיו',
    'אפשר להמשיך גם שיחות קוורק ששמורות במחשב',
    'שיחה שעבדו עליה במחשב בשלוש הדקות האחרונות נחשבת פתוחה ואי אפשר להמשיך אותה באותו רגע',
    'שיחות קוורק שרצו במכונה הווירטואלית אפשר רק לשמוע',
    'כשבוחרים שיחה שאי אפשר להמשיך שומעים את הסיבה ואת התשובה האחרונה שבה',
    'שיחות קוורק שנשמרו בענן לא מופיעות כלל כי הן לא נמצאות במחשב',
    'לשיחה שפתוחה בטרמינל שולחים הודעה במקש 1 כשהיא נפתחה עם חיבור לטלפון',
  ] },
  { title: 'פרויקטים', lines: [
    'פרויקט הוא תיקייה במחשב שקלוד עובד בתוכה',
    'בטלפון מופיעים רק פרויקטים שסומנו זמין בטלפון בלוח הבקרה',
    'פרויקט חדש פותחים במקש 3 ואז מקש 1 באמירת השם או בהקלדה שלו. ואם חיברת גיטהאב בלוח הבקרה מקש 3 בבחירת הפרויקט החדש מקריא את המאגרים שלך ופותח את מה שבחרת',
    'הפרויקט נוצר כתיקייה חדשה בתיקיית הפרויקטים ושיחה חדשה נפתחת בו מיד',
    'את המיקום של תיקיית הפרויקטים בוחרים בלוח הבקרה בלשונית פרויקטים ושם אפשר גם להעביר אותה למקום אחר',
    'תיקייה שכבר קיימת במחשב מוסיפים באשף ההגדרה במחשב',
  ] },
  { title: 'אישורים ושאלות', lines: [
    'כשקלוד רוצה להריץ פקודה הוא מבקש אישור',
    'מקש 1 מאשר מקש 2 דוחה מקש 8 דוחה ומקליט לקלוד מה לעשות במקום מקש 7 משמיע שוב ו 0 מדלג',
    'בפקודה שקלוד תיאר בקצרה מוקרא התיאור בלבד ומקש 3 משמיע את הפקודה עצמה. אפשר לשנות להקראה מלאה בהגדרות במקש 7 ואז 1 ואז 4',
    'כשקלוד שואל שאלה בוחרים תשובה במקש המתאים או מקש 8 לתשובה בהקלטה או מקש 9 להקלדה',
    'בקשה שלא נענתה בזמן פוקעת וקלוד לא מבצע אותה',
    'אם אתה ממתין בקו הבקשה מוקראת מיד ואם ניתקת תקבל צינתוק',
  ] },
  { title: 'הגדרות', lines: [
    'בהגדרות במקש 7',
    'מקש 1 מצב העבודה קריאה בלבד או עריכה עם אישור שלך לכל פקודה או אישור אוטומטי של הכל ובו גם מקש 4 קובע אם מוקרא תיאור קצר בלבד לפקודה או הפקודה במלואה',
    'מקש 2 בוחר קול ומקש 3 את מהירות ההקראה',
    'מקש 4 מפעיל או מכבה את הצינתוקים ובלילה בשבת ובחג הצינתוקים נדחים לסוף זמן השקט',
    'מקש 5 בוחר מודל פייבל הוא החזק ביותר אופוס חזק מאוד סונט מאוזן והייקו מהיר וחסכוני',
    'מקש 6 בוחר רמת חשיבה ורמה גבוהה יותר יסודית יותר אבל איטית יותר',
    'מקש 7 קובע מה מוקרא בסיום משימה התשובה המלאה של קלוד או רק הסיכום הקצר שבראשה',
    'חיבורים כמו ג׳ימייל דרייב ויומן פותחים למשימות מהטלפון בלוח הבקרה בהגדרות ושליחת מייל או מחיקה מגיעות אליך לאישור לפי מצב העבודה',
  ] },
];

// ===================== עזרי הקראה =====================

function isFinal(t: Task): boolean { return ['done', 'failed', 'cancelled', 'needs_review'].includes(t.state); }

export function stateSpeech(t: Task): string {
  switch (t.state) {
    case 'queued': return 'ממתינה בתור';
    case 'running': return 'רצה עכשיו';
    case 'awaiting_permission': return 'ממתינה לאישור';
    case 'awaiting_answer': return 'ממתינה לתשובה שלך';
    case 'stop_requested': return 'בתהליך עצירה';
    case 'done': return 'הסתיימה';
    case 'failed': return 'נכשלה';
    case 'cancelled': return 'בוטלה';
    case 'needs_review': return 'דורשת בדיקה במחשב';
    default: return 'בטיוטה';
  }
}

/** הסיכום הקצר (מה שבראש התשובה, לפני קו ה---). */
export function resultSpeech(t: Task): string {
  if (t.state === 'done') return t.resultSummary || t.resultText || 'הסתיימה בלי תשובה בטקסט';
  if (t.state === 'failed') return `נכשלה. ${t.error ?? ''}`;
  if (t.state === 'needs_review') return 'דורשת בדיקה במחשב. ייתכן שחלק מהשינויים כבר בוצעו';
  return stateSpeech(t);
}

/** התשובה המלאה של Claude להקראה: הסיכום וגם הפירוט, בלי Markdown; קוד מוחלף בהפניה ללוח. */
export function fullResultSpeech(t: Task): string {
  if (t.state !== 'done') return resultSpeech(t);
  const full = t.resultText ? cleanForSpeech(t.resultText) : '';
  return full || resultSpeech(t);
}

export function spokenAgo(iso: string, now = Date.now()): string {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 2) return 'עכשיו';
  if (min < 60) return `לפני ${min} דקות`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : `לפני ${h} שעות`;
  const d = Math.round(h / 24);
  return d === 1 ? 'אתמול' : `לפני ${d} ימים`;
}

export function conversationTitle(prompt: string): string {
  const t = san(prompt).split(' ').slice(0, 7).join(' ');
  return t || 'שיחה ללא כותרת';
}

export type { Target, CallState, Conversation };
