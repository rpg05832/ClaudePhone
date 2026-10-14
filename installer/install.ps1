# התקנת Claude Code בטלפון (שלב 1): בדיקות, תלויות, הגדרות, והפעלה אוטומטית עם הכניסה ל-Windows.
# הרצה: לחיצה ימנית > Run with PowerShell, או:  powershell -ExecutionPolicy Bypass -File installer\install.ps1
param([switch]$SkipPin)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$needPin = $false
$ErrorActionPreference = 'Continue'
$root  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$agent = Join-Path $root 'agent'
$data  = Join-Path $agent 'data'
New-Item -ItemType Directory -Force -Path $data, (Join-Path $agent 'bin') | Out-Null
$ok = $true
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Good($t) { Write-Host "  V $t" -ForegroundColor Green }
function Bad($t)  { Write-Host "  X $t" -ForegroundColor Red; $script:ok = $false }

Step 'Node.js'
try { $nv = (node --version).Trim(); if ([version]($nv.TrimStart('v')) -ge [version]'22.13') { Good "Node $nv" } else { Bad "Node $nv ישן מדי (נדרש 22.13 ומעלה)" } } catch { Bad 'Node לא מותקן' }

Step 'Python + faster-whisper (תמלול מקומי)'
$py = 'python'
try { $pv = (& $py -c "import faster_whisper,sys;print(sys.version.split()[0], faster_whisper.__version__)" 2>$null); if ($LASTEXITCODE -eq 0) { Good "Python/faster-whisper: $pv" } else { throw 'x' } }
catch { Write-Host '  מתקין faster-whisper...'; & $py -m pip install --user faster-whisper | Out-Null; if ($LASTEXITCODE -eq 0) { Good 'faster-whisper הותקן' } else { Bad 'התקנת faster-whisper נכשלה' } }

Step 'תלויות הסוכן (npm install)'
Push-Location $root
npm install --no-audit --no-fund 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -eq 0) { Good 'הותקן' } else { Bad 'npm install נכשל' }
Pop-Location

Step 'cloudflared (מנהרה)'
$cf = Join-Path $agent 'bin\cloudflared.exe'
if (-not (Test-Path $cf)) {
  $old = Join-Path $root 'phase0\cloudflared.exe'
  if (Test-Path $old) { Copy-Item $old $cf; Good 'הועתק מתיקיית phase0' }
  else {
    Write-Host '  מוריד מ-GitHub...'
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -UseBasicParsing
    if (Test-Path $cf) { Good 'הורד' } else { Bad 'הורדת cloudflared נכשלה' }
  }
} else { Good 'קיים' }

Step 'קובץ הגדרות'
$cfgPath = Join-Path $agent 'config.json'
$cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
function Ensure($obj, $name) { if (-not ($obj.PSObject.Properties.Name -contains $name)) { $obj | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) }; $obj.$name }
$y = Ensure $cfg 'yemot'
if (-not $y.chatExtension) { $y | Add-Member -Force -NotePropertyName chatExtension -NotePropertyValue '9'; Write-Host '  שלוחת הצ׳אט: 9 (כמו בשלב 0; אפשר לשנות ב-config.json)' }
$pr = Ensure $cfg 'projects'
if (-not $pr.newProjectsParent) { $pr | Add-Member -Force -NotePropertyName newProjectsParent -NotePropertyValue (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ClaudeProjects') }
New-Item -ItemType Directory -Force -Path $pr.newProjectsParent | Out-Null
$tu = Ensure $cfg 'tunnel'
$tu | Add-Member -Force -NotePropertyName cloudflaredPath -NotePropertyValue 'bin/cloudflared.exe'
$ph = Ensure $cfg 'phones'
if (-not $ph.allowed -or $ph.allowed.Count -eq 0) { Bad 'אין מספרי טלפון מורשים: הוסף אותם ב-config.json תחת phones.allowed' } else { Good "$($ph.allowed.Count) מספרים מורשים" }
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
Good "תיקיית הפרויקטים: $($pr.newProjectsParent)"

Step 'סודות'
if (Test-Path (Join-Path $data 'yemot.token')) { Good 'טוקן ימות קיים' } else { Bad 'חסר data\yemot.token (טוקן API של ימות, שורה אחת)' }
if (Test-Path (Join-Path $data 'pin.hash')) { Good 'PIN מוגדר' } else { $needPin = $true; Write-Host '  עוד לא הוגדר PIN (יוגדר בסוף ההתקנה)' -ForegroundColor Yellow }

Step 'בדיקות אוטומטיות'
Push-Location $root
npm test 2>&1 | Select-String -Pattern '^# (pass|fail)' | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -eq 0) { Good 'כל הבדיקות עברו' } else { Bad 'יש בדיקות שנכשלו' }
Pop-Location

Step 'קיצור דרך ללוח הבקרה'
& (Join-Path $root 'installer\create-shortcut.ps1')

Step 'הפעלה אוטומטית עם הכניסה ל-Windows'
$start = Join-Path $root 'installer\start-agent.ps1'
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'ClaudePhone Agent' -Action $action -Trigger $trigger -Settings $settings -Description 'Claude Code בטלפון: הסוכן המקומי' -Force | Out-Null
Good 'נרשמה משימה מתוזמנת "ClaudePhone Agent"'

if ($needPin -and -not $SkipPin) { Step 'הגדרת PIN'; & (Join-Path $root 'installer\set-pin.ps1') }

Write-Host ''
if ($ok) { Write-Host 'ההתקנה הסתיימה בהצלחה. להפעלה עכשיו: installer\start-agent.ps1' -ForegroundColor Green }
else { Write-Host 'ההתקנה הסתיימה עם בעיות (מסומנות ב-X למעלה).' -ForegroundColor Yellow }
