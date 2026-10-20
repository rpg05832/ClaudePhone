// הסוכן: מאגר תפעולי, מנוע ביצוע, תמלול, שרת ימות ומנהרה. מופעל ע"י start-agent.ps1 (פיתוח) או launcher.vbs (התקנה, Windows),
// ובלינוקס ע"י שירות systemd של המשתמש או launcher.sh.
// בלי הגדרה מלאה (טוקן ימות, שלוחה, טלפונים, PIN) הוא עולה במצב "הגדרה": רק לוח הבקרה עם האשף.
// דגלים: --open פותח את הדפדפן; --no-open לא; --restarted (פנימי) ממתין שהמופע הקודם ישחרר את הפורט;
// --open-only (המפעיל בלינוקס): לא מפעיל סוכן, רק מחכה שהסוכן (השירות) יעלה ופותח את הלוח.
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { loadConfig, readSecretFile, saveUserConfig, AGENT_ROOT } from './config.ts';
import { initLog, log, logError } from './log.ts';
import { Store } from './store/db.ts';
import { Tasks } from './store/tasks.ts';
import { PhoneFlow } from './phone/flow.ts';
import { startPhoneServer } from './phone/server.ts';
import { startQuickTunnel } from './phone/tunnel.ts';
import { YemotApi } from './phone/yemot-api.ts';
import { WhisperTranscriber, SmartTranscriber } from './stt/transcriber.ts';
import { ClaudeSpeechToText } from './stt/claude.ts';
import { Worker } from './claude/worker.ts';
import { createProjectFromPhone } from './projects.ts';
import { PinLockout, loadPinHash } from './util/pin.ts';
import { PermissionBroker } from './claude/broker.ts';
import { Notifier } from './notify/notifier.ts';
import { FreeTzintuk } from './notify/free-tzintuk.ts';
import { DEFAULT_QUIET, quietState } from './notify/quiet.ts';
import { ClaudeHistory } from './history/claude-history.ts';
import { ConversationIndex } from './history/conversations.ts';
import { CoworkHistory } from './history/cowork.ts';
import { splitSummary, cleanForSpeech } from './claude/runner.ts';
import { discoverMcp, serverLabel } from './claude/mcp.ts';
import { CHROME_SLUG, CHROME_LABEL, chromePolicy, listChromeBrowsers } from './claude/chrome.ts';
import { checkStaleClaudeLock } from './claude/lock.ts';
import { startDashboard, loadOrCreateToken, maskPhone } from './web/server.ts';
import { DashboardActions } from './web/actions.ts';
import { openDashboardWindow, desktopShortcutScript, startupScript } from './web/open.ts';
import { Updater, installedVersion } from './update/updater.ts';
import { ProjectsLocation } from './projects-location.ts';
import { LiveHub } from './live/hub.ts';
import { samePath } from './history/claude-history.ts';
import { basename, resolve as resolvePath, relative as relPath, isAbsolute as isAbs } from 'node:path';
import { SetupApi, needsSetup } from './setup/routes.ts';
import { packageDir, findPython } from './setup/checks.ts';
import { statSync, unlinkSync, readFileSync } from 'node:fs';
import { hasGui, sdkBinaryPackage, cloudflaredFileName, openFolder, openTerminal, writeClaudeScript, underSystemd, launcherFile, installLinuxAutostart, installLinuxShortcuts, osName } from './platform.ts';

const args = process.argv.slice(2);
const restarted = args.includes('--restarted');
const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
initLog(join(cfg.dataDir, 'agent.log'));

const setupMode = needsSetup(cfg);
const wantOpen = args.includes('--open') || (setupMode && !args.includes('--no-open'));
// --open-only לא יוצר אסימון בעצמו (הסוכן שעולה יוצר אותו), כדי לא להתחרות על הקובץ
const dashToken = args.includes('--open-only') ? '' : loadOrCreateToken(cfg.dashboard.tokenFile);
const dashboardUrl = (hash = '') => `http://127.0.0.1:${cfg.dashboard.port}/?t=${dashToken}${hash}`;

function openBrowser(url: string): void {
  try { openDashboardWindow(url); } catch (e) { logError('main', e, 'open dashboard'); }
}

