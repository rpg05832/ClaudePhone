# הגדרת קוד PIN לכניסה מהטלפון. הקוד לא מוצג במסך ולא נשמר, רק גיבוב שלו.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
function ReadSecret($prompt) {
  $s = Read-Host -AsSecureString $prompt
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
$a = ReadSecret 'קוד חדש (4 עד 8 ספרות)'
$b = ReadSecret 'שוב, לאישור'
if ($a -ne $b) { Write-Host 'הקודים לא זהים. לא נשמר.' -ForegroundColor Red; exit 1 }
$env:CP_NEW_PIN = $a
node (Join-Path $root 'agent\scripts\set-pin.mjs')
Remove-Item Env:\CP_NEW_PIN
