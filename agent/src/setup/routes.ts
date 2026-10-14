// אשף ההגדרה: ה-API שמאחורי המסכים (אפיון 7). כל פעולה שמשנה משהו היא POST עם הגנות CSRF (בשרת הלוח).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config.ts';
import { saveUserConfig, readSecretFile, AGENT_ROOT } from '../config.ts';
import type { Store, EditMode } from '../store/db.ts';
import { VOICES } from '../store/db.ts';
import { YemotApi } from '../phone/yemot-api.ts';
import { savePinHash, loadPinHash } from '../util/pin.ts';
import { systemReport, run } from './checks.ts';
import { SetupJobs, type InstallItem } from './jobs.ts';
import { knownFolders } from './known-folders.ts';
import type { ClaudeHistory } from '../history/claude-history.ts';
import { desktopShortcutScript, startupScript, pickFolder } from '../web/open.ts';
import { defaultProjectsParent, claudeProjectsDir } from '../projects-location.ts';
import { log } from '../log.ts';

export interface SetupDeps {
  cfg: Config;
  store: Store;
  mode: 'setup' | 'running';
  /** נתיב launcher.vbs בהתקנה (להפעלה אוטומטית); null בהתקנת פיתוח. */
  launcherPath: string | null;
  /** קיצור הדרך ללוח הבקרה (כתובת עם אסימון). */
  dashboardUrl: () => string;
  /** יצירת קיצורי הדרך במחשב (בבדיקות: מוחלף, כדי לא לגעת בשולחן העבודה האמיתי). */
  makeShortcut?: () => Promise<string>;
  /** הפעלה מחדש של הסוכן במצב מלא, אחרי סיום האשף. */
  restart: () => void;
  /** היסטוריית Claude, להצעת תיקיות שכבר עבדו בהן. */
  history?: ClaudeHistory;
  /** תיקיית הסוכן שבה נשמר config.json (בבדיקות: תיקייה זמנית). */
  root?: string;
}

export interface SetupStatus {
  mode: 'setup' | 'running';
  done: { claude: boolean; yemot: boolean; phones: boolean; pin: boolean; projects: boolean; finished: boolean };
  yemot: { extension: string };
  phones: string[];
  projectsParent: string;
  claudeProjectsDir: string | null;
  desktopProjectsDir: string;
  projectsExtra: string[];
}

export function needsSetup(cfg: Config): boolean {
  return !readSecretFile(cfg.yemot.tokenFile) || !cfg.yemot.chatExtension || !cfg.phones.allowed.length || !loadPinHash(cfg.phones.pinHashFile);
}

/** מספר טלפון ישראלי בפורמט שימות שולחת (05XXXXXXXX / 0XXXXXXXX). */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^0\d{8,9}$/.test(d) ? d : null;
}

export class SetupApi {
  readonly jobs = new SetupJobs();
  constructor(private d: SetupDeps) {}

  private get cfg() { return this.d.cfg; }
  private get root() { return this.d.root ?? AGENT_ROOT; }

  status(): SetupStatus {
    const c = this.cfg;
    return {
      mode: this.d.mode,
      done: {
        claude: false,   // נבדק בבדיקת המחשב (לוקח כמה שניות)
        yemot: !!readSecretFile(c.yemot.tokenFile) && !!c.yemot.chatExtension,
        phones: c.phones.allowed.length > 0,
        pin: !!loadPinHash(c.phones.pinHashFile),
        projects: !/\\USER\\/.test(c.projects.newProjectsParent) && existsSync(c.projects.newProjectsParent),
        finished: !needsSetup(c) && (c as any).setupDone === true,
      },
      yemot: { extension: c.yemot.chatExtension },
      phones: c.phones.allowed.map(p => '•••' + p.slice(-4)),
      projectsParent: /\\USER\\/.test(c.projects.newProjectsParent) ? defaultProjectsParent() : c.projects.newProjectsParent,
      claudeProjectsDir: claudeProjectsDir(),
      desktopProjectsDir: join(homedir(), 'Desktop', 'ClaudeProjects'),
      projectsExtra: c.projects.list.map(p => p.path),
    };
  }

