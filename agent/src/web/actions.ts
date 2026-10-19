// שלב 4: פעולות מלוח הבקרה. עוברות דרך אותו תור, אותן נעילות ואותו מתווך הרשאות כמו מהטלפון.
// ההגנה (אסימון מקומי, Origin, כותרת X-CP) נעשית בשרת הלוח לפני שמגיעים לכאן.
import type { Store, EditMode } from '../store/db.ts';
import { VOICES, MODELS, EFFORTS, READBACKS, STT_ENGINES } from '../store/db.ts';
import type { Tasks } from '../store/tasks.ts';
import type { ConversationIndex } from '../history/conversations.ts';
import type { DecideResult } from '../claude/broker.ts';
import type { Project } from '@claude-phone/shared';
import type { Config } from '../config.ts';
import { saveUserConfig, AGENT_ROOT } from '../config.ts';
import type { QuietConfig } from '../notify/quiet.ts';
import { normalizePhone } from '../setup/routes.ts';
import { existsSync } from 'node:fs';
import type { Updater } from '../update/updater.ts';
import { REPO_RE } from '../update/updater.ts';
import type { ProjectsLocation } from '../projects-location.ts';
import { pickFolder } from './open.ts';
import type { McpScan } from '../claude/mcp.ts';
import type { ChromeBrowser, ChromeSettings } from '../claude/chrome.ts';
import { log } from '../log.ts';

export interface ActionDeps {
  store: Store;
  tasks: Tasks;
  conversations: ConversationIndex;
  kickWorker: () => void;
  requestStop: (taskId: string, actor: string) => void;
  decide: (id: string, d: { decision: 'allow' } | { decision: 'deny'; explanation?: string } | { decision: 'answer'; answers: Record<string, string> }, via: 'dashboard') => DecideResult;
  applyVoice?: (voice: string, rate: number) => Promise<void>;
  /** יצירת פרויקט חדש בתיקיית הפרויקטים (כמו מהטלפון). */
  createProject?: (name: string) => Promise<Project>;
  /** ההגדרות החיות (משתנות במקום ונשמרות ל-config.json). */
  cfg?: Config;
  /** אובייקט שעות השקט שהמתריע משתמש בו (שינוי חל מיד). */
  quiet?: QuietConfig;
  /** פותח חלון טרמינל עם Claude Code ועם ערוץ הטלפון בתיקיית הפרויקט (סשן חי). מחזיר את התיקייה. */
  openLive?: (projectId: string) => string;
  /** פותח חלון טרמינל שממשיך שיחה קיימת (claude --resume) בתיקייה שלה. */
  openTerminal?: (conversationId: string, cwd: string) => void;
  /** פותח את סייר הקבצים בתיקייה. */
  openFolder?: (path: string) => void;
  /** תיקיית config.json (בבדיקות: זמנית). */
  root?: string;
  /** עדכון מתוך התוכנה. */
  updater?: Updater;
  /** תיקיית הפרויקטים: מיקום והעברה. */
  location?: ProjectsLocation;
  /** רישום אוטומטי של תיקיית שיחה מחוץ לפרויקטים (כמו מקש 8 בטלפון). */
  ensureProject?: (folder: string) => string;
  /** חלון בחירת תיקייה (נדרס בבדיקות). */
  pickFolder?: (initial: string | null, title: string) => Promise<string | null>;
  /** סריקת חיבורי ה-MCP שקיימים במחשב (הרצה קצרה של Claude Code). */
  scanMcp?: () => Promise<McpScan>;
  /** רשימת הדפדפנים שמחוברים ל-Claude in Chrome (הרצה קצרה של Claude עם --chrome) */
  listChrome?: () => Promise<ChromeBrowser[]>;
  /** אחרי מעבר ל-ivrit-ai: טעינת המודל מראש */
  sttChanged?: () => void;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const EXPORT_FORMAT = 'claudephone-settings';

type Result = { code: number; json: unknown };
const ok = (json: unknown): Result => ({ code: 200, json });
const bad = (error: string, code = 400): Result => ({ code, json: { error } });

const DECIDE_MSG: Record<string, string> = {
  already: 'הבקשה כבר הוכרעה (אולי בטלפון)', expired: 'הבקשה פגה', missing: 'הבקשה לא נמצאה',
};

export class DashboardActions {
  private mcpScanning = false;
  private chromeListing = false;
  constructor(private d: ActionDeps) {}

