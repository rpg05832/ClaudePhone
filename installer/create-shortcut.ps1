# יוצר בשולחן העבודה קיצור דרך ללוח הבקרה, עם אסימון הכניסה המקומי. הלוח נגיש רק מהמחשב הזה.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tokenFile = Join-Path $root 'agent\data\dashboard.token'
if (-not (Test-Path $tokenFile)) {
  # הסוכן יוצר את האסימון בהפעלה הראשונה; אם הוא עוד לא רץ, יוצרים כאן
  $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  New-Item -ItemType Directory -Force -Path (Split-Path $tokenFile) | Out-Null
  [IO.File]::WriteAllText($tokenFile, "$hex`n", (New-Object Text.UTF8Encoding $false))
}
$token = (Get-Content $tokenFile -Raw).Trim()
$cfg = Join-Path $root 'agent\config.json'
$port = 7788
if (Test-Path $cfg) { $c = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json; if ($c.dashboard.port) { $port = $c.dashboard.port } }
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'לוח הבקרה - Claude בטלפון.url'
[IO.File]::WriteAllText($path, "[InternetShortcut]`r`nURL=http://127.0.0.1:$port/?t=$token`r`n", (New-Object Text.UTF8Encoding $false))
Write-Host "נוצר קיצור דרך בשולחן העבודה: $path"
