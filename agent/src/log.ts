// יומן פשוט: מסך + קובץ data/agent.log. סודות (טוקן, PIN) לעולם לא נכתבים כאן.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let logFile: string | null = null;

export function initLog(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
}

export function log(scope: string, ...parts: unknown[]): void {
  const line = `${new Date().toISOString()} [${scope}] ${parts.map(p => typeof p === 'string' ? p : safe(p)).join(' ')}`;
  console.log(line);
  if (logFile) { try { appendFileSync(logFile, line + '\n'); } catch { /* אין מה לעשות */ } }
}

export function logError(scope: string, err: unknown, context?: string): void {
  const msg = err instanceof Error ? `${err.message}${err.stack ? '\n' + err.stack : ''}` : String(err);
  log(scope, 'שגיאה', context ?? '', msg);
}

function safe(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
