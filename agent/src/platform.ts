// שכבת המערכת: כל מה ששונה בין Windows ללינוקס במקום אחד (16.10.2026: גרסת לינוקס).
// לינוקס: גם מחשב עם שולחן עבודה וגם שרת בלי מסך. בלי מסך, הפעולות הגרפיות (פתיחת דפדפן, טרמינל, תיקייה, חלון בחירה)
// לא נכשלות בשקט: הן זורקות שגיאה ברורה שמוצגת בלוח הבקרה.
import { existsSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, delimiter, dirname, posix } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/** שם המערכת להצגה למשתמש. */
export function osName(): string { return isWin ? 'Windows' : isLinux ? 'לינוקס' : process.platform; }

/** ארכיטקטורה בשמות של קבצי ההתקנה: x64 או arm64. */
export function archName(): 'x64' | 'arm64' | string { return process.arch; }

/** האם הספרייה הבסיסית של לינוקס היא musl (Alpine) ולא glibc. */
export function isMusl(): boolean {
  if (!isLinux) return false;
  try { return !(process.report?.getReport() as any)?.header?.glibcVersionRuntime; } catch { return false; }
}

/** חבילת ה-SDK שמכילה את Claude Code למערכת הזו, ושם הקובץ שבתוכה. */
export function sdkBinaryPackage(platform = process.platform, arch = process.arch, musl = isMusl()): { pkg: string; file: string } {
  return { pkg: `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`, file: platform === 'win32' ? 'claude.exe' : 'claude' };
}

