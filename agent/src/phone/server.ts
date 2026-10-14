// שרת ה-api_link (הגישור, שבלע לתוך הסוכן לפי החלטת 14.10). מאזין רק ל-127.0.0.1; מגיעים אליו דרך מנהרת Cloudflare.
import http from 'node:http';
import type { PhoneFlow } from './flow.ts';
import { log, logError } from '../log.ts';

export interface PhoneServerOptions { port: number; path: string; flow: PhoneFlow; }

export function startPhoneServer(o: PhoneServerOptions): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://local');
      if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      if (url.pathname !== o.path) { res.writeHead(404); return res.end(); }
      const params: Record<string, string> = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') Object.assign(params, Object.fromEntries(new URLSearchParams(await readBody(req))));
      const body = await o.flow.handle(params);
      log('phone', `<- ${params.ApiCallId?.slice(-6) ?? '?'} ${redact(params)} -> ${body.slice(0, 140)}`);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
    } catch (e) {
      logError('phone', e, 'request');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('id_list_message=t-תקלה זמנית&go_to_folder=hangup');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => { log('phone', `שרת ימות מאזין ב-127.0.0.1:${o.port}${o.path}`); resolve(server); });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = ''; req.setEncoding('utf8');
    req.on('data', d => { s += d; if (s.length > 100_000) req.destroy(); });
    req.on('end', () => resolve(s)); req.on('error', reject);
  });
}

/** ביומן לא נכתבים קודי PIN: ערך קליטה של ספרות בלבד באורך 4–8 מוסתר. */
function redact(p: Record<string, string>): string {
  const keys = Object.keys(p).filter(k => /^v\d+$/.test(k)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const last = keys[keys.length - 1];
  if (!last) return p.hangup === 'yes' ? 'hangup' : 'enter';
  const v = p[last];
  return `${last}=${/^\d{4,8}$/.test(v) ? '****' : v.slice(0, 60)}`;
}
