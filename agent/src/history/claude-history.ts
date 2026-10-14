// קריאת היסטוריית Claude Code מ-~/.claude/projects (אפיון 2: "מקור להיסטוריה בכפוף לתאימות").
// קריאה בלבד: לעולם לא כותבים לקבצים האלה. מבנה הקבצים פנימי ולא מתועד, לכן כל שדה נקרא בזהירות,
// וכל מה שלא מזוהה מוצג כ"לא ידוע" (אפיון 2).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type HistorySource = 'desktop' | 'cli' | 'vscode' | 'sdk' | 'unknown';

export interface HistorySession {
  id: string;                 // session id (שם הקובץ)
  file: string;
  cwd: string | null;
  source: HistorySource;
  entrypoint: string | null;
  title: string;
  createdAt: string | null;
  lastActiveAt: string;       // הזמן האחרון ברשומות, או זמן שינוי הקובץ
  mtimeMs: number;
  messageCount: number;       // הודעות משתמש + תשובות
  version: string | null;     // גרסת Claude Code שכתבה את השיחה
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  at: string | null;
  text: string;
  tool?: { name: string; input: string };
}

const SOURCE_BY_ENTRYPOINT: Record<string, HistorySource> = {
  'claude-desktop': 'desktop', cli: 'cli', 'claude-vscode': 'vscode', 'sdk-ts': 'sdk', 'sdk-cli': 'sdk', 'sdk-py': 'sdk',
};

export function defaultProjectsDir(): string { return join(homedir(), '.claude', 'projects'); }

/** משווה נתיבים ב-Windows בלי תלות באותיות גדולות ובלוכסנים. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return n(a) === n(b);
}

interface CacheEntry { mtimeMs: number; size: number; session: HistorySession; }

export class ClaudeHistory {
  private cache = new Map<string, CacheEntry>();

  constructor(private dir = defaultProjectsDir()) {}

  /** כל השיחות, החדשה ראשונה. נקרא מחדש רק קובץ ששונה. */
  list(): HistorySession[] {
    if (!existsSync(this.dir)) return [];
    const out: HistorySession[] = [];
    const seen = new Set<string>();
    for (const d of safeReaddir(this.dir)) {
      const pdir = join(this.dir, d);
      for (const f of safeReaddir(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = join(pdir, f);
        seen.add(file);
        let st; try { st = statSync(file); } catch { continue; }
        const c = this.cache.get(file);
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) { out.push(c.session); continue; }
        const s = parseSessionMeta(file, f.slice(0, -6), st.mtimeMs);
        if (!s) continue;
        this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session: s });
        out.push(s);
      }
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return out.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  get(id: string): HistorySession | null { return this.list().find(s => s.id === id) ?? null; }

  messages(id: string, limit = 500): HistoryMessage[] {
    const s = this.get(id);
    if (!s) return [];
    return parseMessages(s.file).slice(-limit);
  }

  /** שיחה "פעילה": נכתבה בדקות האחרונות, ולכן ייתכן שהיא פתוחה עכשיו ב-Desktop או בטרמינל. */
  isActive(s: HistorySession, now = Date.now(), minutes = 3): boolean {
    return now - s.mtimeMs < minutes * 60_000;
  }
}

function safeReaddir(p: string): string[] { try { return readdirSync(p); } catch { return []; } }

function readLines(file: string): any[] {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const out: any[] = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* שורה חלקית (הקובץ נכתב ברגע זה) */ }
  }
  return out;
}

export function parseSessionMeta(file: string, id: string, mtimeMs: number): HistorySession | null {
  const lines = readLines(file);
  if (!lines.length) return null;
  const cwdCount = new Map<string, number>();
  let entrypoint: string | null = null, version: string | null = null;
  let customTitle = '', aiTitle = '', firstUser = '', lastPrompt = '';
  let createdAt: string | null = null, lastAt: string | null = null, count = 0;
  for (const o of lines) {
    if (o.isSidechain) continue;
    if (typeof o.cwd === 'string') cwdCount.set(o.cwd, (cwdCount.get(o.cwd) ?? 0) + 1);
    if (!entrypoint && typeof o.entrypoint === 'string') entrypoint = o.entrypoint;
    if (typeof o.version === 'string') version = o.version;
    if (typeof o.timestamp === 'string') { createdAt ??= o.timestamp; lastAt = o.timestamp; }
    if (o.type === 'custom-title' && o.customTitle) customTitle = String(o.customTitle);
    if (o.type === 'ai-title' && o.aiTitle) aiTitle = String(o.aiTitle);
    if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = String(o.lastPrompt);
    if (o.type === 'user' || o.type === 'assistant') {
      const t = messageText(o);
      if (t) count++;
      if (!firstUser && o.type === 'user' && t && !isMeta(t)) firstUser = t;
    }
  }
  if (!count) return null;
  const cwd = [...cwdCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const title = clip(customTitle || aiTitle || firstUser || lastPrompt || 'שיחה ללא כותרת', 80);
  return {
    id, file, cwd, entrypoint, version,
    source: entrypoint ? (SOURCE_BY_ENTRYPOINT[entrypoint] ?? 'unknown') : 'unknown',
    title, createdAt, lastActiveAt: lastAt ?? new Date(mtimeMs).toISOString(), mtimeMs, messageCount: count,
  };
}

export function parseMessages(file: string): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const o of readLines(file)) {
    if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const at = typeof o.timestamp === 'string' ? o.timestamp : null;
    const content = o.message?.content;
    if (typeof content === 'string') {
      if (!isMeta(content)) out.push({ role: o.type, at, text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'text' && part.text && !isMeta(part.text)) out.push({ role: o.type, at, text: String(part.text) });
      else if (part?.type === 'tool_use') out.push({ role: 'tool', at, text: '', tool: { name: String(part.name ?? ''), input: toolInputSummary(part.name, part.input) } });
    }
  }
  return out;
}

function messageText(o: any): string {
  const c = o.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ').trim();
  return '';
}

/** הודעות מערכת שנכנסות לרשומה כ"משתמש" (פקודות מקומיות, תזכורות). לא כותרת ולא תוכן. */
function isMeta(t: string): boolean {
  return /^\s*<(local-command|command-|system-reminder|local-command-caveat)/.test(t) || t.startsWith('Caveat:');
}

function toolInputSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command).slice(0, 400);
  if (input.file_path) return String(input.file_path);
  if (input.url) return String(input.url);
  if (input.pattern) return String(input.pattern);
  if (input.questions) return (input.questions as any[]).map(q => q.question).join(' | ');
  return JSON.stringify(input).slice(0, 300);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