  /** מצב חיבורי ה-MCP לתצוגה בלוח: הסריקה האחרונה, ומה פתוח. */
  mcpView(): { enabled: string[]; scan: McpScan | null; scanning: boolean; chrome: ChromeSettings & { listing: boolean } } {
    const cfg = this.d.cfg;
    const chrome = cfg?.mcp.chrome ?? { enabled: false, browser: 'first', browsers: [], browsersAt: null };
    return { enabled: cfg?.mcp.enabled ?? [], scan: cfg?.mcp.scan ?? null, scanning: this.mcpScanning, chrome: { ...chrome, listing: this.chromeListing } };
  }

  async handle(path: string, body: any): Promise<Result> {
    let m: RegExpMatchArray | null;

    // עדכון מתוך התוכנה
    if (path === '/update/check') {
      if (!this.d.updater) return bad('לא זמין');
      return ok(await this.d.updater.check());
    }
    if (path === '/update/install') {
      const u = this.d.updater;
      if (!u) return bad('לא זמין');
      if (!u.state.enabled) return bad(u.state.disabledReason ?? 'העדכון לא זמין');
      if (u.state.phase === 'downloading' || u.state.phase === 'installing') return bad('עדכון כבר מתבצע');
      // ההורדה נמשכת ברקע; הלוח עוקב אחרי ההתקדמות ב-overview
      u.install().catch(() => { /* השגיאה נשמרת במצב העדכון */ });
      return ok({ started: true });
    }
    if (path === '/update/settings') {
      const u = this.d.updater, cfg = this.d.cfg;
      if (!u || !cfg) return bad('לא זמין');
      const patch: Record<string, unknown> = {};
      if (body?.repo !== undefined) {
        const repo = String(body.repo).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
        if (!REPO_RE.test(repo)) return bad('שם המאגר צריך להיות בצורה owner/repo');
        u.setRepo(repo); cfg.update.repo = repo; patch.repo = repo;
      }
      if (typeof body?.auto === 'boolean') { u.setAuto(body.auto); cfg.update.auto = body.auto; patch.auto = body.auto; }
      saveUserConfig({ update: patch }, this.d.root ?? AGENT_ROOT);
      if (patch.repo) await u.check();
      return ok(u.state);
    }

    // תיקיית הפרויקטים: בחירת מיקום, והעברה של הפרויקטים הקיימים (לבחירה)
    if (path === '/pick-folder') {
      const fn = this.d.pickFolder ?? pickFolder;
      return ok({ path: await fn(String(body?.initial ?? '') || null, String(body?.title ?? 'בחר תיקייה')) });
    }
    if (path === '/projects/location') {
      if (!this.d.location) return bad('לא זמין');
      try { return ok(this.d.location.change(String(body?.parent ?? ''), body?.move === true)); }
      catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
    }

    // חיבורי MCP למשימות מהטלפון: סריקה של מה שקיים במחשב, ובחירה אילו שרתים פתוחים
    if (path === '/mcp/scan') {
      const cfg = this.d.cfg;
      if (!this.d.scanMcp || !cfg) return bad('לא זמין');
      if (this.mcpScanning) return bad('סריקה כבר רצה');
      this.mcpScanning = true;
      try {
        const scan = await this.d.scanMcp();
        cfg.mcp.scan = scan;
        // שרת שנבחר בעבר ונעלם מהמחשב נשאר ברשימה (אולי ייטען שוב), אבל מסומן בלוח
        saveUserConfig({ mcp: { scan } }, this.d.root ?? AGENT_ROOT);
        log('web', `סריקת חיבורי MCP: ${scan.servers.length} שרתים`);
        return ok(this.mcpView());
      } catch (e) { return bad(`הסריקה נכשלה: ${e instanceof Error ? e.message : String(e)}`); }
      finally { this.mcpScanning = false; }
    }
    if (path === '/mcp') {
      const cfg = this.d.cfg;
      if (!cfg) return bad('לא זמין');
      const enabled = Array.isArray(body?.enabled) ? [...new Set(body.enabled.map((s: unknown) => String(s)).filter((s: string) => /^[\w-]+$/.test(s)))] : null;
      if (!enabled) return bad('חסרה רשימת חיבורים');
      cfg.mcp.enabled = enabled as string[];
      saveUserConfig({ mcp: { enabled } }, this.d.root ?? AGENT_ROOT);
      log('web', `חיבורי MCP לטלפון: ${enabled.length ? (enabled as string[]).join(', ') : 'אין'}`);
      return ok(this.mcpView());
    }

    // Claude in Chrome: הפעלה ובחירת דפדפן ('first' = הראשון ברשימה, 'ask' = לשאול בטלפון, או מזהה דפדפן)
    if (path === '/mcp/chrome') {
      const cfg = this.d.cfg;
      if (!cfg) return bad('לא זמין');
      const cur = cfg.mcp.chrome;
      const patch: Partial<ChromeSettings> = {};
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
      if (body?.browser !== undefined) {
        const b = String(body.browser);
        if (b !== 'first' && b !== 'ask' && !/^[\w-]{1,80}$/.test(b)) return bad('בחירת דפדפן לא תקינה');
        patch.browser = b;
      }
      cfg.mcp.chrome = { ...cur, ...patch };
      saveUserConfig({ mcp: { chrome: patch } }, this.d.root ?? AGENT_ROOT);
      log('web', `Claude in Chrome לטלפון: ${cfg.mcp.chrome.enabled ? 'פעיל' : 'כבוי'}, דפדפן: ${cfg.mcp.chrome.browser}`);
      return ok(this.mcpView());
    }
    if (path === '/mcp/chrome/browsers') {
      const cfg = this.d.cfg;
      if (!cfg || !this.d.listChrome) return bad('לא זמין');
      if (this.chromeListing) return bad('הבדיקה כבר רצה');
      this.chromeListing = true;
      try {
        const browsers = await this.d.listChrome();
        const browsersAt = new Date().toISOString();
        cfg.mcp.chrome = { ...cfg.mcp.chrome, browsers, browsersAt };
        saveUserConfig({ mcp: { chrome: { browsers, browsersAt } } }, this.d.root ?? AGENT_ROOT);
        log('web', `דפדפנים ב-Claude in Chrome: ${browsers.map(b => b.name).join(', ') || 'אין'}`);
        return ok(this.mcpView());
      } catch (e) { return bad(`לא הצלחתי לקבל את רשימת הדפדפנים: ${e instanceof Error ? e.message : String(e)}`); }
      finally { this.chromeListing = false; }
    }

    // פרויקט חדש (תיקייה חדשה בתיקיית הפרויקטים)
    if (path === '/projects/new') {
      if (!this.d.createProject) return bad('לא זמין');
      try { return ok(await this.d.createProject(String(body?.name ?? ''))); }
      catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
    }


    // משימה חדשה: בפרויקט (שיחה חדשה) או בשיחה קיימת (המשך)
    if (path === '/tasks') {
      const prompt = String(body?.prompt ?? '').trim();
      if (!prompt) return bad('יש לכתוב מה לעשות');
      if (prompt.length > 20_000) return bad('ההודעה ארוכה מדי');
      let projectId = String(body?.projectId ?? '');
      let conversationId: string | null = body?.conversationId ? String(body.conversationId) : null;
      if (conversationId) {
        let conv = this.d.conversations.get(conversationId);
        if (!conv) return bad('השיחה לא נמצאה', 404);
        // שיחה מחוץ לפרויקטים: ממשיכים בתיקייה שלה, והתיקייה נרשמת אוטומטית
        if (!conv.projectId && this.d.ensureProject) {
          const v = this.d.conversations.autoFolderView(conv);
          if (v.autoFolder && v.canContinue) {
            try { conv = { ...v, projectId: this.d.ensureProject(v.autoFolder) }; }
            catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
          } else conv = v;
        }
        const ours = conv.source === 'phone';
        if (!ours && !conv.canContinue) return bad(conv.blockedReason ?? 'אי אפשר להמשיך את השיחה הזו');
        if (!conv.projectId) return bad('השיחה לא שייכת לפרויקט');
        projectId = conv.projectId;
        // שיחה של Desktop/טרמינל שממשיכים מכאן נרשמת במאגר; שיחת Cowork נשארת של Desktop (כמו מהטלפון)
        if (!ours && conv.source !== 'cowork') {
          this.d.store.upsertConversation({ id: conv.id, projectId, title: conv.title, source: conv.source === 'desktop' ? 'desktop' : 'unknown' });
        }
      }
      const project = this.d.store.getProject(projectId);
      if (!project) return bad('יש לבחור פרויקט');
      if (!project.phoneEnabled) return bad('הפרויקט כבוי. הפעל אותו בעמוד הפרויקטים');
      const model = body?.model && body.model !== 'default' ? String(body.model) : null;
      if (model && !MODELS.some(m => m.id === model)) return bad('מודל לא תקין');
      const t0 = this.d.tasks.create({ projectId, source: 'dashboard', conversationId, prompt });
      const t = model ? this.d.tasks.patch(t0.id, { model }) : t0;
      this.d.tasks.transition(t.id, 'awaiting_transcript', 'dashboard', 'נכתבה בלוח הבקרה');
      const q = this.d.tasks.transition(t.id, 'queued', 'dashboard', 'נשלחה מלוח הבקרה');
      log('web', `משימה ${q.num} נשלחה מלוח הבקרה`);
      this.d.kickWorker();
      return ok(q);
    }

    if ((m = path.match(/^\/tasks\/([\w-]+)\/stop$/))) {
      const t = this.d.tasks.get(m[1]);
      if (!t) return bad('המשימה לא נמצאה', 404);
      if (!['queued', 'running', 'awaiting_permission', 'awaiting_answer'].includes(t.state)) return bad('המשימה כבר לא פעילה');
      this.d.requestStop(t.id, 'dashboard');
      return ok(this.d.tasks.get(t.id));
    }

    if ((m = path.match(/^\/tasks\/([\w-]+)\/heard$/))) {
      if (!this.d.tasks.get(m[1])) return bad('המשימה לא נמצאה', 404);
      this.d.tasks.markHeard(m[1]);
      return ok({ saved: true });
    }

    // אישור, דחייה או תשובה לשאלה
    if ((m = path.match(/^\/permissions\/([\w-]+)$/))) {
      const decision = String(body?.decision ?? '');
      let res: DecideResult;
      if (decision === 'allow') res = this.d.decide(m[1], { decision: 'allow' }, 'dashboard');
      else if (decision === 'deny') {
        const explanation = String(body?.explanation ?? '').trim();
        res = this.d.decide(m[1], explanation ? { decision: 'deny', explanation } : { decision: 'deny' }, 'dashboard');
      } else if (decision === 'answer') {
        const answers = body?.answers && typeof body.answers === 'object' ? Object.fromEntries(Object.entries(body.answers).map(([k, v]) => [String(k), String(v)])) : null;
        if (!answers || !Object.keys(answers).length) return bad('חסרה תשובה');
        res = this.d.decide(m[1], { decision: 'answer', answers }, 'dashboard');
      } else return bad('החלטה לא תקינה');
      return res === 'ok' ? ok({ decided: true }) : bad(DECIDE_MSG[res] ?? 'לא בוצע', 409);
    }

    // הגדרות: מצב עבודה, קול, מהירות, התראות (כמו מקש 7 בטלפון)
    if (path === '/settings') {
      const before = this.d.store.getSettings();
      const modes: EditMode[] = ['readonly', 'edit', 'auto'];
      if (body?.editMode !== undefined) { if (!modes.includes(body.editMode)) return bad('מצב לא תקין'); this.d.store.setSetting('editMode', body.editMode); }
      if (body?.voice !== undefined) { if (!VOICES.some(v => v.id === body.voice)) return bad('קול לא תקין'); this.d.store.setSetting('voice', body.voice); }
      if (body?.rate !== undefined) { const r = Number(body.rate); if (!Number.isFinite(r)) return bad('מהירות לא תקינה'); this.d.store.setSetting('rate', Math.max(-10, Math.min(10, r))); }
      if (body?.notify !== undefined) { if (body.notify !== 'on' && body.notify !== 'off') return bad('ערך לא תקין'); this.d.store.setSetting('notify', body.notify); }
      if (body?.effort !== undefined) { if (!EFFORTS.some(m => m.id === body.effort)) return bad('רמת חשיבה לא תקינה'); this.d.store.setSetting('effort', body.effort); }
      if (body?.model !== undefined) { if (!MODELS.some(m => m.id === body.model)) return bad('מודל לא תקין'); this.d.store.setSetting('model', body.model); }
      if (body?.readback !== undefined) { if (!READBACKS.some(m => m.id === body.readback)) return bad('ערך לא תקין'); this.d.store.setSetting('readback', body.readback); }
      if (body?.stt !== undefined) { if (!STT_ENGINES.some(m => m.id === body.stt)) return bad('מנוע תמלול לא תקין'); this.d.store.setSetting('stt', body.stt); if (body.stt === 'local') this.d.sttChanged?.(); }
      const after = this.d.store.getSettings();
      let warning: string | null = null;
      if ((after.voice !== before.voice || after.rate !== before.rate) && this.d.applyVoice) {
        try { await this.d.applyVoice(after.voice, after.rate); } catch (e) { warning = `הקול נשמר, אבל עדכון השלוחה נכשל: ${e instanceof Error ? e.message : e}`; }
      }
      log('web', `הגדרות עודכנו מלוח הבקרה: ${JSON.stringify(after)}`);
      return ok({ settings: after, warning });
    }

    // פרויקט: זמין בטלפון, השם שמוקרא, עריכת קבצים
    if ((m = path.match(/^\/projects\/([\w-]+)$/))) {
      const p = this.d.store.getProject(m[1]);
      if (!p) return bad('הפרויקט לא נמצא', 404);
      const patch: { phoneEnabled?: boolean; spokenName?: string; editInsideProject?: boolean; listed?: boolean } = {};
      if (body?.phoneEnabled !== undefined) patch.phoneEnabled = !!body.phoneEnabled;
      if (body?.spokenName !== undefined) {
        const n = String(body.spokenName).trim();
        if (!n || n.length > 60) return bad('שם לא תקין');
        patch.spokenName = n;
      }
      if (body?.editInsideProject !== undefined) patch.editInsideProject = !!body.editInsideProject;
      if (body?.listed !== undefined) patch.listed = !!body.listed;
      return ok(this.d.store.updateProject(p.id, patch));
    }

    // זמני שקט ושמירת הקלטות
    if (path === '/quiet') {
      const q = this.d.quiet, cfg = this.d.cfg;
      if (!q || !cfg) return bad('לא זמין');
      const next = { ...q };
      if (body?.start !== undefined) { if (!HHMM.test(String(body.start))) return bad('שעת התחלה לא תקינה (למשל 23:00)'); next.start = String(body.start); }
      if (body?.end !== undefined) { if (!HHMM.test(String(body.end))) return bad('שעת סיום לא תקינה (למשל 07:00)'); next.end = String(body.end); }
      if (body?.shabbatAndChag !== undefined) next.shabbatAndChag = !!body.shabbatAndChag;
      if (body?.includeCholHamoed !== undefined) next.includeCholHamoed = !!body.includeCholHamoed;
      Object.assign(q, next);
      Object.assign(cfg.quietHours, next);
      const patch: Record<string, unknown> = { quietHours: { start: next.start, end: next.end, shabbatAndChag: next.shabbatAndChag, includeCholHamoed: next.includeCholHamoed } };
      if (body?.retentionDays !== undefined) {
        const n = Number(body.retentionDays);
        if (!Number.isInteger(n) || n < 0 || n > 365) return bad('מספר ימים לא תקין (0 עד 365; 0 = לא למחוק)');
        cfg.retention.recordingsDays = n;
        patch.retention = { recordingsDays: n };
      }
      saveUserConfig(patch, this.d.root ?? AGENT_ROOT);
      log('web', `זמני שקט עודכנו: ${next.start}-${next.end}, שבת וחג ${next.shabbatAndChag ? 'כן' : 'לא'}`);
      return ok({ quiet: next, retentionDays: cfg.retention.recordingsDays });
    }

    if (path === '/import') return this.importData(body?.data);

    if (path === '/live/open') {
      if (!this.d.openLive) return bad('לא זמין');
      try { return ok({ opened: this.d.openLive(String(body?.projectId ?? '')) }); }
      catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
    }

    // שיחה במחשב: חלון Claude Code שממשיך את השיחה הזו, או סייר הקבצים בתיקייה שלה (הנתיב מהאינדקס, לא מהלקוח)
    if ((m = path.match(/^\/conversations\/([\w-]+)\/(open-terminal|open-folder)$/))) {
      const raw = this.d.conversations.get(m[1]);
      const conv = raw ? this.d.conversations.autoFolderView(raw) : null;
      if (!conv) return bad('השיחה לא נמצאה', 404);
      const folder = conv.folder ?? null;
      if (!folder || !existsSync(folder)) return bad('התיקייה של השיחה לא נמצאה במחשב');
      try {
        if (m[2] === 'open-folder') { if (!this.d.openFolder) return bad('לא זמין'); this.d.openFolder(folder); return ok({ opened: folder }); }
        if (conv.source === 'cowork') return bad('שיחת Cowork פותחים ב-Claude Desktop, לא בטרמינל');
        if (!conv.inHistory) return bad('ההיסטוריה של השיחה לא נמצאה במחשב, אז אין מה להמשיך בטרמינל');
        if (!this.d.openTerminal) return bad('לא זמין');
        this.d.openTerminal(conv.id, folder);
        return ok({ opened: folder });
      } catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
    }

    return bad('לא נמצא', 404);
  }

