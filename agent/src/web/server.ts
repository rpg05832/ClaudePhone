// שרת לוח הבקרה (אפיון 6): מאזין רק ל-127.0.0.1, דורש אסימון מקומי, ומגיש את ממשק ה-React ו-API לקריאה.
// הלוח: קריאה, ופעולות (שלב 4) ואשף ההגדרה ב-POST בלבד, עם הגנת CSRF (Origin + כותרת X-CP).
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, resolve, relative, isAbsolute, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/db.ts';
import type { Tasks } from '../store/tasks.ts';
import type { ConversationIndex } from '../history/conversations.ts';
import type { ClaudeHistory } from '../history/claude-history.ts';
import type { SetupApi } from '../setup/routes.ts';
import type { DashboardActions } from './actions.ts';
import type { LiveHub } from '../live/hub.ts';
import { log, logError } from '../log.ts';

export interface DashboardDeps {
  port: number;
  tokenFile: string;
  staticDir: string;           // ה-build של הממשק (agent/web)
  recordingsDir: string;
  store: Store; tasks: Tasks;
  conversations: ConversationIndex;
  history: ClaudeHistory;
  /** מצב חי של הרכיבים (מנהרה, תמלול, מנוע) לשורת המצב ולמסך התקינות. */
  health: () => Record<string, unknown>;
  /** 'setup' כשההגדרה הראשונית לא הושלמה: הלוח מציג רק את האשף. */
  mode?: 'setup' | 'running';
  setup?: SetupApi;
  /** פעולות מהלוח (שלב 4). בלי זה הלוח לקריאה בלבד. */
  actions?: DashboardActions;
  /** סשן חי (שלב 5): שרת הערוץ פונה עם האסימון הזה בכותרת X-CP-Live. */
  live?: LiveHub;
  liveToken?: string;
  /** הגדרות זמני השקט ושמירת ההקלטות, לעריכה בלוח. */
  quietConfig?: () => { start: string; end: string; shabbatAndChag: boolean; includeCholHamoed: boolean; retentionDays: number };
  /** מצב העדכון (גרסה מותקנת, גרסה זמינה, התקדמות). */
  update?: () => unknown;
  /** תיקיית הפרויקטים: מיקום, הצעות ומה יעבור בהעברה. */
  location?: () => unknown;
  /** נקרא כשהפורט תפוס (מופע אחר כבר רץ). */
  onPortBusy?: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) { const t = readFileSync(file, 'utf8').trim(); if (t.length >= 32) return t; }
  mkdirSync(dirname(file), { recursive: true });
  const t = randomBytes(24).toString('hex');
  writeFileSync(file, t + '\n', 'utf8');
  return t;
}

