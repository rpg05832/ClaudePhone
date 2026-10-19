<div dir="rtl">

# פרסום גרסה חדשה

כל מי שהתקין את התוכנה מקבל את הגרסה החדשה מתוך התוכנה, ברגע שהיא מתפרסמת ב-Releases של המאגר.

## המאגר
1. התוכנה בודקת עדכונים בשני מאגרים: `shmuel-sinay/ClaudePhone` (שלך) ו-`rpg05832/ClaudePhone` (המקורי), ומציעה את הגרסה הגבוהה (בשוויון, שלך). אפשר לשנות בלוח הבקרה, "הגדרות ותקינות". כדי לקבל שינויים מהמקורי בלי לאבד את שלך: `git remote add upstream https://github.com/rpg05832/ClaudePhone`, `git fetch upstream`, `git merge upstream/main`, ואז מפרסמים גרסה גבוהה יותר.
2. המאגר ציבורי, ולכן התוכנה קוראת את ה-Releases שלו בלי התחברות. מאגר אחר שתבחר צריך להיות ציבורי גם הוא.
3. קובץ ההגדרות האישי (`agent\config.json`), הטוקן, קוד הכניסה וההקלטות לא נכנסים למאגר (`.gitignore`).

## כל גרסה
1. מעלים את מספר הגרסה ובונים:
   ```
   powershell -ExecutionPolicy Bypass -File installer\build-release.ps1 -Version 0.6.3
   ```
   נוצרים `installer\output\ClaudePhone-Setup-0.6.3.exe` ו-`ClaudePhone-Setup-0.6.3.exe.sha256`.

   ואותה גרסה ללינוקס (אפשר מאותו מחשב Windows; מוריד את Node ואת cloudflared ללינוקס):
   ```
   node installer/build-linux.mjs --version 0.6.3
   ```
   נוצרים `ClaudePhone-linux-x64-0.6.3.tar.gz`, `ClaudePhone-linux-arm64-0.6.3.tar.gz`, קובצי `.sha256` שלהם, ו-`install.sh`.
2. שומרים ודוחפים את הקוד: `git add -A`, `git commit -m "גרסה 0.6.3"`, `git push`.
3. מפרסמים בפקודה אחת (יוצרת טיוטה, מעלה את 7 הקבצים, ומפרסמת):
   ```
   powershell -ExecutionPolicy Bypass -File installer\publish-release.ps1 -Version 0.6.3
   ```
   דורש פעם אחת טוקן גישה של GitHub בקובץ `%LOCALAPPDATA%\ClaudePhone\github-token.txt` (מחוץ למאגר): ב-GitHub, Settings, Developer settings, Fine-grained tokens, עם גישה למאגר הזה בלבד והרשאת Contents: Read and write. גוף ההודעה נלקח מ-`docs\release-notes-<גרסה>.md` (בלי שורת הכותרת). אם התג כבר קיים, הסקריפט עוצר.

   או ידנית, ב-GitHub: לשונית Releases, "Draft a new release".
   - Tag: `v0.6.3` (Create new tag)
   - Title: `גרסה 0.6.3`
   - בתיאור: מה חדש (יוצג בלוח הבקרה לפני העדכון)
   - גוררים לאזור הקבצים את כל מה שנוצר ב-`installer\output` לגרסה הזו: `.exe`, שני קובצי ה-`.tar.gz`, כל קובצי ה-`.sha256`, ו-`install.sh`
   - "Publish release" (לא Pre-release)
4. בתוך כמה שעות כל התוכנות המותקנות יראו "גרסה 0.6.3 זמינה". לבדיקה מיידית: בלוח הבקרה, "הגדרות ותקינות", "בדוק עכשיו".

## כללים
- כל גרסה מתפרסמת לשתי המערכות יחד. Release בלי קובץ לינוקס לא יופיע כעדכון בלינוקס (ולהפך).
- שמות הקבצים חייבים להיות בדיוק `ClaudePhone-Setup-<גרסה>.exe` ו-`ClaudePhone-linux-<x64|arm64>-<גרסה>.tar.gz`, והגרסה גבוהה מהגרסה המותקנת.
- `install.sh` חייב להיות בכל Release: פקודת ההתקנה בלינוקס מורידה אותו מה-Release האחרון.
- התוכנה בודקת את גודל הקובץ ואת טביעת האצבע (SHA-256) שלו לפני ההתקנה. קובץ פגום לא יותקן.
- עדכון שנכשל לא פוגע בהתקנה הקיימת. אם התוכנה לא עלתה אחרי עדכון, מריצים את קובץ ההתקנה ידנית.

</div>