// מופע יחיד: אם הלוח כבר רץ, רק פותחים אותו בדפדפן ויוצאים
async function portFree(port: number): Promise<boolean> {
  return new Promise(res => {
    const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}
// המפעיל בלינוקס: השירות מפעיל את הסוכן; כאן רק מחכים שהלוח יענה ופותחים אותו
if (args.includes('--open-only')) {
  for (let i = 0; i < 60 && await portFree(cfg.dashboard.port); i++) await new Promise(r => setTimeout(r, 500));
  if (!(await portFree(cfg.dashboard.port))) {
    const t = readSecretFile(cfg.dashboard.tokenFile) ?? '';
    const url = `http://127.0.0.1:${cfg.dashboard.port}/?t=${t}${setupMode ? '#/setup' : ''}`;
    openBrowser(url);
    if (!hasGui()) console.log(`לוח הבקרה: ${url}`);
  } else console.error('הסוכן לא עלה. בדוק: systemctl --user status claudephone');
  setTimeout(() => process.exit(0), 300);
  await new Promise(() => {});
}
const portsFree = async () => (await portFree(cfg.dashboard.port)) && (!restarted || await portFree(cfg.phoneServer.port));
for (let i = 0; !(await portsFree()); i++) {
  if (!restarted || i >= 20) {
    if (!restarted) { if (!args.includes('--no-open')) openBrowser(dashboardUrl()); process.exit(0); }
    log('main', 'הפורט עדיין תפוס אחרי ההפעלה מחדש'); process.exit(3);
  }
  await new Promise(r => setTimeout(r, 500));
}
writeFileSync(join(cfg.dataDir, 'agent.pid'), String(process.pid));
log('main', setupMode ? 'הסוכן עולה במצב הגדרה ראשונית' : 'הסוכן עולה');

/** הפעלה מחדש (אחרי האשף): מופע חדש עולה במצב מלא, הנוכחי יוצא. */
let beforeExit: () => void = () => {};
function restart(): void {
  log('main', 'הפעלה מחדש');
  beforeExit();
  // שירות systemd (לינוקס): יוצאים, ו-systemd מעלה מופע חדש (Restart=always). מופע מנותק היה נהרג יחד עם השירות.
  if (underSystemd()) { setTimeout(() => process.exit(0), 200); return; }
  const rest = args.filter(a => a !== '--open' && a !== '--restarted');
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...rest, '--no-open', '--restarted'],
    { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => process.exit(0), 200);
}

const store = new Store(join(cfg.dataDir, 'agent.db'));
const tasks = new Tasks(store);
const recovered = tasks.recoverAfterRestart();
if (recovered) log('main', `${recovered} משימות שרצו לפני האתחול סומנו "דורשת בדיקה"`);
// בקשות שהיו פתוחות לפני האתחול נסגרות: התהליך שחיכה להן כבר לא קיים, ואין לאשר אותן (אפיון 4)
const closed = store.closeAllPending();
if (closed) log('main', `${closed} בקשות הרשאה פתוחות נסגרו בגלל האתחול`);
for (const p of cfg.projects.list) store.addProject(p);
// כל תיקייה בתוך תיקיית-האם של הפרויקטים נרשמת אוטומטית כפרויקט (שם התיקייה = השם שמוקרא)
if (existsSync(cfg.projects.newProjectsParent)) {
  for (const e of readdirSync(cfg.projects.newProjectsParent, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) store.addProject({ name: e.name, path: join(cfg.projects.newProjectsParent, e.name) });
  }
}
log('main', `פרויקטים זמינים: ${store.listProjects(true).map(p => p.name).join(', ') || 'אין עדיין'}`);

// ---------- היסטוריית Claude ושיחות ----------
const history = new ClaudeHistory();
const cowork = new CoworkHistory();
const conversations = new ConversationIndex(store, history, cfg.history, cowork);
const recDir = join(cfg.dataDir, 'recordings');
mkdirSync(recDir, { recursive: true });
const appVersion = installedVersion(join(AGENT_ROOT, '..'));
const sdkVersion = (() => { try { return JSON.parse(readFileSync(join(packageDir('@anthropic-ai/claude-agent-sdk')!, 'package.json'), 'utf8')).version; } catch { return null; } })();

if (setupMode) {
  const setup = new SetupApi({ cfg, store, mode: 'setup', launcherPath: launcherPath(), dashboardUrl: () => dashboardUrl(), restart, history });
  const srv = startDashboard({
    port: cfg.dashboard.port, tokenFile: cfg.dashboard.tokenFile, staticDir: cfg.dashboard.staticDir, recordingsDir: recDir,
    store, tasks, conversations, history, mode: 'setup', setup,
    health: () => ({ agent: { ok: true, startedAt: new Date().toISOString(), node: process.version, sdk: sdkVersion, version: appVersion } }),
  });
  beforeExit = () => { srv.close(); srv.closeAllConnections(); store.close(); };
  if (wantOpen) openBrowser(dashboardUrl('#/setup'));
  log('main', 'ממתין להשלמת אשף ההגדרה בלוח הבקרה');
} else {

const token = readSecretFile(cfg.yemot.tokenFile)!;
const yemot = new YemotApi(token, cfg.yemot.apiBase);
// Python לתמלול: הנתיב מההגדרות, ואם הוא לא קיים (או רק "python" ו-PATH שבור) מחפשים ושומרים את הנתיב המלא
// (גם כשהתמלול הוא של Claude: ivrit-ai משמש גיבוי, ולכן צריך לדעת אם הוא מותקן)
let localSttInstalled = false;
{
  const py = await findPython(cfg.stt.python);
  localSttInstalled = !!(py.path && py.fasterWhisper && existsSync(cfg.stt.script));
  if (py.path && py.path !== cfg.stt.python) {
    cfg.stt.python = py.path;
    saveUserConfig({ stt: { python: py.path } });
    log('stt', `נמצא Python: ${py.path}${py.fasterWhisper ? '' : ' (בלי faster-whisper)'}`);
  } else if (!py.path) log('stt', 'לא נמצא Python מתאים לתמלול במחשב (ivrit-ai). התמלול ייעשה דרך Claude');
}
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const whisper = new WhisperTranscriber(cfg.stt.python, cfg.stt.script, cfg.stt.model, cfg.stt.timeoutSeconds);
const claudeStt = new ClaudeSpeechToText({ query: query as any });
const stt = new SmartTranscriber(() => store.getSettings().stt, claudeStt, whisper, (p) => readFileSync(p), () => localSttInstalled);
log('stt', `מנוע התמלול: ${store.getSettings().stt === 'claude' ? 'Claude' : 'ivrit-ai'} · ${stt.status().detail}`);
stt.warmup().catch(e => logError('stt', e, 'warmup'));

// ---------- התראות ----------
const quiet = { ...DEFAULT_QUIET, ...cfg.quietHours };
let flowRef: PhoneFlow | null = null;
// צינתוקים חינמיים: רשימה בשם קבוע, שלוחת הרשמה <שלוחה>/1. אם כל הטלפונים רשומים (ורק הם), הצינתוק חינם; אחרת 0.1 יחידה למספר
const freeListName = String(cfg.notifications.freeList ?? '').trim();
const freeTzintuk = freeListName ? new FreeTzintuk({ listName: freeListName, entries: () => yemot.tzintukListEntries(freeListName), allowed: () => cfg.phones.allowed }) : null;
const freeTzintukFolder = `/${cfg.yemot.chatExtension}/1`;
let freeTzintukExtensionReady = false;
async function ensureFreeTzintukExtension(): Promise<void> {
  if (!freeTzintuk || freeTzintukExtensionReady) return;
  try {
    await yemot.setTzintukListExtension(`${cfg.yemot.chatExtension}/1`, freeListName);
    freeTzintukExtensionReady = true;
    const st = await freeTzintuk.check(cfg.phones.allowed, true);
    log('notify', `צינתוקים חינמיים: שלוחת ההרשמה ${freeTzintukFolder} מוכנה (רשימה "${freeListName}"). ${st.ok ? 'כל הטלפונים רשומים: הצינתוקים חינם' : st.missing.length ? `לא רשומים: ${st.missing.map(maskPhone).join(', ')} (הרשמה: בטלפון 7 ואז 9)` : st.foreign.length ? `ברשימה מספר לא מורשה: ${st.foreign.map(maskPhone).join(', ')}; הצינתוקים בתשלום` : 'הרשימה ריקה'}`);
  } catch (e) { logError('notify', e, 'שלוחת צינתוקים חינמיים'); }
}
const notifier = new Notifier({
  store, tasks, quiet,
  phones: () => cfg.phones.allowed,
  tzintuk: async (phones) => {
    if (freeTzintuk) {
      const c = await freeTzintuk.check(phones);
      if (c.ok) {
        try { await yemot.tzintukList(freeListName); return 'free'; }
        catch (e) { logError('notify', e, 'צינתוק לרשימה החינמית; עובר לצינתוק בתשלום'); }
      }
    }
    await yemot.tzintuk(phones);
    return 'paid';
  },
  inCall: (phone) => flowRef?.isPhoneInCall(phone) ?? false,
  maxAttempts: cfg.limits.dialAttempts,
});
const q0 = quietState(new Date(), quiet);
log('main', `התראות: ${store.getSettings().notify === 'on' ? 'צינתוק' : 'כבויות'}; כרגע ${q0.quiet ? 'זמן שקט (' + q0.reason + ')' : 'לא זמן שקט'}`);

const broker = new PermissionBroker({
  store, tasks, minutes: cfg.limits.permissionMinutes,
  onEvent: (kind, id, phone) => { notifier.event(kind, id, phone).catch(e => logError('notify', e, kind)); },
});

// ---------- סשן חי (שלב 5): ערוץ claudephone לשיחת Claude Code פתוחה ----------
// באישור המשתמש (14.10): ערוץ מקומי שאינו ברשימה של Anthropic נטען עם דגל ערוצי הפיתוח, רק בחלון שנפתח לשם כך.
const live = new LiveHub();
const liveTokenFile = join(cfg.dataDir, 'live.token');
const liveToken = loadOrCreateToken(liveTokenFile);
const liveMcpPath = join(cfg.dataDir, 'live-mcp.json');
/** Claude Code של ה-SDK (אותו קובץ שמריץ את המשימות), ואם אין: claude מה-PATH. */
const claudeExe = (() => { const b = sdkBinaryPackage(); const d = packageDir(b.pkg); return d ? join(d, b.file) : 'claude'; })();
let liveCmdPath = '';
{
  const channelScript = join(AGENT_ROOT, 'channel', 'claudephone-channel.mjs');
  writeFileSync(liveMcpPath, JSON.stringify({ mcpServers: { claudephone: {
    command: process.execPath, args: [channelScript],
    env: { CP_AGENT_URL: `http://127.0.0.1:${cfg.dashboard.port}`, CP_LIVE_TOKEN_FILE: liveTokenFile },
  } } }, null, 2));
  const DEV_CHANNELS_FLAG = '--dangerously-load-development-channels';
  liveCmdPath = writeClaudeScript(join(cfg.dataDir, 'claude-live'), claudeExe, ['--mcp-config', liveMcpPath, DEV_CHANNELS_FLAG, 'server:claudephone'], true);
}
/** הפרויקט של תיקיית סשן חי: פרויקט רשום שמכיל אותה, או פרויקט חדש (לא מוצג בתפריט 3) כדי שהמשימה תשויך למשהו. */
function projectForCwd(cwd: string): string {
  const inside = (root: string) => { const r = relPath(resolvePath(root), resolvePath(cwd)); return r === '' || (!r.startsWith('..') && !isAbs(r)); };
  const p = store.listProjects().filter(x => samePath(x.path, cwd) || inside(x.path)).sort((a, b) => b.path.length - a.path.length)[0];
  return (p ?? store.addProject({ name: basename(cwd) || cwd, path: cwd, phoneEnabled: false })).id;
}
/** שיחה מחוץ לפרויקטים שממשיכים: הפרויקט שמכיל את התיקייה, או רישום אוטומטי שלה (לא מופיע במקש 3). */
function ensureProjectForFolder(folder: string): string {
  const inside = (root: string) => { const r = relPath(resolvePath(root), resolvePath(folder)); return r === '' || (!r.startsWith('..') && !isAbs(r)); };
  const p = store.listProjects().filter(x => samePath(x.path, folder) || inside(x.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (p) { if (!p.phoneEnabled) throw new Error('הפרויקט של השיחה הזו כבוי בטלפון'); return p.id; }
  if (!existsSync(folder)) throw new Error('התיקייה של השיחה כבר לא קיימת במחשב');
  const np = store.addProject({ name: basename(folder) || folder, path: folder, phoneEnabled: true, listed: false });
  log('projects', `נרשמה אוטומטית תיקייה של שיחה: ${folder}`);
  return np.id;
}
function openLiveTerminal(projectId: string): string {
  const p = store.getProject(projectId);
  if (!p) throw new Error('הפרויקט לא נמצא');
  if (!existsSync(p.path)) throw new Error('תיקיית הפרויקט לא קיימת');
  openTerminal('Claude בטלפון', p.path, liveCmdPath);
  return p.path;
}
/** חלון טרמינל שממשיך שיחה קיימת בתיקייה שלה (כפתור "פתח בטרמינל" בלוח). המזהה מהאינדקס שלנו, לא מהלקוח. */
const resumeCmdPath = writeClaudeScript(join(cfg.dataDir, 'claude-resume'), claudeExe, ['--resume'], true);
function openResumeTerminal(conversationId: string, cwd: string): void {
  if (!/^[\w-]+$/.test(conversationId)) throw new Error('מזהה שיחה לא תקין');
  openTerminal('Claude Code', cwd, resumeCmdPath, [conversationId]);
}
function openFolderWindow(path: string): void { openFolder(path); }

/** חיבורי MCP שפתוחים לטלפון, עם שמות להקראה ורשימת כל השרתים המוכרים (להסתרת השאר). */
function mcpPolicy() {
  const chromeOn = !!cfg.mcp.chrome?.enabled;
  if (!cfg.mcp.enabled.length && !chromeOn) return undefined;
  const known = cfg.mcp.scan?.servers ?? [];
  const labels: Record<string, string> = Object.fromEntries(known.map(s => [s.slug, serverLabel(s.name)]));
  const enabled = cfg.mcp.enabled.filter(s => s !== CHROME_SLUG);
  if (chromeOn) { enabled.push(CHROME_SLUG); labels[CHROME_SLUG] = CHROME_LABEL; }
  return { enabled, labels, known: known.map(s => s.slug).filter(s => s !== CHROME_SLUG), ...(chromeOn ? { chrome: chromePolicy(cfg.mcp.chrome) } : {}) };
}
const worker = new Worker({
  store, tasks, query: query as any, maxTurns: cfg.claude.maxTurns, model: cfg.claude.model, permissionMinutes: cfg.limits.permissionMinutes,
  broker,
  mcp: () => mcpPolicy(),
  coworkRun: (id) => conversations.coworkRun(id),
  live: { send: (sid, chat, text, onPerm) => live.send(sid, chat, text, onPerm), cancel: (sid, chat) => live.cancel(sid, chat) },
  // משימה שנשלחה מלוח הבקרה: המשתמש ליד המחשב, בלי צינתוק על הסיום
  onFinished: (t) => { if (t.source === 'dashboard') return; notifier.event(t.state === 'done' ? 'done' : 'failed', t.id, t.phone).catch(e => logError('notify', e, 'finished')); },
});

// מצב חי לשורת המצב בלוח הבקרה
const state = { startedAt: new Date().toISOString(), tunnelSince: null as string | null, extensionUpdatedAt: null as string | null, lastTunnelError: null as string | null, lockFixedAt: null as string | null };

async function downloadRecording(yemotPath: string, prefix: string): Promise<string> {
  const buf = await yemot.downloadFile(yemotPath);
  const local = join(recDir, `${prefix}-${Date.now()}.wav`);
  writeFileSync(local, buf);
  yemot.deleteFile(yemotPath).catch(e => log('yemot', 'מחיקת ההקלטה מימות נכשלה:', e.message));
  return local;
}

const flow = new PhoneFlow({
  store, tasks,
  allowedPhones: () => cfg.phones.allowed,
  pinHash: () => loadPinHash(cfg.phones.pinHashFile),
  pinRequired: () => store.getSettings().pin !== 'off',
  lockout: new PinLockout(cfg.phones.lockoutAttempts, cfg.phones.lockoutMinutes),
  limits: cfg.limits,
  transcribeRecording: async (yemotPath, taskId) => {
    const local = await downloadRecording(yemotPath, taskId);
    tasks.patch(taskId, { recordingPath: local });
    return stt.transcribe(local);
  },
  transcribeAudio: async (yemotPath) => stt.transcribe(await downloadRecording(yemotPath, 'explain')),
  decide: (id, d, via) => broker.decide(id, d, via),
  conversations: () => conversations.forPhone(),
  allConversations: () => conversations.allForPhone(),
  ensureProject: (folder) => ensureProjectForFolder(folder),
  liveSessions: () => live.list().map(l => { const pid = projectForCwd(l.cwd); return { id: l.id, name: store.getProject(pid)?.spokenName ?? l.name, projectId: pid }; }),
  lastAnswer: (id) => {
    const last = conversations.messages(id, 50).filter(m => m.role === 'assistant' && m.text.trim()).pop();
    if (!last) return null;
    // לפי ההגדרה: התשובה המלאה (אפשר לקטוע בהקשה), או הסיכום הקצר שבראשה
    if (store.getSettings().readback === 'full') return cleanForSpeech(last.text);
    const t = cleanForSpeech(splitSummary(last.text).summary || last.text);
    return t.length > 700 ? t.slice(0, 700) + '. ההמשך בלוח הבקרה' : t;
  },
  createProject: (name) => createProjectFromPhone(store, cfg.projects.newProjectsParent, name, cfg.projects.initGit),
  kickWorker: () => worker.kick(),
  requestStop: (id, actor) => worker.requestStop(id, actor),
  applyVoice: async (voice, rate) => {
    if (!currentUrl) throw new Error('המנהרה עוד לא מחוברת');
    await yemot.setApiExtension(cfg.yemot.chatExtension, currentUrl + cfg.phoneServer.path, { voice, rate });
  },
  mcpConnections: () => { const p = mcpPolicy(); return p ? p.enabled.map(s => p.labels[s] ?? s) : []; },
  sttChanged: () => { if (localSttInstalled) whisper.warmup().catch(e => logError('stt', e, 'warmup')); },
  freeTzintuk: () => (freeTzintuk && freeTzintukExtensionReady ? { folder: freeTzintukFolder, onRedirect: () => freeTzintuk.invalidate() } : null),
});

flowRef = flow;
await startPhoneServer({ port: cfg.phoneServer.port, path: cfg.phoneServer.path, flow });
worker.kick();
notifier.start();

// ---------- עדכון מתוך התוכנה, תיקיית הפרויקטים ----------
const updater = new Updater({
  repo: cfg.update.repo, apiBase: cfg.update.apiBase, current: appVersion, checkHours: cfg.update.checkHours, auto: cfg.update.auto,
  disabledReason: process.platform !== 'win32' && process.platform !== 'linux' ? `העדכון לא זמין ב-${osName()}` : null,
  // עדכון אוטומטי רק כשאין עבודה: אין משימה פעילה, אין שיחת טלפון ואין בקשה שממתינה
  canAutoInstall: () => !tasks.listActive().length && !flow.activeCalls() && !store.pendingPermissionRequests().length,
});
updater.start();
const location = new ProjectsLocation({
  cfg, store,
  busy: (projectId, path) => {
    if (tasks.listActive().some(t => t.projectId === projectId)) return 'יש משימה פעילה בפרויקט';
    if (live.list().some(l => samePath(l.cwd, path) || isInsidePath(path, l.cwd))) return 'יש שיחה פתוחה בתיקייה הזו';
    return null;
  },
});

// ---------- לוח הבקרה ----------
const setup = new SetupApi({ cfg, store, mode: 'running', launcherPath: launcherPath(), dashboardUrl: () => dashboardUrl(), restart, history });
const dash = startDashboard({
  port: cfg.dashboard.port, tokenFile: cfg.dashboard.tokenFile, staticDir: cfg.dashboard.staticDir, recordingsDir: recDir,
  store, tasks, conversations, history, mode: 'running', setup,
  live, liveToken,
  update: () => updater.state,
  location: () => location.info(),
  quietConfig: () => ({ start: quiet.start, end: quiet.end, shabbatAndChag: quiet.shabbatAndChag, includeCholHamoed: quiet.includeCholHamoed, retentionDays: cfg.retention.recordingsDays }),
  actions: new DashboardActions({
    store, tasks, conversations, cfg, quiet,
    openLive: (projectId) => openLiveTerminal(projectId),
    openTerminal: (id, cwd) => openResumeTerminal(id, cwd),
    openFolder: (p) => openFolderWindow(p),
    sttChanged: () => { if (localSttInstalled) whisper.warmup().catch(e => logError('stt', e, 'warmup')); },
    scanMcp: () => discoverMcp(query as any, cfg.projects.newProjectsParent && existsSync(cfg.projects.newProjectsParent) ? cfg.projects.newProjectsParent : AGENT_ROOT),
    listChrome: () => listChromeBrowsers(query as any, cfg.projects.newProjectsParent && existsSync(cfg.projects.newProjectsParent) ? cfg.projects.newProjectsParent : AGENT_ROOT),
    updater, location,
    ensureProject: (folder) => ensureProjectForFolder(folder),
    createProject: (name) => createProjectFromPhone(store, cfg.projects.newProjectsParent, name, cfg.projects.initGit),
    kickWorker: () => worker.kick(),
    requestStop: (id, actor) => worker.requestStop(id, actor),
    decide: (id, dd, via) => broker.decide(id, dd, via),
    applyVoice: async (voice, rate) => {
      if (!currentUrl) throw new Error('המנהרה עוד לא מחוברת');
      await yemot.setApiExtension(cfg.yemot.chatExtension, currentUrl + cfg.phoneServer.path, { voice, rate });
    },
  }),
  health: () => ({
    agent: { ok: true, startedAt: state.startedAt, node: process.version, sdk: sdkVersion, version: appVersion },
    tunnel: { ok: !!currentUrl, mode: cfg.tunnel.mode === 'none' ? 'none' : 'quick', url: currentUrl ? currentUrl + (cfg.tunnel.mode === 'none' ? cfg.phoneServer.path : '') : null, since: state.tunnelSince, error: state.lastTunnelError },
    yemot: { ok: !!state.extensionUpdatedAt, extension: cfg.yemot.chatExtension, updatedAt: state.extensionUpdatedAt },
    stt: { ...stt.status(), model: cfg.stt.model, last: stt.lastEngine },
    claude: { ok: true, busyWith: worker.busyWith, claudeCodeVersion: history.list().find(h => h.version)?.version ?? null, lockFixedAt: state.lockFixedAt },
    phone: { activeCalls: flow.activeCalls() },
    quiet: quietState(new Date(), quiet),
    freeTzintuk: freeTzintuk ? { ...freeTzintuk.status(), ready: freeTzintukExtensionReady, folder: freeTzintukFolder } : null,
    retentionDays: cfg.retention.recordingsDays,
  }),
});

// ---------- מדיניות שמירת הקלטות (אפיון 5: 7 ימים) ----------
function cleanRecordings(): void {
  if (cfg.retention.recordingsDays <= 0) return;
  const cutoff = Date.now() - cfg.retention.recordingsDays * 86_400_000;
  let n = 0;
  for (const f of readdirSync(recDir)) {
    const p = join(recDir, f);
    try { if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); n++; } } catch { /* נמשיך */ }
  }
  if (n) log('main', `נמחקו ${n} הקלטות ישנות מ-${cfg.retention.recordingsDays} ימים`);
}
// נבדק כל 6 שעות; 0 ימים = לא מוחקים (אפשר לשנות בלוח בלי אתחול)
cleanRecordings(); setInterval(cleanRecordings, 6 * 3600_000).unref();

// 0.7.7: נעילה תקועה של Claude Code (~/.claude.lock עם קבצים בפנים) מונעת חידוש התחברות, וכל משימה נכשלת.
// בודקים בהפעלה וכל שעה, ומזיזים הצידה (lock.ts).
function fixClaudeLock(): void {
  try {
    const r = checkStaleClaudeLock(undefined, { fix: true });
    if (r.stale) { log('claude', r.detail); if (r.movedTo) state.lockFixedAt = new Date().toISOString(); }
  } catch (e) { logError('claude', e, 'בדיקת נעילה'); }
}
fixClaudeLock(); setInterval(fixClaudeLock, 3600_000).unref();

// ---------- מנהרה + עדכון השלוחה בימות ----------
let currentUrl = '';
let stopping = false;
let currentTunnelStop: () => void = () => {};
const ttsSettings = () => { const s = store.getSettings(); return { voice: s.voice, rate: s.rate }; };
async function connectTunnel(attempt = 1): Promise<void> {
  if (cfg.tunnel.mode === 'none') {
    // כתובת ציבורית של המשתמש (שרת עם דומיין): אין מנהרה, השלוחה נרשמת ישר לכתובת
    currentUrl = cfg.tunnel.publicUrl;
    if (!currentUrl) { state.lastTunnelError = 'לא הוגדרה כתובת ציבורית (tunnel.publicUrl)'; logError('tunnel', new Error(state.lastTunnelError)); return; }
    try {
      await yemot.setApiExtension(cfg.yemot.chatExtension, currentUrl + cfg.phoneServer.path, ttsSettings());
      state.extensionUpdatedAt = new Date().toISOString(); state.tunnelSince = state.tunnelSince ?? new Date().toISOString(); state.lastTunnelError = null;
      log('main', `שלוחה ${cfg.yemot.chatExtension} מחוברת לכתובת ${currentUrl}${cfg.phoneServer.path}`);
      void ensureFreeTzintukExtension();
    } catch (e) {
      logError('tunnel', e, `ניסיון ${attempt}`);
      state.lastTunnelError = e instanceof Error ? e.message : String(e);
      setTimeout(() => connectTunnel(attempt + 1), Math.min(60_000, 5000 * attempt));
    }
    return;
  }
  try {
    const exe = cfg.tunnel.cloudflaredPath || join(AGENT_ROOT, 'bin', cloudflaredFileName());
    if (!existsSync(exe)) throw new Error(`cloudflared לא נמצא: ${exe}`);
    const t = await startQuickTunnel(exe, cfg.phoneServer.port);
    currentTunnelStop = t.stop;
    currentUrl = t.url; state.tunnelSince = new Date().toISOString(); state.lastTunnelError = null;
    await yemot.setApiExtension(cfg.yemot.chatExtension, t.url + cfg.phoneServer.path, ttsSettings());
    state.extensionUpdatedAt = new Date().toISOString();
    log('main', `שלוחה ${cfg.yemot.chatExtension} מחוברת למחשב`);
    void ensureFreeTzintukExtension();
    t.onExit(() => { if (stopping) return; log('main', 'המנהרה נפלה; מתחבר מחדש'); currentUrl = ''; state.extensionUpdatedAt = null; setTimeout(() => connectTunnel(), 5000); });
  } catch (e) {
    logError('tunnel', e, `ניסיון ${attempt}`);
    state.lastTunnelError = e instanceof Error ? e.message : String(e);
    const delay = Math.min(60_000, 5000 * attempt);
    setTimeout(() => connectTunnel(attempt + 1), delay);
  }
}
if (wantOpen) openBrowser(dashboardUrl());
// הפעלה אוטומטית בכניסה ל-Windows: קיצור דרך בתיקיית Startup (מחליף משימה מתוזמנת שנכשלה בנתיב עם עברית)
if (process.platform === 'win32' && launcherPath() && !existsSync(join(cfg.dataDir, 'startup-v1.done'))) {
  const st = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', startupScript(launcherPath()!)], { windowsHide: true, stdio: 'ignore' });
  st.on('exit', (code) => { if (code === 0) { writeFileSync(join(cfg.dataDir, 'startup-v1.done'), new Date().toISOString()); log('main', 'ההפעלה האוטומטית נרשמה בתיקיית Startup'); } });
}
// קיצור הדרך בשולחן העבודה: קיצור אחד "Claude בטלפון" עם הסמל של התוכנה (מחליף את "לוח הבקרה - Claude בטלפון")
if (process.platform === 'win32' && !existsSync(join(cfg.dataDir, 'shortcut-v3.done'))) {
  const sc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', desktopShortcutScript(dashboardUrl(), launcherPath())], { windowsHide: true, stdio: 'ignore' });
  sc.on('exit', (code) => { if (code === 0) writeFileSync(join(cfg.dataDir, 'shortcut-v3.done'), new Date().toISOString()); });
}
// לינוקס (התקנה): שירות systemd וקיצורי דרך, פעם אחת
if (process.platform === 'linux' && launcherPath() && !existsSync(join(cfg.dataDir, 'linux-integration-v1.done'))) {
  try {
    const a = installLinuxAutostart(join(AGENT_ROOT, '..'), launcherPath()!);
    const sc = installLinuxShortcuts(join(AGENT_ROOT, '..'), launcherPath()!);
    log('main', `${a.note}; ${sc.note}`);
    if (a.ok) writeFileSync(join(cfg.dataDir, 'linux-integration-v1.done'), new Date().toISOString());
  } catch (e) { logError('main', e, 'linux integration'); }
}
await connectTunnel();

beforeExit = () => { stopping = true; updater.stop(); dash.close(); dash.closeAllConnections(); notifier.stop(); stt.stop(); currentTunnelStop(); store.close(); };
}

/** בהתקנה (dist/agent.mjs) ה-launcher נמצא בתיקיית האפליקציה; בפיתוח אין הפעלה אוטומטית מהאשף. */
function launcherPath(): string | null {
  const p = launcherFile(join(AGENT_ROOT, '..'));
  return existsSync(p) ? p : null;
}

/** האם child בתוך parent (path.relative: ב-Windows בלי הבחנה בין אותיות גדולות לקטנות, בלינוקס עם). */
function isInsidePath(parent: string, child: string): boolean {
  const r = relPath(resolvePath(parent), resolvePath(child));
  return r !== '' && !r.startsWith('..') && !isAbs(r);
}

const shutdown = () => { log('main', 'הסוכן נסגר'); try { beforeExit(); } catch { /* */ } process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
