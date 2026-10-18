# פרסום גרסה ב-GitHub Releases: יוצר את הגרסה כטיוטה, מעלה את 7 הקבצים מ-installer\output, ומפרסם.
#
#   powershell -ExecutionPolicy Bypass -File installer\publish-release.ps1 -Version 0.7.4
#
# דורש טוקן גישה של GitHub (Fine-grained, הרשאת Contents: Read and write על המאגר) בקובץ
# %LOCALAPPDATA%\ClaudePhone\github-token.txt (מחוץ למאגר; לא נכנס ל-git). הקבצים ב-output נוצרים קודם עם
# build-release.ps1 ו-build-linux.mjs (ראה docs\releasing.md). גוף ההודעה: docs\release-notes-<גרסה>.md בלי שורת הכותרת.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = 'rpg05832/ClaudePhone',
  [string]$TokenFile = (Join-Path $env:LOCALAPPDATA 'ClaudePhone\github-token.txt'),
  [switch]$Draft   # להשאיר כטיוטה (לא לפרסם)
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $PSScriptRoot 'output'
$notes = Join-Path $root "docs\release-notes-$Version.md"

if (!(Test-Path $TokenFile)) { throw "חסר קובץ הטוקן: $TokenFile" }
$token = (Get-Content $TokenFile -Raw).Trim()
if (!$token) { throw "קובץ הטוקן ריק: $TokenFile" }
if (!(Test-Path $notes)) { throw "חסרות הודעות הגרסה: $notes" }

$files = @("ClaudePhone-Setup-$Version.exe", "ClaudePhone-Setup-$Version.exe.sha256",
  "ClaudePhone-linux-x64-$Version.tar.gz", "ClaudePhone-linux-x64-$Version.tar.gz.sha256",
  "ClaudePhone-linux-arm64-$Version.tar.gz", "ClaudePhone-linux-arm64-$Version.tar.gz.sha256",
  'install.sh')
foreach ($f in $files) { if (!(Test-Path (Join-Path $out $f))) { throw "חסר קובץ: installer\output\$f (צריך לבנות קודם)" } }

$H = @('-H', "Authorization: Bearer $token", '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28')
function Api($method, $url, $body) {
  $args = @('-sS', '-X', $method) + $H
  if ($body -ne $null) {
    $tmp = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmp, ($body | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))
    $args += @('-H', 'Content-Type: application/json', '--data-binary', "@$tmp")
  }
  $r = & curl.exe @args $url
  if ($tmp) { Remove-Item $tmp -ErrorAction SilentlyContinue }
  if ($LASTEXITCODE -ne 0) { throw "הבקשה ל-GitHub נכשלה: $url" }
  $j = $r | ConvertFrom-Json
  if ($j.message -and -not $j.id -and -not $j.login) { throw "GitHub: $($j.message) ($url)" }
  return $j
}

$me = Api GET 'https://api.github.com/user' $null
$repo = Api GET "https://api.github.com/repos/$Repo" $null
if (-not $repo.permissions.push) { throw "לחשבון $($me.login) אין הרשאת כתיבה למאגר $Repo" }
Write-Host "מחובר כ-$($me.login) למאגר $Repo"

# גרסה קיימת עם אותו תג: עוצרים (למחוק ב-GitHub קודם, או לבחור מספר גרסה אחר)
$existing = & curl.exe -sS @H "https://api.github.com/repos/$Repo/releases/tags/v$Version" | ConvertFrom-Json
if ($existing.id) { throw "כבר קיימת גרסה v$Version ב-GitHub. למחוק אותה שם קודם, או לבחור מספר אחר." }

# גוף ההודעה בלי שורת הכותרת הראשונה (הכותרת היא שם הגרסה)
$body = ((Get-Content $notes -Raw -Encoding UTF8) -replace '^\s*#[^\r\n]*\r?\n', '').Trim()
$rel = Api POST "https://api.github.com/repos/$Repo/releases" @{ tag_name = "v$Version"; target_commitish = 'main'; name = "גרסה $Version"; body = $body; draft = $true; prerelease = $false }
Write-Host "נוצרה טיוטה: $($rel.html_url)"
$uploadBase = ($rel.upload_url -replace '\{\?.*$', '')

foreach ($f in $files) {
  $path = Join-Path $out $f
  $mb = [math]::Round((Get-Item $path).Length / 1MB, 1)
  Write-Host "מעלה $f ($mb MB)..." -NoNewline
  $r = & curl.exe -sS -X POST @H -H 'Content-Type: application/octet-stream' --data-binary "@$path" "$uploadBase`?name=$([uri]::EscapeDataString($f))" | ConvertFrom-Json
  if (-not $r.id) { throw "העלאת $f נכשלה: $($r.message) $($r.errors | ConvertTo-Json -Compress)" }
  if ($r.size -ne (Get-Item $path).Length) { throw "העלאת $f לא שלמה ($($r.size) מתוך $((Get-Item $path).Length) בתים)" }
  Write-Host ' הועלה'
}

if ($Draft) { Write-Host "נשאר כטיוטה: $($rel.html_url)"; exit 0 }
$pub = Api PATCH "https://api.github.com/repos/$Repo/releases/$($rel.id)" @{ draft = $false; make_latest = 'true' }
Write-Host "פורסם: $($pub.html_url)"