/** שם קובץ המנהרה בתיקיית bin. */
export function cloudflaredFileName(platform = process.platform): string { return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'; }

/** כתובת ההורדה של cloudflared למערכת ולמעבד. */
export function cloudflaredUrl(platform = process.platform, arch = process.arch): string {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  if (platform === 'win32') return base + 'cloudflared-windows-amd64.exe';
  const a = arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : 'amd64';
  return base + `cloudflared-linux-${a}`;
}

/** האם יש מסך גרפי (ב-Windows תמיד; בלינוקס לפי DISPLAY / WAYLAND_DISPLAY). */
export function hasGui(env = process.env): boolean {
  if (isWin) return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** הודעה למשתמש כשפעולה דורשת מסך ואין. */
export const NO_GUI = 'במחשב הזה אין מסך (שרת). את הפעולה הזו אפשר לעשות רק במחשב עם שולחן עבודה';

/** חיפוש תוכנה ב-PATH (בלי להריץ אותה). */
export function which(cmd: string, env = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
    if (isWin && existsSync(p + '.exe')) return p + '.exe';
  }
  return null;
}

function detached(cmd: string, args: string[], opts: { cwd?: string } = {}): void {
  // בלי windowsHide: ב-Windows זה היה עלול להסתיר את חלון הטרמינל או הסייר שנפתחים (כמו בגרסאות הקודמות)
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  c.on('error', () => { /* נבדק לפני ההפעלה; אין מה לעשות כאן */ });
  c.unref();
}

/** פתיחת כתובת בדפדפן ברירת המחדל (לינוקס). ב-Windows: open.ts (חלון אפליקציה של Edge). */
export function openUrlLinux(url: string): void {
  if (!hasGui()) return;
  const opener = which('xdg-open') ?? which('gio') ?? which('sensible-browser');
  if (!opener) return;
  detached(opener, opener.endsWith('gio') ? ['open', url] : [url]);
}

/** פתיחת תיקייה בסייר הקבצים. */
export function openFolder(path: string): void {
  if (isWin) { detached('explorer.exe', [path]); return; }
  if (!hasGui()) throw new Error(NO_GUI);
  const opener = which('xdg-open') ?? which('gio');
  if (!opener) throw new Error('לא נמצא סייר קבצים (xdg-open)');
  detached(opener, opener.endsWith('gio') ? ['open', path] : [path]);
}

/** הטרמינלים המוכרים בלינוקס, לפי סדר העדפה, ואיך מעבירים להם פקודה להרצה. */
const TERMINALS: { bin: string; args: (script: string, rest: string[]) => string[] }[] = [
  { bin: 'x-terminal-emulator', args: (s, r) => ['-e', s, ...r] },
  { bin: 'gnome-terminal', args: (s, r) => ['--', s, ...r] },
  { bin: 'konsole', args: (s, r) => ['-e', s, ...r] },
  { bin: 'xfce4-terminal', args: (s, r) => ['-x', s, ...r] },
  { bin: 'mate-terminal', args: (s, r) => ['-x', s, ...r] },
  { bin: 'tilix', args: (s, r) => ['-e', [s, ...r].map(shq).join(' ')] },
  { bin: 'kitty', args: (s, r) => [s, ...r] },
  { bin: 'alacritty', args: (s, r) => ['-e', s, ...r] },
  { bin: 'wezterm', args: (s, r) => ['start', '--', s, ...r] },
  { bin: 'foot', args: (s, r) => [s, ...r] },
  { bin: 'xterm', args: (s, r) => ['-e', s, ...r] },
];

export function findTerminal(env = process.env): { bin: string; path: string; args: (script: string, rest: string[]) => string[] } | null {
  for (const t of TERMINALS) { const p = which(t.bin, env); if (p) return { ...t, path: p }; }
  return null;
}

/** ציטוט לפקודת sh. */
export function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

/**
 * פתיחת חלון טרמינל שמריץ סקריפט בתיקייה מסוימת.
 * Windows: cmd.exe /k (החלון נשאר פתוח). לינוקס: הסקריפט עצמו פותח מעטפת בסוף, כדי שהחלון לא ייסגר.
 */
export function openTerminal(title: string, cwd: string, script: string, args: string[] = []): void {
  if (isWin) { detached('cmd.exe', ['/c', 'start', title, '/D', cwd, 'cmd.exe', '/k', script, ...args]); return; }
  if (!hasGui()) throw new Error(NO_GUI + '. אפשר להתחבר בטרמינל (SSH) ולהריץ שם claude --resume');
  const t = findTerminal();
  if (!t) throw new Error('לא נמצא חלון טרמינל במחשב (למשל gnome-terminal או konsole)');
  detached(t.path, t.args(script, args), { cwd });
}

/**
 * כתיבת סקריפט שמריץ את Claude Code (למצב חי ולהמשך שיחה בטרמינל).
 * Windows: קובץ .cmd. לינוקס: סקריפט sh שבסופו נשארת מעטפת פתוחה.
 */
export function writeClaudeScript(pathNoExt: string, claudeExe: string, claudeArgs: string[], passArgs: boolean): string {
  if (isWin) {
    const p = pathNoExt + '.cmd';
    // כמו בגרסאות הקודמות: נתיבים במירכאות, דגלים ומשתנים (%1) בלי
    const q = (a: string) => a.startsWith('%') || a.startsWith('-') || !/[\\/:]/.test(a) || /^[\w-]+:[\w-]+$/.test(a) ? a : `"${a}"`;
    writeFileSync(p, ['@echo off', 'chcp 65001 >nul', `"${claudeExe}" ${claudeArgs.map(q).join(' ')}${passArgs ? ' %*' : ''}`, ''].join('\r\n'), 'utf8');
    return p;
  }
  const p = pathNoExt + '.sh';
  writeFileSync(p, [
    '#!/bin/sh',
    `${shq(claudeExe)} ${claudeArgs.map(shq).join(' ')}${passArgs ? ' "$@"' : ''}`,
    'echo',
    'exec "${SHELL:-/bin/sh}"',
    '',
  ].join('\n'), 'utf8');
  chmodSync(p, 0o755);
  return p;
}

/** חלון בחירת תיקייה בלינוקס (zenity או kdialog). null אם בוטל; שגיאה אם אין מסך או אין כלי מתאים. */
export function pickFolderLinux(initial: string | null, title: string): Promise<string | null> {
  if (!hasGui()) return Promise.reject(new Error('בחירה בחלון לא זמינה במחשב בלי מסך. הקלד את הנתיב המלא בשדה'));
  const zen = which('zenity'), kd = which('kdialog');
  if (!zen && !kd) return Promise.reject(new Error('לא נמצא חלון בחירת תיקייה (zenity או kdialog). הקלד את הנתיב המלא בשדה'));
  const args = zen
    ? ['--file-selection', '--directory', `--title=${title}`, ...(initial ? [`--filename=${initial.replace(/\/?$/, '/')}`] : [])]
    : ['--getexistingdirectory', initial || homedir(), '--title', title];
  return new Promise(res => {
    const p = spawn((zen ?? kd)!, args);
    let out = '';
    p.stdout.setEncoding('utf8').on('data', d => { out += d; });
    const t = setTimeout(() => p.kill(), 10 * 60_000);
    p.on('close', code => { clearTimeout(t); const v = out.trim(); res(code === 0 && v ? v : null); });
    p.on('error', () => { clearTimeout(t); res(null); });
  });
}

// ---------- הפעלה אוטומטית בלינוקס: שירות systemd של המשתמש ----------

export const SERVICE_NAME = 'claudephone';

export function systemdUserDir(home = homedir(), env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user');
}

/** קובץ השירות. Restart=always: גם "הפעלה מחדש" מתוך התוכנה היא יציאה ש-systemd מעלה ממנה מופע חדש. */
export function serviceUnit(appDir: string, path = process.env.PATH ?? ''): string {
  const node = posix.join(appDir, 'runtime', 'node');
  const agent = posix.join(appDir, 'agent', 'dist', 'agent.mjs');
  return [
    '[Unit]',
    'Description=Claude בטלפון (ClaudePhone agent)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${posix.join(appDir, 'agent')}`,
    `ExecStart="${node}" --no-warnings --use-system-ca "${agent}" --no-open`,
    'Restart=always',
    'RestartSec=3',
    // ההפעלה מחדש מהאשף/מהלוח יוצאת עם 0, ו-systemd מעלה מחדש
    'KillSignal=SIGTERM',
    'TimeoutStopSec=20',
    'Environment=NODE_ENV=production',
    'Environment=CLAUDEPHONE_SERVICE=1',
    // ה-PATH של המשתמש (כלים כמו git ו-node שהותקנו בתיקיית הבית), כי לשירות יש PATH מצומצם
    ...(path ? [`Environment="PATH=${path.replace(/["\\\n]/g, '')}"`] : []),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** האם התהליך רץ כשירות systemd (אז הפעלה מחדש = יציאה, ו-systemd מעלה מחדש). */
export function underSystemd(env = process.env): boolean { return isLinux && env.CLAUDEPHONE_SERVICE === '1'; }

/**
 * רישום הפעלה אוטומטית בלינוקס. עם systemd: שירות משתמש + linger (עולה גם בלי להתחבר למחשב, חשוב לשרת).
 * בלי systemd ועם מסך: קובץ autostart של שולחן העבודה. מחזיר הודעה למשתמש.
 */
export function installLinuxAutostart(appDir: string, launcher: string): { ok: boolean; note: string } {
  if (which('systemctl')) {
    try {
      const dir = systemdUserDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SERVICE_NAME + '.service'), serviceUnit(appDir), 'utf8');
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 20_000 });
      execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME + '.service'], { stdio: 'ignore', timeout: 20_000 });
      let linger = true;
      try { execFileSync('loginctl', ['enable-linger', process.env.USER || ''], { stdio: 'ignore', timeout: 20_000 }); } catch { linger = false; }
      return { ok: true, note: linger ? 'הסוכן יעלה אוטומטית עם הפעלת המחשב (שירות systemd), גם בלי להתחבר' : 'הסוכן יעלה אוטומטית בכל כניסה למחשב (שירות systemd)' };
    } catch { /* ננסה autostart של שולחן העבודה */ }
  }
  if (hasGui()) {
    try {
      const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'claudephone.desktop'), desktopEntry(appDir, launcher, '--no-open', true), 'utf8');
      return { ok: true, note: 'הסוכן יעלה אוטומטית בכל כניסה לשולחן העבודה' };
    } catch { /* */ }
  }
  return { ok: false, note: 'רישום ההפעלה האוטומטית נכשל. אפשר להפעיל ידנית: ' + launcher };
}

