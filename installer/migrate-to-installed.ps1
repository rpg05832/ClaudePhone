# מעביר את המערכת מתיקיית הפיתוח לגרסה המותקנת (%LOCALAPPDATA%\ClaudePhone), כולל ההגדרות והנתונים.
# תיקיית הפיתוח לא נמחקת ולא משתנה; אפשר לחזור אליה עם start-agent.ps1 ו-install.ps1.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src  = Join-Path $repo 'agent'
$exe  = Get-ChildItem (Join-Path $repo 'installer\output') -Filter 'ClaudePhone-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$app  = Join-Path $env:LOCALAPPDATA 'ClaudePhone'
if (-not $exe) { throw 'לא נמצא קובץ התקנה; הרץ build-release.ps1' }

Write-Host '== עוצר את הסוכן של תיקיית הפיתוח'
& (Join-Path $repo 'installer\stop-agent.ps1')
Start-Sleep 2

Write-Host "== מתקין $($exe.Name)"
$p = Start-Process $exe.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=desktopicon' -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "ההתקנה נכשלה (קוד $($p.ExitCode))" }

Write-Host '== מעתיק הגדרות ונתונים'
Copy-Item (Join-Path $src 'config.json') (Join-Path $app 'agent\config.json') -Force
& robocopy.exe (Join-Path $src 'data') (Join-Path $app 'agent\data') /E /NFL /NDL /NJH /NJS /XF agent.pid agent-console.log agent-console.err.log | Out-Null
if ($LASTEXITCODE -ge 8) { throw "העתקת הנתונים נכשלה (robocopy $LASTEXITCODE)" }
$cfgPath = Join-Path $app 'agent\config.json'
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg | Add-Member -NotePropertyName setupDone -NotePropertyValue $true -Force
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))

Write-Host '== הפעלה אוטומטית בכניסה ל-Windows (מחליף את המשימה של תיקיית הפיתוח)'
$launcher = Join-Path $app 'launcher.vbs'
# schtasks /SC ONLOGON דורש מנהל; Register-ScheduledTask למשתמש הנוכחי לא
$act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`" --no-open" -WorkingDirectory $app
$trg = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'ClaudePhone Agent' -Action $act -Trigger $trg -Settings $set -Force | Out-Null

Write-Host '== מפעיל את הגרסה המותקנת'
Start-Process wscript.exe -ArgumentList "`"$launcher`"", '--no-open'
Write-Host "הועבר. תיקייה: $app"
