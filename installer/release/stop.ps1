# עוצר את הסוכן המותקן (ואת התהליכים שהפעיל): משמש בהתקנה מחדש ובהסרה.
param([switch]$RemoveTask)
$app = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $app 'agent\data\agent.pid'
if (Test-Path $pidFile) {
  $id = [int](Get-Content $pidFile -Raw)
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.Path -and $p.Path.StartsWith($app, [StringComparison]::OrdinalIgnoreCase)) { & taskkill.exe /PID $id /T /F | Out-Null }
}
Get-Process cloudflared, node, claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($app, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
if ($RemoveTask) {
  $t = Get-ScheduledTask -TaskName 'ClaudePhone Agent' -ErrorAction SilentlyContinue
  if ($t -and ($t.Actions | Where-Object { $_.Arguments -like "*$app*" })) { Unregister-ScheduledTask -TaskName 'ClaudePhone Agent' -Confirm:$false }
  $desk = [Environment]::GetFolderPath('Desktop')
  Remove-Item (Join-Path $desk 'לוח הבקרה - Claude בטלפון.url') -ErrorAction SilentlyContinue
}
