// טעינת ההגדרות: config.example.json (ברירות מחדל) + config.json (של המשתמש). סודות נקראים מקבצים ב-data/.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  yemot: { chatExtension: string; tokenFile: string; apiBase: string; recordFolder?: string };
  phones: { allowed: string[]; pinHashFile: string; lockoutAttempts: number; lockoutMinutes: number };
  projects: { newProjectsParent: string; initGit: boolean; list: { name: string; spokenName?: string; path: string }[] };
  limits: { recordSeconds: number; transcriptConfirmSeconds: number; queuedTaskHours: number; permissionMinutes: number; dialAttempts: number; waitOnCallMinutes: number };
  quietHours: { start: string; end: string; shabbatAndChag: boolean; includeCholHamoed: boolean; candleMinutes: number; marginMinutes: number; location: string };
  /** freeList: שם רשימת הצינתוקים החינמיים (תת-שלוחה <שלוחה>/1). ריק: תמיד צינתוק בתשלום. */
  notifications: { mode: 'tzintuk' | 'call' | 'none'; freeList: string };
  stt: { engine: 'faster-whisper' | 'yemot'; model: string; python: string; script: string; timeoutSeconds: number };
  claude: { strictMcp: boolean; permissionMode: 'default'; maxTurns: number; model?: string };
  /** חיבורי MCP למשימות מהטלפון: אילו שרתים פתוחים (לפי slug), והסריקה האחרונה של מה שקיים במחשב. */
  mcp: { enabled: string[]; chrome: import('./claude/chrome.ts').ChromeSettings; scan: { at: string; claudeCodeVersion: string | null; servers: { slug: string; name: string; status: string; source: 'claude.ai' | 'plugin' | 'local'; tools: string[] }[] } | null };
  dashboard: { port: number; tokenFile: string; staticDir: string };
  retention: { recordingsDays: number };
  history: { resumeSources: ('sdk' | 'desktop' | 'cli' | 'vscode' | 'unknown' | 'cowork')[]; activeMinutes: number };
  update: { repo: string; apiBase: string; checkHours: number; auto: boolean };
  phoneServer: { port: number; path: string };
  tunnel: { mode: 'quick' | 'none'; cloudflaredPath: string; publicUrl: string };
  dataDir: string;
}

export const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(root = AGENT_ROOT): Config {
  const base = JSON.parse(readFileSync(resolve(root, 'config.example.json'), 'utf8'));
  const userPath = resolve(root, 'config.json');
  const user = existsSync(userPath) ? JSON.parse(readFileSync(userPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  const cfg = deepMerge(base, user) as Config;
  // 0.6.2: המשך שיחות מהטרמינל ומ-VS Code נבדק ועובד. מי שנשאר עם רשימת ברירת המחדל הישנה מקבל את החדשה.
  const rs = user?.history?.resumeSources;
  if (Array.isArray(rs) && [...rs].sort().join(',') === 'cowork,desktop,sdk') cfg.history.resumeSources = base.history.resumeSources;
  cfg.dataDir = abs(root, cfg.dataDir || 'data');
  cfg.yemot.tokenFile = abs(root, cfg.yemot.tokenFile);
  cfg.phones.pinHashFile = abs(root, cfg.phones.pinHashFile);
  cfg.stt.script = abs(root, cfg.stt.script);
  cfg.dashboard.tokenFile = abs(root, cfg.dashboard.tokenFile);
  cfg.dashboard.staticDir = abs(root, cfg.dashboard.staticDir);
  if (cfg.tunnel.cloudflaredPath) cfg.tunnel.cloudflaredPath = abs(root, cfg.tunnel.cloudflaredPath);
  return cfg;
}

export function readSecretFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const s = readFileSync(path, 'utf8').trim();
  return s || null;
}

function abs(root: string, p: string): string { return isAbsolute(p) ? p : resolve(root, p); }

export function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b === undefined ? a : b;
  const out: any = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

/** עדכון config.json של המשתמש (מיזוג), מהאשף. שומר בקידוד UTF-8 בלי BOM. */
export function saveUserConfig(patch: Record<string, unknown>, root = AGENT_ROOT): void {
  const userPath = resolve(root, 'config.json');
  const current = existsSync(userPath) ? JSON.parse(readFileSync(userPath, 'utf8').replace(/^﻿/, '')) : {};
  writeFileSync(userPath, JSON.stringify(deepMerge(current, patch), null, 2), 'utf8');
}
