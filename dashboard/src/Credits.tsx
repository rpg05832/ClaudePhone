// קרדיטים: מוצגים בתחתית הלוח, במסך הפתיחה של האשף ובלשונית העזרה.
export const BASE_REPO = 'https://github.com/zevisvei/claude-code-yemot-hooks';

export function CreditLine() {
  return (
    <p className="credit">
      נבנה על ידי <b>@ארי</b> ממתמחים טופ, בעזרת Claude.
      {' '}מבוסס על <a href={BASE_REPO} target="_blank" rel="noreferrer" dir="ltr">claude-code-yemot-hooks</a> של zevisvei.
    </p>
  );
}

export function CreditsSection() {
  return (
    <>
      <p><b>@ארי ממתמחים טופ</b> בנה את המערכת בעזרת Claude.</p>
      <p>המערכת מבוססת על הפרויקט <a href={BASE_REPO} target="_blank" rel="noreferrer" dir="ltr">zevisvei/claude-code-yemot-hooks</a> של zevisvei, שמחבר את Claude Code לימות המשיח. ממנו נלקחו דפוסי זרימת השיחה בימות ואופן העברת בקשות האישור של Claude Code לטלפון. הפרויקט המקורי מופץ ברישיון MIT.</p>
    </>
  );
}
