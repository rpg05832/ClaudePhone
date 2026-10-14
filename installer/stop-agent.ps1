# עצירת הסוכן והמנהרה שלו.
$root  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pidFile = Join-Path $root 'agent\data\agent.pid'
if (Test-Path $pidFile) {
  $id = [int](Get-Content $pidFile)
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    Write-Host "הסוכן הקודם (תהליך $id) נעצר"
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
$cf = Join-Path $root 'agent\bin\cloudflared.exe'
Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cf } | Stop-Process -Force -ErrorAction SilentlyContinue
