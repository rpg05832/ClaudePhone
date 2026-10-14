// פתיחת לוח הבקרה כחלון אפליקציה נפרד (בלי לשוניות ושורת כתובת), בעזרת Microsoft Edge שמותקן בכל Windows.
// אם Edge לא נמצא: נפתח בדפדפן ברירת המחדל.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export function findEdge(): string | null {
  const c = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return c.find(p => existsSync(p)) ?? null;
}

export function openDashboardWindow(url: string): void {
  if (process.platform !== 'win32') return;
  const edge = findEdge();
  if (edge) spawn(edge, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** פקודת PowerShell שיוצרת קיצור דרך בשולחן העבודה שפותח את הלוח כחלון אפליקציה (ומוחקת את קיצור הדרך הישן מסוג .url). */
export function shortcutScript(url: string): string {
  const edge = findEdge();
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const name = 'לוח הבקרה - Claude בטלפון';
  return [
    `$d = [Environment]::GetFolderPath('Desktop')`,
    `Remove-Item (Join-Path $d ${q(name + '.url')}) -ErrorAction SilentlyContinue`,
    edge
      ? `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d ${q(name + '.lnk')})); $s.TargetPath = ${q(edge)}; $s.Arguments = ${q(`--app=${url} --window-size=1280,860`)}; $s.IconLocation = ${q(edge + ',0')}; $s.Description = 'Claude בטלפון'; $s.Save()`
      : `[IO.File]::WriteAllText((Join-Path $d ${q(name + '.url')}), "[InternetShortcut]\`r\`nURL=${url}\`r\`n")`,
  ].join('; ');
}

/**
 * קיצור הדרך בשולחן העבודה.
 * בהתקנה: "Claude בטלפון" עם הסמל של התוכנה, דרך launcher.vbs: מפעיל את התוכנה אם היא כבויה ופותח את הלוח
 * (בלי אסימון בקיצור עצמו). מוחק את הקיצור הישן "לוח הבקרה - Claude בטלפון".
 * בפיתוח (בלי launcher): קיצור ישיר לחלון הלוח, כמו קודם.
 */
export function desktopShortcutScript(url: string, launcher: string | null): string {
  if (!launcher) return shortcutScript(url);
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const dir = launcher.replace(/[\\/][^\\/]+$/, '');
  const old = 'לוח הבקרה - Claude בטלפון';
  return [
    `$d = [Environment]::GetFolderPath('Desktop')`,
    `Remove-Item (Join-Path $d ${q(old + '.url')}), (Join-Path $d ${q(old + '.lnk')}) -ErrorAction SilentlyContinue`,
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d ${q(STARTUP_NAME + '.lnk')}))`,
    `$s.TargetPath = (Join-Path $env:SystemRoot 'System32\\wscript.exe')`,
    `$s.Arguments = ${q(`"${launcher}" --open`)}`,
    `$s.WorkingDirectory = ${q(dir)}`,
    `if (Test-Path -LiteralPath ${q(dir + '\\icon.ico')}) { $s.IconLocation = ${q(dir + '\\icon.ico,0')} }`,
    `$s.Description = 'Claude בטלפון: לוח הבקרה'`,
    `$s.Save()`,
  ].join('; ');
}

/** שם קיצור הדרך בתיקיית ההפעלה של Windows (זהה לזה שההתקנה יוצרת). */
export const STARTUP_NAME = 'Claude בטלפון';

/**
 * הפעלה אוטומטית בכניסה ל-Windows: קיצור דרך בתיקיית Startup של המשתמש.
 * (משימה מתוזמנת נכשלת כשיש בנתיב אותיות עבריות: Task Scheduler מחזיר "שם התיקייה אינו חוקי".)
 * מוחק גם את המשימה המתוזמנת הישנה.
 */
export function startupScript(launcher: string): string {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const dir = launcher.replace(/[\\/][^\\/]+$/, '');
  return [
    `Unregister-ScheduledTask -TaskName 'ClaudePhone Agent' -Confirm:$false -ErrorAction SilentlyContinue`,
    `$d = [Environment]::GetFolderPath('Startup')`,
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d ${q(STARTUP_NAME + '.lnk')}))`,
    `$s.TargetPath = (Join-Path $env:SystemRoot 'System32\\wscript.exe')`,
    `$s.Arguments = ${q(`"${launcher}" --no-open`)}`,
    `$s.WorkingDirectory = ${q(dir)}`,
    `if (Test-Path -LiteralPath ${q(dir + '\\icon.ico')}) { $s.IconLocation = ${q(dir + '\\icon.ico,0')} }`,
    `$s.Description = 'Claude בטלפון: הפעלת הסוכן בכניסה ל-Windows'`,
    `$s.Save()`,
  ].join('; ');
}

/** חלון בחירת תיקייה של Windows (נפתח על המסך של המחשב). מחזיר את הנתיב, או null אם בוטל. */
export function pickFolder(initial: string | null, title: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const ps = [
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `$f = New-Object System.Windows.Forms.FolderBrowserDialog`,
    `$f.Description = ${q(title)}`,
    `$f.ShowNewFolderButton = $true`,
    initial ? `if (Test-Path -LiteralPath ${q(initial)}) { $f.SelectedPath = ${q(initial)} }` : '',
    `$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }`,
    `if ($f.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('PICKED:' + $f.SelectedPath) }`,
  ].filter(Boolean).join('; ');
  return new Promise(res => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.setEncoding('utf8').on('data', d => { out += d; });
    const t = setTimeout(() => p.kill(), 10 * 60_000);
    p.on('close', () => { clearTimeout(t); const m = out.match(/PICKED:(.+)/); res(m ? m[1].trim() : null); });
    p.on('error', () => { clearTimeout(t); res(null); });
  });
}