  async handle(method: string, path: string, body: any): Promise<{ code: number; json: unknown }> {
    const ok = (json: unknown) => ({ code: 200, json });
    const bad = (error: string) => ({ code: 400, json: { error } });
    const c = this.cfg;

    if (method === 'GET' && path === '/status') return ok(this.status());
    if (method === 'GET' && path === '/checks') {
      return ok(await systemReport({ dataDir: c.dataDir, cloudflaredPath: this.cloudflaredPath(), pythonConfigured: c.stt.python }));
    }
    if (method === 'GET' && path === '/known-folders') {
      const parent = this.status().projectsParent;
      const inParent = (p: string) => { const a = p.toLowerCase(), b = parent.toLowerCase().replace(/[\\/]+$/, ''); return a !== b && (a.startsWith(b + '\\') || a.startsWith(b + '/')); };
      const list = knownFolders({ history: this.d.history, exclude: [dirname(this.root), parent] .filter(Boolean) });
      const chosen = new Set(c.projects.list.map(p => p.path.toLowerCase()));
      // תיקיות בתוך תיקיית הפרויקטים נרשמות ממילא; מציגים רק את השאר
      return ok(list.filter(f => !inParent(f.path)).map(f => ({ ...f, selected: chosen.has(f.path.toLowerCase()) })));
    }
    let m = path.match(/^\/jobs\/([\w-]+)$/);
    if (method === 'GET' && m) { const j = this.jobs.get(m[1]); return j ? ok(j) : { code: 404, json: { error: 'לא נמצא' } }; }
    if (method !== 'POST') return { code: 404, json: { error: 'לא נמצא' } };

    switch (path) {
      case '/install': {
        const items = (Array.isArray(body?.items) ? body.items : []).filter((i: string) => ['python', 'fasterWhisper', 'model', 'cloudflared'].includes(i)) as InstallItem[];
        if (!items.length) return bad('לא נבחרו רכיבים');
        const job = this.jobs.startInstall(items, {
          cloudflaredPath: this.cloudflaredPath(),
          pythonConfigured: c.stt.python,
          onPython: (p) => { c.stt.python = p; saveUserConfig({ stt: { python: p } }, this.root); },
        });
        return ok(job);
      }
      case '/claude-login': return ok(this.jobs.startClaudeLogin());

      case '/yemot': {
        const token = String(body?.token ?? '').trim();
        const ext = String(body?.extension ?? '').trim().replace(/^\/+|\/+$/g, '');
        const useSaved = !token && !!readSecretFile(c.yemot.tokenFile);
        const tok = token || readSecretFile(c.yemot.tokenFile) || '';
        if (!tok) return bad('יש להדביק טוקן API של ימות');
        if (!/^[\d/]{1,20}$/.test(ext)) return bad('מספר שלוחה לא תקין (ספרות, ולתת-שלוחה לוכסן: 9 או 9/1)');
        const api = new YemotApi(tok, c.yemot.apiBase);
        let session;
        try { session = await api.getSession(); }
        catch (e) { return bad(`הטוקן לא התקבל בימות: ${e instanceof Error ? e.message : e}`); }
        // שלוחה קיימת מסוג אחר: מבקשים אישור לפני שמחליפים אותה
        const ini = await api.getTextFile(`ivr2:${ext}/ext.ini`);
        const type = ini?.match(/^\s*type\s*=\s*(\S+)/m)?.[1] ?? null;
        if (type && type !== 'api' && !body?.replace) {
          return ok({ needsConfirm: true, existingType: type, systemNumber: session.systemNumber, units: session.units });
        }
        if (!useSaved) { mkdirSync(dirname(c.yemot.tokenFile), { recursive: true }); writeFileSync(c.yemot.tokenFile, tok + '\n', 'utf8'); }
        c.yemot.chatExtension = ext;
        saveUserConfig({ yemot: { chatExtension: ext } }, this.root);
        log('setup', `ימות: מערכת ${session.systemNumber}, שלוחה ${ext}`);
        return ok({ saved: true, systemNumber: session.systemNumber, units: session.units, existingType: type });
      }

      case '/phones': {
        const phones = (Array.isArray(body?.phones) ? body.phones : []).map((p: string) => normalizePhone(String(p))).filter(Boolean) as string[];
        if (!phones.length) return bad('יש להזין לפחות מספר טלפון אחד תקין');
        const pin = String(body?.pin ?? '');
        const hasPin = !!loadPinHash(c.phones.pinHashFile);
        if (pin) {
          if (!/^\d{4,8}$/.test(pin)) return bad('הקוד חייב להיות 4 עד 8 ספרות');
          savePinHash(c.phones.pinHashFile, pin);
        } else if (!hasPin) return bad('יש לבחור קוד PIN');
        c.phones.allowed = [...new Set(phones)];
        saveUserConfig({ phones: { allowed: c.phones.allowed } }, this.root);
        return ok({ saved: true, count: c.phones.allowed.length });
      }

      case '/projects': {
        const parent = String(body?.parent ?? '').trim() || defaultProjectsParent();
        try { mkdirSync(parent, { recursive: true }); } catch { return bad('לא ניתן ליצור את התיקייה'); }
        // כל פריט: נתיב, או {path, name} (שם פרויקט Cowork למשל)
        const extra = (Array.isArray(body?.extra) ? body.extra : [])
          .map((e: any) => typeof e === 'string' ? { path: e.trim(), name: '' } : { path: String(e?.path ?? '').trim(), name: String(e?.name ?? '').trim() })
          .filter((e: { path: string }) => e.path);
        const missing = extra.filter((e: { path: string }) => !existsSync(e.path));
        if (missing.length) return bad(`תיקיות שלא נמצאו: ${missing.map((e: { path: string }) => e.path).join(', ')}`);
        const before = c.projects.list.map(p => p.path);
        c.projects.newProjectsParent = parent;
        const seen = new Set<string>();
        c.projects.list = extra.filter((e: { path: string }) => !seen.has(e.path.toLowerCase()) && seen.add(e.path.toLowerCase()))
          .map((e: { path: string; name: string }) => ({ name: e.name || (e.path.split(/[\\/]/).filter(Boolean).pop() ?? e.path), path: e.path }));
        saveUserConfig({ projects: { newProjectsParent: parent, list: c.projects.list } }, this.root);
        for (const p of c.projects.list) { this.d.store.addProject(p); this.d.store.setProjectPhoneEnabled(p.path, true); }
        // תיקייה שהוסרה מהבחירה יוצאת מהטלפון; ההיסטוריה שלה נשמרת
        for (const p of before) if (!c.projects.list.some(x => x.path === p)) this.d.store.setProjectPhoneEnabled(p, false);
        return ok({ saved: true });
      }

      case '/prefs': {
        const modes: EditMode[] = ['readonly', 'edit', 'auto'];
        if (body?.editMode && modes.includes(body.editMode)) this.d.store.setSetting('editMode', body.editMode);
        if (body?.voice && VOICES.some(v => v.id === body.voice)) this.d.store.setSetting('voice', body.voice);
        if (Number.isFinite(Number(body?.rate))) this.d.store.setSetting('rate', Math.max(-10, Math.min(10, Number(body.rate))));
        if (body?.notify === 'on' || body?.notify === 'off') this.d.store.setSetting('notify', body.notify);
        return ok({ saved: true, settings: this.d.store.getSettings() });
      }

      case '/pick-folder': {
        const picked = await pickFolder(String(body?.initial ?? '') || null, String(body?.title ?? 'בחר תיקייה'));
        return ok({ path: picked });
      }

      case '/finish': {
        if (needsSetup(c)) return bad('חסרים פרטים: ימות, טלפונים או קוד PIN');
        saveUserConfig({ setupDone: true }, this.root);
        (c as any).setupDone = true;
        const notes: string[] = [];
        if (this.d.launcherPath) {
          // קיצור דרך בתיקיית ההפעלה (ולא משימה מתוזמנת, שנכשלת כשבנתיב יש עברית)
          const r = this.d.makeShortcut ? { code: 0 } : await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', startupScript(this.d.launcherPath)], 60_000);
          notes.push(r.code === 0 ? 'הסוכן יעלה אוטומטית בכל כניסה ל-Windows' : 'רישום ההפעלה האוטומטית נכשל');
        }
        notes.push(await this.createShortcut());
        // אחרי שהתשובה נשלחת: הסוכן עולה מחדש במצב מלא (מנהרה, ימות, טלפון)
        setTimeout(() => this.d.restart(), 800);
        return ok({ saved: true, notes });
      }

      case '/test-tzintuk': {
        if (this.d.mode !== 'running') return bad('הסוכן עוד לא פועל במצב מלא');
        const tok = readSecretFile(c.yemot.tokenFile);
        if (!tok) return bad('אין טוקן ימות');
        try { await new YemotApi(tok, c.yemot.apiBase).tzintuk(c.phones.allowed); return ok({ sent: true }); }
        catch (e) { return bad(`הצינתוק נכשל: ${e instanceof Error ? e.message : e}`); }
      }
    }
    return { code: 404, json: { error: 'לא נמצא' } };
  }

  private cloudflaredPath(): string {
    return this.cfg.tunnel.cloudflaredPath || join(dirname(this.cfg.dataDir), 'bin', 'cloudflared.exe');
  }

  private async createShortcut(): Promise<string> {
    if (this.d.makeShortcut) return this.d.makeShortcut();
    if (process.platform !== 'win32') return 'קיצור דרך נוצר רק ב-Windows';
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', desktopShortcutScript(this.d.dashboardUrl(), this.d.launcherPath)], 30_000);
    return r.code === 0 ? 'נוצר קיצור דרך "Claude בטלפון" בשולחן העבודה: מפעיל את התוכנה ופותח את הלוח' : 'יצירת קיצור הדרך נכשלה';
  }
}
