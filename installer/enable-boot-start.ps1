# הפעלת הסוכן עם הפעלת המחשב, גם כשאף אחד לא מחובר למשתמש שלך (למשל כשמשתמש אחר במחשב).
# מריצים פעם אחת, כמנהל (Run as administrator), מהמשתמש שעליו הותקנה התוכנה:
#   powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\ClaudePhone\enable-boot-start.ps1"
# נדרשת הסיסמה של המשתמש הזה ב-Windows (חייבת להיות סיסמה). ביטול: -Remove
param([switch]$Remove)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$task = 'ClaudePhone Boot'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'צריך להריץ כמנהל (Run as administrator)' }
if ($Remove) { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue; Write-Host 'ההפעלה עם המחשב בוטלה'; return }

$app = Join-Path $env:LOCALAPPDATA 'ClaudePhone'
$vbs = Join-Path $app 'launcher.vbs'
if (-not (Test-Path $vbs)) { throw "לא נמצאה התקנה ב-$app. מריצים מהמשתמש שהתקין" }

$cred = Get-Credential -UserName $id.Name -Message 'סיסמת Windows של המשתמש הזה (כדי שהסוכן ירוץ גם בלי התחברות)'
$action  = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$vbs`" --no-open" -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null

# קיצור ההפעלה בכניסה (Startup) היה מפעיל עותק שני כשנכנסים למשתמש; המשימה מחליפה אותו
Get-ChildItem ([Environment]::GetFolderPath('Startup')) -Filter '*.lnk' | Where-Object { $_.Name -like 'Claude*' } | Remove-Item -Force -ErrorAction SilentlyContinue

# מי שרץ כבר (מהמשתמש הנוכחי) נעצר כדי שהמשימה תפעיל אחד נקי
& (Join-Path $app 'stop.ps1') 2>$null
Start-ScheduledTask -TaskName $task
Start-Sleep 8
Write-Host ('מצב המשימה: ' + (Get-ScheduledTask -TaskName $task).State)
Write-Host 'בדיקה: אחרי הפעלה מחדש של המחשב, בלי להיכנס למשתמש שלך, לוח הבקרה אמור להיפתח מהטלפון.'