  /** ייצוא הגדרות לקובץ, להעברה למחשב אחר או לגיבוי. בלי סודות: טוקן ימות וקוד הכניסה לא יוצאים. */
  exportData(): Record<string, unknown> {
    const cfg = this.d.cfg;
    return {
      format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(),
      settings: this.d.store.getSettings(),
      quietHours: cfg ? { start: cfg.quietHours.start, end: cfg.quietHours.end, shabbatAndChag: cfg.quietHours.shabbatAndChag, includeCholHamoed: cfg.quietHours.includeCholHamoed } : null,
      retentionDays: cfg?.retention.recordingsDays ?? null,
      phones: cfg?.phones.allowed ?? [],
      yemotExtension: cfg?.yemot.chatExtension ?? null,
      resumeSources: cfg?.history.resumeSources ?? null,
      projectsParent: cfg?.projects.newProjectsParent ?? null,
      projects: this.d.store.listProjects().map(p => ({ name: p.name, spokenName: p.spokenName, path: p.path, phoneEnabled: p.phoneEnabled, editInsideProject: p.permissions.editInsideProject })),
    };
  }

  private async importData(data: any): Promise<Result> {
    if (!data || data.format !== EXPORT_FORMAT) return bad('זה לא קובץ הגדרות של Claude בטלפון');
    const cfg = this.d.cfg;
    const report: string[] = [];
    const patch: Record<string, any> = {};
    if (data.settings && typeof data.settings === 'object') {
      const r = await this.handle('/settings', data.settings);
      report.push(r.code === 200 ? 'הגדרות העבודה והקול יובאו' : `הגדרות העבודה לא יובאו: ${(r.json as any).error}`);
    }
    if (data.quietHours || data.retentionDays !== undefined) {
      const r = await this.handle('/quiet', { ...(data.quietHours ?? {}), ...(data.retentionDays !== undefined && data.retentionDays !== null ? { retentionDays: data.retentionDays } : {}) });
      report.push(r.code === 200 ? 'זמני השקט יובאו' : `זמני השקט לא יובאו: ${(r.json as any).error}`);
    }
    if (cfg && Array.isArray(data.phones)) {
      const phones = [...new Set(data.phones.map((p: unknown) => normalizePhone(String(p))).filter(Boolean) as string[])];
      if (phones.length) { cfg.phones.allowed = phones; patch.phones = { allowed: phones }; report.push(`${phones.length} מספרי טלפון מורשים יובאו`); }
    }
    if (cfg && Array.isArray(data.resumeSources)) {
      const ok = ['sdk', 'desktop', 'cli', 'vscode', 'unknown', 'cowork'];
      const rs = data.resumeSources.filter((x: unknown) => ok.includes(String(x)));
      cfg.history.resumeSources = rs; patch.history = { resumeSources: rs };
    }
    const missing: string[] = [];
    if (Array.isArray(data.projects)) {
      const list: { name: string; spokenName?: string; path: string }[] = [];
      let n = 0;
      for (const p of data.projects) {
        const path = String(p?.path ?? '');
        if (!path || !existsSync(path)) { if (path) missing.push(path); continue; }
        const proj = this.d.store.addProject({ name: String(p.name ?? path), spokenName: String(p.spokenName ?? p.name ?? ''), path });
        this.d.store.updateProject(proj.id, { phoneEnabled: p.phoneEnabled !== false, spokenName: String(p.spokenName || proj.spokenName), editInsideProject: p.editInsideProject !== false });
        list.push({ name: String(p.name ?? proj.name), spokenName: String(p.spokenName ?? ''), path });
        n++;
      }
      if (cfg) {
        const parent = String(data.projectsParent ?? '');
        if (parent && existsSync(parent)) { cfg.projects.newProjectsParent = parent; patch.projects = { newProjectsParent: parent }; }
        const merged = [...cfg.projects.list];
        for (const l of list) if (!merged.some(m => m.path.toLowerCase() === l.path.toLowerCase())) merged.push(l);
        cfg.projects.list = merged;
        patch.projects = { ...(patch.projects ?? {}), list: merged };
      }
      report.push(`${n} פרויקטים יובאו`);
      if (missing.length) report.push(`${missing.length} תיקיות לא קיימות במחשב הזה ודולגו`);
    }
    if (cfg && Object.keys(patch).length) saveUserConfig(patch, this.d.root ?? AGENT_ROOT);
    report.push('טוקן ימות, השלוחה וקוד הכניסה לא נכללים בקובץ: מגדירים אותם באשף ההגדרה');
    log('web', `יובאו הגדרות: ${report.join('; ')}`);
    return ok({ report, missing });
  }
}