export function startDashboard(d: DashboardDeps): http.Server {
  const token = loadOrCreateToken(d.tokenFile);
  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { logError('web', e, req.url ?? ''); if (!res.headersSent) json(res, 500, { error: 'שגיאה פנימית' }); });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // הגנה מפני DNS rebinding: רק כתובות מקומיות
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return text(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // ערוץ הסשן החי: תהליך מקומי עם אסימון משלו (לא עוגייה)
    if (url.pathname.startsWith('/live/') && d.live && d.liveToken) {
      if (!safeEqual(String(req.headers['x-cp-live'] ?? ''), d.liveToken)) return json(res, 401, { error: 'אסימון שגוי' });
      return liveApi(req, url, res);
    }

    // כניסה מקיצור הדרך: ?t=<אסימון> שומר עוגייה ומפנה לכתובת נקייה
    if (url.searchParams.has('t')) {
      if (!safeEqual(url.searchParams.get('t')!, token)) return text(res, 401, 'אסימון שגוי');
      res.writeHead(302, { 'set-cookie': `cp_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: url.pathname });
      return res.end();
    }
    if (!safeEqual(cookie(req, 'cp_token') ?? '', token)) {
      return text(res, 401, 'נדרשת כניסה מקיצור הדרך "Claude בטלפון" בשולחן העבודה');
    }
    if (url.pathname.startsWith('/api/setup/') && d.setup) return setupApi(req, url, res);
    if (req.method === 'POST' && url.pathname.startsWith('/api/') && d.actions && d.mode !== 'setup') {
      if (!isLocalOrigin(req.headers.origin, d.port) || req.headers['x-cp'] !== '1') return json(res, 403, { error: 'בקשה נחסמה' });
      let body: unknown;
      try { body = await readJson(req, 64 * 1024); } catch { return json(res, 400, { error: 'גוף בקשה לא תקין' }); }
      const r = await d.actions.handle(url.pathname.replace(/^\/api/, ''), body);
      return json(res, r.code, r.json);
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'הפעולה לא זמינה' });

    if (url.pathname.startsWith('/api/')) return api(url, res);
    return serveStatic(url.pathname, res);
  }

  /** אשף ההגדרה. POST רק מהלוח עצמו: Origin מקומי + כותרת X-CP (דפדפן לא שולח אותה מאתר זר בלי preflight). */
  async function setupApi(req: http.IncomingMessage, url: URL, res: http.ServerResponse) {
    let body: unknown = null;
    if (req.method === 'POST') {
      if (!isLocalOrigin(req.headers.origin, d.port) || req.headers['x-cp'] !== '1') return json(res, 403, { error: 'בקשה נחסמה' });
      try { body = await readJson(req, 64 * 1024); } catch { return json(res, 400, { error: 'גוף בקשה לא תקין' }); }
    } else if (req.method !== 'GET') return json(res, 405, { error: 'שיטה לא נתמכת' });
    const r = await d.setup!.handle(req.method!, url.pathname.replace(/^\/api\/setup/, ''), body);
    return json(res, r.code, r.json);
  }

  async function liveApi(req: http.IncomingMessage, url: URL, res: http.ServerResponse) {
    const hub = d.live!;
    const p = url.pathname.replace(/^\/live/, '');
    if (req.method === 'GET' && p === '/poll') {
      const events = await hub.poll(String(url.searchParams.get('s') ?? ''));
      return events === null ? json(res, 410, { error: 'הסשן לא רשום' }) : json(res, 200, { events });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'שיטה לא נתמכת' });
    let b: any;
    try { b = await readJson(req, 256 * 1024); } catch { return json(res, 400, { error: 'גוף בקשה לא תקין' }); }
    if (p === '/register') return json(res, 200, { session: hub.register(String(b?.cwd ?? ''), Number.isInteger(b?.pid) ? b.pid : null) });
    if (p === '/reply') return json(res, 200, { delivered: hub.reply(String(b?.s ?? ''), b?.chat_id ? String(b.chat_id) : null, String(b?.text ?? '')) });
    if (p === '/permission') return json(res, 200, { relayed: hub.permission(String(b?.s ?? ''), {
      request_id: String(b?.request_id ?? ''), tool_name: String(b?.tool_name ?? ''), description: String(b?.description ?? ''), input_preview: String(b?.input_preview ?? ''),
    }) });
    if (p === '/bye') { hub.close(String(b?.s ?? ''), 'נסגר'); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'לא נמצא' });
  }

  function api(url: URL, res: http.ServerResponse) {
    const p = url.pathname.replace(/^\/api/, '');
    const q = url.searchParams;
    if (p === '/overview') {
      return json(res, 200, {
        mode: d.mode ?? 'running',
        health: d.health(),
        settings: d.store.getSettings(),
        update: d.update?.() ?? null,
        counts: {
          pending: d.store.pendingPermissionRequests().length,
          active: d.tasks.listActive().length,
          unheard: d.tasks.listUnheardResults().length,
        },
      });
    }
    if (p === '/export' && d.actions) {
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="claudephone-settings-${day}.json"` });
      return res.end(JSON.stringify(d.actions.exportData(), null, 2));
    }
    if (p === '/live') return json(res, 200, d.live?.list() ?? []);
    if (p === '/projects-location') return json(res, 200, d.location?.() ?? null);
    if (p === '/quiet-config') return json(res, 200, d.quietConfig?.() ?? null);
    if (p === '/mcp') return json(res, 200, d.actions?.mcpView() ?? { enabled: [], scan: null, scanning: false });
    if (p === '/projects') {
      const convs = d.conversations.all();
      return json(res, 200, d.store.listProjects().map(pr => ({
        ...pr, conversations: convs.filter(c => c.projectId === pr.id).length,
        lastActiveAt: convs.find(c => c.projectId === pr.id)?.lastActiveAt ?? null,
      })));
    }
    if (p === '/conversations') {
      let list = d.conversations.all().map(c => d.conversations.autoFolderView(c));
      const proj = q.get('project'), src = q.get('source'), text = (q.get('q') ?? '').trim();
      if (proj) list = list.filter(c => c.projectId === proj);
      if (src) list = list.filter(c => c.source === src);
      if (!q.get('all')) list = list.filter(c => c.projectId);   // ברירת מחדל: רק שיחות של פרויקטים רשומים
      if (text) {
        const t = text.toLowerCase();
        const taskHits = new Set(d.tasks.recent(5000).filter(k => `${k.prompt} ${k.resultText ?? ''}`.toLowerCase().includes(t)).map(k => k.conversationId));
        list = list.filter(c => c.title.toLowerCase().includes(t) || taskHits.has(c.id) || historyContains(c.id, t));
      }
      return json(res, 200, list.slice(0, Number(q.get('limit') ?? 300)));
    }
    let m = p.match(/^\/conversations\/([\w-]+)$/);
    if (m) {
      const raw = d.conversations.get(m[1]); const entry = raw ? d.conversations.autoFolderView(raw) : null;
      if (!entry) return json(res, 404, { error: 'השיחה לא נמצאה' });
      const tasks = d.tasks.recent(5000).filter(t => t.conversationId === entry.id).reverse();
      return json(res, 200, { entry, messages: d.conversations.messages(entry.id), tasks: tasks.map(t => ({ ...t, hasRecording: hasRecording(t.recordingPath) })) });
    }
    if (p === '/tasks') {
      const st = q.get('state');
      let list = d.tasks.recent(500);
      if (st === 'active') list = d.tasks.listActive();
      return json(res, 200, list.map(t => ({ ...t, projectName: d.store.getProject(t.projectId)?.spokenName ?? null, hasRecording: hasRecording(t.recordingPath) })));
    }
    m = p.match(/^\/tasks\/([\w-]+)$/);
    if (m) {
      const t = d.tasks.get(m[1]);
      if (!t) return json(res, 404, { error: 'המשימה לא נמצאה' });
      return json(res, 200, { task: { ...t, hasRecording: hasRecording(t.recordingPath) }, events: d.tasks.events(t.id), permissions: d.store.listPermissionRequests(t.id) });
    }
    if (p === '/permissions') {
      const all = d.store.listPermissionRequests();
      const pending = d.store.pendingPermissionRequests();
      return json(res, 200, { pending: pending.map(withTask), recent: all.filter(r => r.decision !== null).slice(0, 200).map(withTask) });
    }
    if (p === '/phonelog') return json(res, 200, d.store.recentPhoneLog(Number(q.get('limit') ?? 300)).map(e => ({ ...e, phone: maskPhone(e.phone) })));
    m = p.match(/^\/recordings\/([\w-]+)$/);
    if (m) {
      const t = d.tasks.get(m[1]);
      if (!t || !hasRecording(t.recordingPath)) return json(res, 404, { error: 'ההקלטה לא נשמרה או נמחקה לפי מדיניות השמירה' });
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
      return createReadStream(t.recordingPath!).pipe(res);
    }
    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }
    return json(res, 404, { error: 'לא נמצא' });
  }

  function withTask(r: any) {
    const t = d.tasks.get(r.taskId);
    return { ...r, taskNum: t?.num ?? null, projectName: d.store.getProject(r.projectId)?.spokenName ?? null };
  }

  /** הקלטה מוגשת רק מתוך תיקיית ההקלטות של הסוכן. */
  function hasRecording(p: string | null): boolean {
    if (!p || !existsSync(p)) return false;
    const rel = relative(resolve(d.recordingsDir), resolve(p));
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  }

  const searchCache = new Map<string, { mtime: number; text: string }>();
  function historyContains(id: string, t: string): boolean {
    const mtime = d.conversations.transcriptMtime(id);
    if (mtime === null) return false;
    let c = searchCache.get(id);
    if (!c || c.mtime !== mtime) {
      c = { mtime, text: d.conversations.messages(id, 5000).map(m => m.text).join('\n').toLowerCase() };
      searchCache.set(id, c);
    }
    return c.text.includes(t);
  }

  function serveStatic(pathname: string, res: http.ServerResponse) {
    const root = resolve(d.staticDir);
    let file = resolve(join(root, decodeURIComponent(pathname)));
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return text(res, 403, 'forbidden');
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');   // ניתוב בצד הלקוח
    if (!existsSync(file)) return text(res, 503, 'ממשק הלוח לא נבנה (agent/web חסר)');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-store' : 'max-age=31536000, immutable' });
    createReadStream(file).pipe(res);
  }

  // עדכון חי: כל שינוי במאגר (או בהיסטוריה) שולח "change" ללקוחות, והם מושכים מחדש
  let lastChanges = -1, lastHist = '';
  const timer = setInterval(() => {
    if (!sseClients.size) return;
    try {
      const ch = Number((d.store.db.prepare('SELECT total_changes() AS n').get() as any).n);
      const hist = d.history.list().slice(0, 20).map(h => h.id + h.mtimeMs).join('|');
      if (ch !== lastChanges || hist !== lastHist) {
        lastChanges = ch; lastHist = hist;
        for (const c of sseClients) c.write(`event: change\ndata: ${Date.now()}\n\n`);
      }
    } catch (e) { logError('web', e, 'sse'); }
  }, 1000);
  timer.unref();

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && d.onPortBusy) return d.onPortBusy();
    logError('web', e, 'listen');
  });
  server.listen(d.port, '127.0.0.1', () => log('web', `לוח הבקרה: http://127.0.0.1:${d.port}/?t=…`));
  return server;
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function text(res: http.ServerResponse, code: number, body: string) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}
function cookie(req: http.IncomingMessage, name: string): string | null {
  const m = (req.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function isLocalOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
function readJson(req: http.IncomingMessage, max: number): Promise<unknown> {
  return new Promise((res, rej) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { rej(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); res(t ? JSON.parse(t) : {}); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}
/** מספרי טלפון מוצגים חלקית בלבד. */
export function maskPhone(p: string): string { return p.length > 4 ? '•••' + p.slice(-4) : p; }