/** קובץ .desktop (קיצור בתפריט ובשולחן העבודה, או autostart). */
export function desktopEntry(appDir: string, launcher: string, arg: string, autostart = false): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Claude בטלפון',
    'Name[he]=Claude בטלפון',
    'Comment=לוח הבקרה של Claude בטלפון',
    `Exec="${launcher}" ${arg}`,
    `Icon=${posix.join(appDir, 'icon.png')}`,
    'Terminal=false',
    'Categories=Utility;Development;',
    ...(autostart ? ['X-GNOME-Autostart-enabled=true', 'NoDisplay=true'] : ['StartupNotify=false']),
    '',
  ].join('\n');
}

/** תיקיית שולחן העבודה בלינוקס (לפי xdg-user-dirs, כולל שם בעברית), או null. */
export function linuxDesktopDir(home = homedir()): string | null {
  try {
    const out = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out && out !== home && out.startsWith(home + '/') && existsSync(out)) return out;
  } catch { /* */ }
  for (const n of ['Desktop', 'שולחן העבודה']) { const p = join(home, n); if (existsSync(p)) return p; }
  return null;
}

/** קיצורים בלינוקס: בתפריט היישומים, ובשולחן העבודה אם יש. */
export function installLinuxShortcuts(appDir: string, launcher: string): { ok: boolean; note: string } {
  if (!hasGui()) return { ok: true, note: 'במחשב בלי מסך לא נוצר קיצור דרך. לוח הבקרה נפתח מרחוק (ראה הוראות ההתקנה)' };
  try {
    const entry = desktopEntry(appDir, launcher, '--open');
    const apps = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, 'claudephone.desktop'), entry, 'utf8');
    const desk = linuxDesktopDir();
    if (desk) {
      const f = join(desk, 'claudephone.desktop');
      writeFileSync(f, entry, 'utf8');
      chmodSync(f, 0o755);
      // GNOME: סימון הקיצור כמהימן כדי שאפשר יהיה להפעיל אותו בלחיצה
      try { execFileSync('gio', ['set', f, 'metadata::trusted', 'true'], { stdio: 'ignore', timeout: 5000 }); } catch { /* */ }
    }
    return { ok: true, note: desk ? 'נוצר קיצור דרך "Claude בטלפון" בשולחן העבודה ובתפריט היישומים' : 'נוצר קיצור "Claude בטלפון" בתפריט היישומים' };
  } catch { return { ok: false, note: 'יצירת קיצור הדרך נכשלה' }; }
}

/** המפעיל של ההתקנה: launcher.vbs ב-Windows, launcher.sh בלינוקס (בתיקיית האפליקציה). */
export function launcherFile(appDir: string): string { return join(appDir, isWin ? 'launcher.vbs' : 'launcher.sh'); }

/** תיקיית ההתקנה מתוך נתיב המפעיל. */
export function appDirOf(launcher: string): string { return dirname(launcher); }

/** תיקיות Python מותקנות ב-Windows (בלי לסמוך על PATH). */
export function windowsPythonDirs(): string[] {
  const out: string[] = [];
  const roots = [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python'), process.env.ProgramFiles ?? 'C:\\Program Files', 'C:\\'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[] = [];
    try { dirs = readdirSync(root).filter(d => /^Python3\d+$/i.test(d)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7))); } catch { /* */ }
    for (const d of dirs) { const exe = join(root, d, 'python.exe'); if (existsSync(exe)) out.push(exe); }
  }
  return out;
}

/** התיקייה שבה Claude Desktop שומר נתונים (Cowork). בלינוקס אין גרסה רשמית; מחזירים את המקום המקובל, שבדרך כלל לא קיים. */
export function claudeDesktopDataDir(env = process.env, home = homedir()): string {
  if (isWin) return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude');
}
