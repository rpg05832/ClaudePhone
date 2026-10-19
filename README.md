<div dir="rtl">

# Claude Code בטלפון

נותנים משימות ל-Claude Code מטלפון כשר, דרך שלוחה בימות המשיח, ושומעים את התשובות. הכל רץ על המחשב: אין שרת חיצוני, רק ימות המשיח ו-GitHub.

- הקלטת בקשה בקול, תמלול (שירות ההכתבה של Claude, או ivrit-ai במחשב; כל אחד גיבוי לשני) ואישור לפני שליחה; איותים בקול ("איי בי אלף מאתיים שלושים וארבע שטרודל ג'ימייל נקודה קום") הופכים לכתיב
- התשובה המלאה של Claude מוקראת בטלפון, ואפשר לקטוע בהקשה (או להסתפק בסיכום הקצר, לפי הגדרה)
- שיחה חדשה בפרויקט, המשך של שיחה קודמת (מהטלפון, מ-Claude Desktop, מהטרמינל, מ-VS Code ומ-Cowork ששמור במחשב), ושליחה לשיחה שפתוחה עכשיו בטרמינל
- אישור פקודות ומענה לשאלות של Claude מהטלפון, עם צינתוק כשצריך אותך
- לוח בקרה במחשב עם מסך שיחה כמו צ'אט (ופתיחת כל שיחה בטרמינל או בתיקייה שלה), עדכון מתוך התוכנה, וזמני שקט לשבת, לחג ולילה

## התקנה
צריך מנוי Claude וטוקן API של ימות המשיח. לא צריך להתקין את Claude Desktop או את Claude Code: המערכת כוללת מנוע משלה. לא נדרשות הרשאות מנהל.

**Windows:** מורידים את `ClaudePhone-Setup-<גרסה>.exe` מדף ה-[Releases](../../releases/latest), מריצים, ועוברים על האשף.

**לינוקס** (כל הפצה רגילה, x64 או arm64, מחשב עם מסך או שרת): פקודה אחת בטרמינל, בלי sudo:
<div dir="ltr">

```
curl -fsSL https://github.com/shmuel-sinay/ClaudePhone/releases/latest/download/install.sh | bash
```
</div>

ההתקנה נכנסת ל-`~/.local/share/claudephone`, נרשמת כשירות systemd של המשתמש (עולה עם הפעלת המחשב), ופותחת את אשף ההגדרה. בשרת בלי מסך היא מדפיסה פקודת SSH וכתובת לפתיחת האשף מהמחשב שלך. Python לתמלול מותקן מתוך האשף (גרסה ניידת, בלי תלות בהפצה). הסרה: `~/.local/share/claudephone/uninstall.sh`.

ההבדלים בלינוקס: אין Claude Desktop רשמי, ולכן אין המשך של שיחות Cowork (שיחות Claude Code רגילות כן). בשרת בלי מסך, "פתח בטרמינל" ו"פתח תיקייה" לא זמינים.

## עדכונים
התוכנה בודקת ב-Releases של המאגר הזה אם יש גרסה חדשה, ומתקינה אותה בלחיצה ("עדכן עכשיו" בלוח הבקרה), או לבד אם הופעל עדכון אוטומטי. ההגדרות, הפרויקטים וההיסטוריה נשמרים. איך מפרסמים גרסה: `docs/releasing.md`.

## מבנה
| תיקייה | מה יש בה |
|---|---|
| `agent/` | הסוכן: שרת ימות מאחורי מנהרת Cloudflare, זרימת הטלפון, תמלול, הרצת Claude (Agent SDK), מאגר (SQLite), עדכון |
| `dashboard/` | לוח הבקרה (React + Vite). ה-build נמצא ב-`agent/web` |
| `shared/` | טיפוסים משותפים |
| `installer/` | בניית קבצי ההתקנה: Windows (`build-release.ps1`, Inno Setup 6), לינוקס (`build-linux.mjs`, והסקריפטים ב-`installer/linux`) |
| `docs/` | ממצאים ומדריכים |

## פיתוח
```
npm install
cd agent && npm test
powershell -ExecutionPolicy Bypass -File installer\build-release.ps1 -Version 0.8.0
node installer/build-linux.mjs --version 0.8.0
```
דרישות לבנייה: Node 22.13 ומעלה; ל-Windows גם Inno Setup 6. את גרסת הלינוקס אפשר לבנות גם ממחשב Windows. הקבצים נוצרים ב-`installer/output`.

**כלל:** כל עדכון נעשה לשתי הגרסאות, Windows ולינוקס. מה ששונה בין המערכות מרוכז ב-`agent/src/platform.ts`, והבדיקות (`npm test`) רצות בשתי המערכות.

## קרדיטים
נבנה על ידי **@ארי ממתמחים טופ**, בעזרת Claude.

מבוסס על [zevisvei/claude-code-yemot-hooks](https://github.com/zevisvei/claude-code-yemot-hooks) של zevisvei (רישיון MIT): ממנו נלקחו דפוסי זרימת השיחה בימות ופרוטוקול העברת בקשות האישור של Claude Code לטלפון.

</div>
