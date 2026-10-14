# מעביר את ההתקנה של "Claude בטלפון" מהתיקייה המבודדת של אפליקציית Claude לתיקייה הרגילה של Windows.
# רקע: התקנה שהופעלה מתוך אפליקציית Claude (חבילת MSIX) נכתבת ל-AppData המבודד של Claude, ו-Windows מבחוץ
# (שולחן העבודה, הפעלה אוטומטית) לא רואה אותה. הסקריפט חייב לרוץ מחוץ ל-Claude: לחיצה כפולה על "תיקון התקנה.cmd".
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dst = Join-Path $env:LOCALAPPDATA 'ClaudePhone'
function Say($t) { Write-Host $t }

$src = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'LocalCache\Local\ClaudePhone' } |
  Where-Object { Test-Path (Join-Path $_ 'agent\data') } | Select-Object -First 1

# בדיקה שאנחנו באמת מחוץ ל-Claude: קובץ שנכתב לתיקייה הרגילה לא אמור להופיע בתיקייה המבודדת
New-Item -ItemType Directory -Force $dst | Out-Null
$probe = Join-Path $dst ('.probe-' + [Guid]::NewGuid().ToString('N'))
Set-Content $probe 'x'
$inside = $src -and (Test-Path (Join-Path $src (Split-Path -Leaf $probe)))
Remove-Item $probe -Force -ErrorAction SilentlyContinue
if ($inside) { Say 'הקובץ רץ מתוך אפליקציית Claude. סגור את החלון והפעל את "תיקון התקנה" בלחיצה כפולה מהתיקייה.'; exit 2 }

$setup = Get-ChildItem (Join-Path $root 'installer\output') -Filter 'ClaudePhone-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Say 'לא נמצא קובץ התקנה בתיקייה installer\output'; exit 1 }

Say '1. עוצר את התוכנה שרצה מהתיקייה המבודדת'
foreach ($dir in @($src, $dst) | Where-Object { $_ }) {
  $pidFile = Join-Path $dir 'agent\data\agent.pid'
  if (Test-Path $pidFile) { $id = [int](Get-Content $pidFile -Raw); & taskkill.exe /PID $id /T /F 2>$null | Out-Null }
}
Get-Process node, cloudflared, claude -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and ($_.Path -like '*\ClaudePhone\runtime\*' -or $_.Path -like '*\ClaudePhone\agent\*' -or ($src -and $_.Path.StartsWith($src, [StringComparison]::OrdinalIgnoreCase))) } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

if ($src) {
  Say '2. מעביר את ההגדרות, ההיסטוריה וההקלטות'
  $null = & robocopy.exe (Join-Path $src 'agent\data') (Join-Path $dst 'agent\data') /E /NFL /NDL /NJH /NJS /NP /XF agent.pid
  if ($LASTEXITCODE -ge 8) { Say 'העתקת הנתונים נכשלה'; exit 1 }
  $cfg = Join-Path $src 'agent\config.json'
  if (Test-Path $cfg) { Copy-Item $cfg (Join-Path $dst 'agent\config.json') -Force }
} else { Say '2. אין התקנה בתיקייה המבודדת. ממשיך להתקנה' }

Say ('3. מתקין את ' + $setup.Name)
$log = Join-Path $env:TEMP 'ClaudePhone-fix-install.log'
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + $log + '"') -PassThru -Wait
if ($p.ExitCode -ne 0) { Say ('ההתקנה נכשלה (קוד ' + $p.ExitCode + '). פרטים: ' + $log); exit 1 }

Say '4. בודק שהתוכנה עלתה'
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) { Start-Sleep 2; $ok = [bool](Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue) }

if ($src) {
  # התיקייה המבודדת נשמרת כגיבוי בשם אחר, כדי שלא תסתיר את ההתקנה הרגילה
  $bak = $src + '.old-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  try { Rename-Item $src $bak -ErrorAction Stop; Say ('   הגיבוי של ההתקנה הקודמת: ' + $bak) } catch { Say '   לא הצלחתי לשנות את שם התיקייה המבודדת (לא חובה)' }
}

if ($ok) {
  Say ''
  Say 'הסתיים בהצלחה. התוכנה מותקנת עכשיו במקום הרגיל ופועלת, כולל ההגדרות וההיסטוריה.'
  Say 'הקיצור "Claude בטלפון" בשולחן העבודה עובד, והתוכנה תעלה לבד גם אחרי הפעלה מחדש של המחשב.'
  & wscript.exe (Join-Path $dst 'launcher.vbs') --open
} else {
  Say 'ההתקנה הסתיימה, אבל התוכנה עוד לא עלתה. נסה ללחוץ על הקיצור "Claude בטלפון" בשולחן העבודה.'
}
