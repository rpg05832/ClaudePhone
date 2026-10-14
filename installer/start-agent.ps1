# הפעלת הסוכן. אם כבר רץ, עוצר את הקודם. הפלט נכתב ל-agent\data\agent-console.log
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$agent = Join-Path $root 'agent'
& (Join-Path $root 'installer\stop-agent.ps1')
$log = Join-Path $agent 'data\agent-console.log'
$err = Join-Path $agent 'data\agent-console.err.log'
$p = Start-Process node -ArgumentList '--experimental-transform-types','--no-warnings=ExperimentalWarning','--use-system-ca','src/main.ts' `
  -WorkingDirectory $agent -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
Set-Content -Path (Join-Path $agent 'data\agent.pid') -Value $p.Id
Write-Host "הסוכן הופעל (תהליך $($p.Id)). לוח הבקרה: קיצור הדרך בשולחן העבודה"
