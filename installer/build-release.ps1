# בונה את קובץ ההתקנה ClaudePhone-Setup-<גרסה>.exe מהקוד שבתיקייה הזו.
# שלבים: אריזת הסוכן לקובץ אחד (esbuild), איסוף הרכיבים לתיקיית build\app, והידור עם Inno Setup.
param([string]$Version = '0.3.0')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$inst = Join-Path $root 'installer'
$out  = Join-Path $inst 'build'
$app  = Join-Path $out 'app'
$agentOut = Join-Path $app 'agent'
function Step($t) { Write-Host "== $t" }

Step 'ניקוי'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $agentOut 'dist'), (Join-Path $app 'runtime') | Out-Null

Step 'אריזת הסוכן (esbuild)'
Push-Location $root
try {
  if (-not (Test-Path (Join-Path $root 'node_modules\esbuild'))) { & npm install --no-save --no-audit --no-fund esbuild@0.24.2; if ($LASTEXITCODE) { throw 'התקנת esbuild נכשלה' } }
  $banner = "import { createRequire as __cpRequire } from 'node:module'; const require = __cpRequire(import.meta.url);"
  & npx --no-install esbuild agent/src/main.ts --bundle --platform=node --format=esm --target=node22 `
      "--outfile=$agentOut\dist\agent.mjs" --external:@anthropic-ai/claude-agent-sdk "--banner:js=$banner" --log-level=warning
  if ($LASTEXITCODE) { throw 'האריזה נכשלה' }
} finally { Pop-Location }
Copy-Item (Join-Path $root 'agent\src\store\schema.sql') (Join-Path $agentOut 'dist\schema.sql')

Step 'קבצי הסוכן'
Copy-Item (Join-Path $root 'agent\config.example.json') $agentOut
Copy-Item (Join-Path $root 'agent\web') (Join-Path $agentOut 'web') -Recurse
Copy-Item (Join-Path $root 'agent\channel') (Join-Path $agentOut 'channel') -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $agentOut 'stt') | Out-Null
Copy-Item (Join-Path $root 'agent\stt\transcribe.py') (Join-Path $agentOut 'stt')
$cf = Join-Path $root 'agent\bin\cloudflared.exe'
if (Test-Path $cf) { New-Item -ItemType Directory -Force -Path (Join-Path $agentOut 'bin') | Out-Null; Copy-Item $cf (Join-Path $agentOut 'bin') }
else { Write-Host 'אזהרה: cloudflared לא נכלל; האשף יוריד אותו' }

Step 'Agent SDK (כולל Claude Code)'
$sdkVer = (Get-Content (Join-Path $root 'node_modules\@anthropic-ai\claude-agent-sdk\package.json') -Raw | ConvertFrom-Json).version
$pkg = [ordered]@{ name = 'claude-phone-agent'; version = $Version; private = $true; type = 'module'; dependencies = [ordered]@{ '@anthropic-ai/claude-agent-sdk' = $sdkVer } }
[IO.File]::WriteAllText((Join-Path $agentOut 'package.json'), ($pkg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
Push-Location $agentOut
try { & npm install --omit=dev --no-audit --no-fund --no-package-lock; if ($LASTEXITCODE) { throw 'התקנת ה-SDK נכשלה' } } finally { Pop-Location }
if (-not (Test-Path (Join-Path $agentOut 'node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'))) { throw 'claude.exe לא הותקן עם ה-SDK' }

Step 'Node.js ומפעיל'
Copy-Item (Get-Command node).Source (Join-Path $app 'runtime\node.exe')
Copy-Item (Join-Path $inst 'release\launcher.vbs') $app
Copy-Item (Join-Path $inst 'release\stop.ps1') $app
Copy-Item (Join-Path $inst 'release\icon.ico') $app
Set-Content -Path (Join-Path $app 'version.txt') -Value $Version -Encoding ASCII

Step 'בדיקת עשן לחבילה'
# הקובץ הוא נקודת כניסה (מריץ את הסוכן), ולכן בודקים רק שהוא נטען תחבירית:
& (Join-Path $app 'runtime\node.exe') --check (Join-Path $agentOut 'dist\agent.mjs')
if ($LASTEXITCODE) { throw 'agent.mjs לא תקין' }

Step 'הידור קובץ ההתקנה'
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 לא נמצא' }
& $iscc "/DAppVersion=$Version" (Join-Path $inst 'claude-phone.iss')
if ($LASTEXITCODE) { throw 'ההידור נכשל' }
$exe = Get-ChildItem (Join-Path $inst 'output') -Filter "ClaudePhone-Setup-$Version.exe" | Select-Object -First 1
Write-Host ("נוצר: {0} ({1:N0} MB)" -f $exe.FullName, ($exe.Length / 1MB))
# טביעת אצבע לבדיקת הקובץ אחרי הורדה (העדכון מתוך התוכנה משתמש בה אם GitHub לא מפרסם אחת)
$hash = (Get-FileHash $exe.FullName -Algorithm SHA256).Hash.ToLower()
Set-Content -Path ($exe.FullName + '.sha256') -Value "$hash  $($exe.Name)" -Encoding ASCII
Write-Host "SHA256: $hash"
