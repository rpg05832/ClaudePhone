; קובץ ההתקנה של Claude בטלפון. נבנה ע"י build-release.ps1 (שמכין את build\app).
; התקנה למשתמש הנוכחי בלבד, בלי הרשאות מנהל, לתיקייה %LOCALAPPDATA%\ClaudePhone.
#ifndef AppVersion
  #define AppVersion "0.3.0"
#endif

[Setup]
AppId={{8C1B6F2E-4F7A-4E8B-9C21-5D3A7E0B1C42}
AppName=Claude בטלפון
AppVersion={#AppVersion}
AppPublisher=ארי ממתמחים טופ
AppCopyright=נבנה על ידי ארי ממתמחים טופ בעזרת Claude. מבוסס על claude-code-yemot-hooks של zevisvei (MIT)
AppComments=מבוסס על https://github.com/zevisvei/claude-code-yemot-hooks
DefaultDirName={localappdata}\ClaudePhone
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=ClaudePhone-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
UninstallDisplayName=Claude בטלפון
UninstallDisplayIcon={app}\icon.ico
SetupIconFile=release\icon.ico
CloseApplications=no

[Languages]
Name: "he"; MessagesFile: "compiler:Languages\Hebrew.isl"

[Files]
Source: "build\app\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; קיצור אחד בשולחן העבודה ובתפריט התחל: מפעיל את התוכנה אם היא כבויה ופותח את לוח הבקרה
Name: "{userprograms}\Claude בטלפון"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"" --open"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "לוח הבקרה של Claude בטלפון"
Name: "{userdesktop}\Claude בטלפון"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"" --open"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "לוח הבקרה של Claude בטלפון"
; הפעלה אוטומטית בכניסה ל-Windows (משימה מתוזמנת נכשלת כשבנתיב יש עברית)
Name: "{userstartup}\Claude בטלפון"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"" --no-open"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "Claude בטלפון: הפעלת הסוכן"

[InstallDelete]
; הקיצור הישן ללוח (עם האסימון בכתובת) הוחלף בקיצור "Claude בטלפון"
Type: files; Name: "{userdesktop}\לוח הבקרה - Claude בטלפון.lnk"
Type: files; Name: "{userdesktop}\לוח הבקרה - Claude בטלפון.url"

[Run]
; המשימה המתוזמנת מגרסאות קודמות לא עבדה (נתיב עם עברית): מוחקים אותה. ההפעלה האוטומטית היא קיצור הדרך ב-Startup.
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -Command ""Unregister-ScheduledTask -TaskName 'ClaudePhone Agent' -Confirm:$false -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"" --open"; Description: "פתח את אשף ההגדרה"; Flags: postinstall nowait skipifsilent
; התקנה שקטה (עדכון מתוך התוכנה): מפעילים את הסוכן מחדש בלי לפתוח חלון
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"" --no-open"; Flags: nowait; Check: WizardSilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\stop.ps1"" -RemoveTask"; Flags: runhidden waituntilterminated; RunOnceId: "StopAgent"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\agent\dist"
Type: filesandordirs; Name: "{app}\agent\node_modules"

[Code]
// בהתקנה מחדש (עדכון): עוצרים את הסוכן הקיים כדי שהקבצים לא יהיו נעולים. ההגדרות והנתונים (agent\data, config.json) נשמרים.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\stop.ps1')) then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\stop.ps1') + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

// בהסרה: שואלים אם למחוק גם את ההגדרות והנתונים (טוקן, היסטוריית משימות, הקלטות).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if MsgBox('למחוק גם את ההגדרות והנתונים (טוקן ימות, קוד הכניסה, היסטוריית המשימות וההקלטות)?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(ExpandConstant('{app}\agent\data'), True, True, True);
      DeleteFile(ExpandConstant('{app}\agent\config.json'));
      DelTree(ExpandConstant('{app}'), True, False, True);
    end;
end;
