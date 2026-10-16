// נרמול תמלול של איותים (לבקשת המשתמש, 16.10): כשאומרים בקול כתובת מייל, שם משתמש או קוד, התמלול העברי כותב
// "איי בי אלף מאתיים שלושים וארבע שטרודל ג'ימייל נקודה קום". כאן זה הופך ל-AB1234@gmail.com.
//
// הכלל המרכזי: המרה רק בהקשר של איות, כדי לא לפגוע בעברית רגילה ("אי אפשר", "די", "אם", "או" נשארים מילים):
//   - סביב "שטרודל" (כתובת מייל) ובסביבת "נקודה קום/נט/אורג/קו איל" (כתובת אתר): כל רצף האותיות, הספרות
//     והסימנים מומר ומחובר בלי רווחים.
//   - רצף של שתי אותיות מאויתות או יותר (למשל "אי אר", "פי די אף") מומר גם בלי שטרודל.
//   - אות מאויתת בודדת בתוך משפט לא נוגעים בה.
// מגבלה ידועה: בעברית A ו-I נשמעות שתיהן "איי", ו-E נשמעת "אי". ההנחה כאן: "אי" = E, "איי" = A.
// הטקסט המקורי נשמר ביומן לצד המנורמל, כדי לכוון את הכללים לפי התמלול בפועל.

const LETTERS: Record<string, string> = {
  'איי': 'A', 'אי': 'E', 'בי': 'B', 'סי': 'C', 'די': 'D', 'אף': 'F', "ג'י": 'G', 'גי': 'G',
  "אייץ'": 'H', 'אייץ': 'H', "הייץ'": 'H', 'הייץ': 'H', "ג'יי": 'J', 'גיי': 'J', 'קיי': 'K', 'קי': 'K', 'אל': 'L', 'אם': 'M', 'אן': 'N',
  'או': 'O', 'פי': 'P', 'קיו': 'Q', 'אר': 'R', 'אס': 'S', 'טי': 'T', 'יו': 'U', 'וי': 'V', 'דאבליו': 'W', 'דבליו': 'W',
  'אקס': 'X', 'איקס': 'X', 'וואי': 'Y', 'ואי': 'Y', 'זד': 'Z', 'זי': 'Z', 'זט': 'Z',
};

/** מילים שהן חלק מכתובת: שמות שירותים ותחיליות. מומרות רק בהקשר של כתובת. */
const DOMAIN_WORDS: Record<string, string> = {
  "ג'ימייל": 'gmail', 'גימייל': 'gmail', "ג'ימיל": 'gmail', 'גמייל': 'gmail', 'הוטמייל': 'hotmail', 'יאהו': 'yahoo', 'אאוטלוק': 'outlook',
  'וואלה': 'walla', 'גוגל': 'google', 'יוטיוב': 'youtube', 'פייסבוק': 'facebook', 'וואטסאפ': 'whatsapp', 'ווטסאפ': 'whatsapp',
  'גיטהאב': 'github', 'ויקיפדיה': 'wikipedia', 'אמזון': 'amazon', 'מיקרוסופט': 'microsoft', 'אפל': 'apple',
  'דרייב': 'drive', 'דוקס': 'docs', 'מייל': 'mail', 'אינפו': 'info', 'אדמין': 'admin', 'סאפורט': 'support', 'קונטקט': 'contact',
  'אופיס': 'office', 'לייב': 'live', 'פרוטון': 'proton', 'פרוטונמייל': 'protonmail', 'איקלאוד': 'icloud', 'www': 'www',
};

const TLDS: Record<string, string> = {
  'קום': 'com', 'קאם': 'com', 'נט': 'net', 'אורג': 'org', 'איל': 'il', 'אדו': 'edu', 'גוב': 'gov', 'אפ': 'app',
  'com': 'com', 'net': 'net', 'org': 'org', 'il': 'il', 'edu': 'edu', 'gov': 'gov', 'io': 'io', 'app': 'app', 'info': 'info', 'me': 'me',
};

/** צירופי מילים שמומרים לסימן אחד (לפני הטוקניזציה). גבולות מילה ידניים: \b לא עובד עם עברית. */
const PHRASES: [RegExp, string][] = [
  [/(^|\s)קו\s+תחתון(?=\s|$)/g, '$1_'],
  [/(^|\s)(?:נקודה\s+)?קו\s+(?:נקודה\s+)?איל(?=\s|$)/g, '$1נקודה קו.איל'],
  [/(^|\s)(?:דאבליו|דבליו)(?:\s+(?:דאבליו|דבליו)){2}(?=\s|$)/g, '$1www'],
  [/(^|\s)ג'?י\s+מייל(?=\s|$)/g, "$1ג'ימייל"],
  [/(^|\s)דאבל\s+יו(?=\s|$)/g, '$1דאבליו'],
  [/(^|\s)שטרודל(?=\s|$)/g, '$1@'],
  [/(^|\s)(?:סלאש|סלש)(?=\s|$)/g, '$1/'],
  [/(^|\s)נקודתיים(?=\s|$)/g, '$1:'],
  [/(^|\s)דוט(?=\s|$)/g, '$1נקודה'],
];

// ---------- מספרים במילים ----------
const UNITS: Record<string, number> = {
  'אפס': 0, 'אחת': 1, 'אחד': 1, 'שתיים': 2, 'שניים': 2, 'שתים': 2, 'שלוש': 3, 'שלושה': 3, 'ארבע': 4, 'ארבעה': 4, 'חמש': 5, 'חמישה': 5,
  'שש': 6, 'שישה': 6, 'שבע': 7, 'שבעה': 7, 'שמונה': 8, 'תשע': 9, 'תשעה': 9,
  // צורת נסמך לפני "אלפים": "שלושת אלפים"
  'שלושת': 3, 'ארבעת': 4, 'חמשת': 5, 'ששת': 6, 'שבעת': 7, 'שמונת': 8, 'תשעת': 9,
};
const TEENS: Record<string, number> = {
  'עשר': 10, 'עשרה': 10, 'אחת עשרה': 11, 'אחד עשר': 11, 'שתים עשרה': 12, 'שתיים עשרה': 12, 'שנים עשר': 12, 'שניים עשר': 12,
  'שלוש עשרה': 13, 'שלושה עשר': 13, 'ארבע עשרה': 14, 'ארבעה עשר': 14, 'חמש עשרה': 15, 'חמישה עשר': 15, 'שש עשרה': 16, 'שישה עשר': 16,
  'שבע עשרה': 17, 'שבעה עשר': 17, 'שמונה עשרה': 18, 'שמונה עשר': 18, 'תשע עשרה': 19, 'תשעה עשר': 19,
};
const TENS: Record<string, number> = { 'עשרים': 20, 'שלושים': 30, 'ארבעים': 40, 'חמישים': 50, 'שישים': 60, 'שבעים': 70, 'שמונים': 80, 'תשעים': 90 };
const HUNDREDS: Record<string, number> = { 'מאה': 100, 'מאתיים': 200 };
const NUM_WORDS = new Set([...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(HUNDREDS), 'מאות', 'אלף', 'אלפים', 'אלפיים', 'עשר', 'עשרה']);

/** "ושלוש" -> "שלוש" (ו' החיבור), אבל לא במילים שהן עצמן ערך כמו "וי" (V) או "ואי" (Y). */
function stripVav(w: string): string { return w.length > 2 && w.startsWith('ו') && !NUM_WORDS.has(w) && !LETTERS[w] ? w.slice(1) : w; }
function isNumWord(w: string): boolean { return NUM_WORDS.has(stripVav(w)); }

/**
 * קורא מספר במילים (ובספרות) מתחילת הרשימה. מחזיר [הספרות, כמה טוקנים נצרכו].
 * "אלף מאתיים שלושים וארבע" -> 1234; "אחת שתיים שלוש" (ספרה אחרי ספרה) -> 123; "אפס חמש" -> 05.
 */
function parseNumberWords(words: string[]): [string, number] | null {
  let i = 0, total = 0, group = 0, haveNum = false, prevBare = false, result = '';
  const at = (k: number) => stripVav(words[i + k] ?? '');
  const flush = () => { if (haveNum) { result += String(total + group); total = 0; group = 0; haveNum = false; } };
  const bareUnit = (k: number) => { const w = at(k); return w in UNITS && !['מאות', 'אלפים', 'אלף'].includes(at(k + 1)) && !(`${w} ${at(k + 1)}` in TEENS); };
  while (i < words.length) {
    const w = at(0), pair = words[i + 1] ? `${w} ${at(1)}` : '';
    if (pair && pair in TEENS) { group += TEENS[pair]; haveNum = true; prevBare = false; i += 2; continue; }
    if (w in TEENS) { group += TEENS[w]; haveNum = true; prevBare = false; i++; continue; }
    if (w in UNITS) {
      const nxt = at(1);
      if (nxt === 'מאות') { group += UNITS[w] * 100; haveNum = true; prevBare = false; i += 2; continue; }
      if (nxt === 'אלפים' || nxt === 'אלף') { total += (group + UNITS[w]) * 1000; group = 0; haveNum = true; prevBare = false; i += 2; continue; }
      // ספרה בודדת ברצף ספרות ("אחת שתיים שלוש", "אפס חמש"): תו אחרי תו, בלי חיבור
      if (w === 'אפס' || prevBare || bareUnit(1)) { flush(); result += String(UNITS[w]); prevBare = true; i++; continue; }
      group += UNITS[w]; haveNum = true; i++; continue;
    }
    prevBare = false;
    if (w in TENS) { group += TENS[w]; haveNum = true; i++; continue; }
    if (w in HUNDREDS) { group += HUNDREDS[w]; haveNum = true; i++; continue; }
    if (w === 'אלף' || w === 'אלפיים') { total += (group || 1) * (w === 'אלפיים' ? 2000 : 1000); group = 0; haveNum = true; i++; continue; }
    if (/^\d[\d,]*$/.test(words[i] ?? '')) { flush(); result += words[i].replace(/,/g, ''); i++; continue; }
    break;
  }
  flush();
  return i ? [result, i] : null;
}

type Kind = 'at' | 'dot' | 'sym' | 'letter' | 'digits' | 'numword' | 'tld' | 'domain' | 'latin' | 'word';
interface Tok { raw: string; kind: Kind; val: string; trail: string }

function classify(raw: string): Tok {
  const trail = (raw.match(/[.,!?]+$/) ?? [''])[0];
  const w = (trail ? raw.slice(0, -trail.length) : raw) || raw;   // פיסוק בסוף מילה לא קובע את הסוג
  const t = (kind: Kind, val: string): Tok => ({ raw, kind, val, trail: w === raw ? '' : trail });
  if (w === '@') return t('at', '@');
  if (w === 'נקודה') return t('dot', '.');
  if (w === 'קו.איל') return t('tld', 'co.il');
  if (w === '_' || w === '/' || w === ':' || w === '-' || w === 'מקף') return t('sym', w === 'מקף' ? '-' : w);
  if (/^\d[\d,]*$/.test(w)) return t('digits', w.replace(/,/g, ''));
  if (/^[A-Za-z]$/.test(w)) return t('letter', w.toUpperCase());
  if (/^[A-Za-z0-9][\w.-]*$/.test(w)) return t(TLDS[w.toLowerCase()] ? 'tld' : 'latin', TLDS[w.toLowerCase()] ?? w);
  if (LETTERS[w]) return t('letter', LETTERS[w]);
  if (DOMAIN_WORDS[w]) return t('domain', DOMAIN_WORDS[w]);
  if (TLDS[w]) return t('tld', TLDS[w]);
  if (isNumWord(w)) return t('numword', w);
  return t('word', raw);
}

const SPELLABLE = new Set<Kind>(['letter', 'digits', 'numword', 'sym', 'latin']);

/** הטקסט המנורמל. אם אין בו איות, חוזר כמות שהוא. */
export function normalizeSpelled(text: string): string {
  if (!text || !/\S/.test(text)) return text;
  let t = ' ' + text.replace(/[׳’]/g, "'").replace(/\s+/g, ' ') + ' ';
  for (const [re, rep] of PHRASES) t = t.replace(re, rep);
  const toks = t.trim().split(/\s+/).filter(Boolean).map(classify);
  const n = toks.length;
  const span = new Array<boolean>(n).fill(false);
  const kind = (k: number): Kind | '' => (k >= 0 && k < n ? toks[k].kind : '');
  const wordBeforeDot = (k: number) => kind(k) === 'word' && kind(k + 1) === 'dot' && !toks[k].trail;

  // 1. כתובת מייל: מ-@ מתרחבים לשני הצדדים
  for (let i = 0; i < n; i++) {
    if (toks[i].kind !== 'at') continue;
    let a = i - 1; while (a >= 0 && (SPELLABLE.has(toks[a].kind) || kind(a) === 'dot' || kind(a) === 'domain') && !toks[a].trail) a--;
    let b = i + 1; while (b < n && (SPELLABLE.has(toks[b].kind) || kind(b) === 'dot' || kind(b) === 'domain' || kind(b) === 'tld' || wordBeforeDot(b))) { const stop = !!toks[b].trail; b++; if (stop) break; }
    for (let k = a + 1; k < b; k++) span[k] = true;
  }
  // 2. כתובת אתר: "נקודה" ואחריה סיומת (קום/נט/אורג/קו איל): מתרחבים שמאלה על שמות, אותיות ונקודות
  for (let i = 0; i + 1 < n; i++) {
    if (!(toks[i].kind === 'dot' && toks[i + 1].kind === 'tld')) continue;
    let a = i - 1; while (a >= 0 && (SPELLABLE.has(toks[a].kind) || kind(a) === 'dot' || kind(a) === 'domain' || wordBeforeDot(a)) && !toks[a].trail) a--;
    let b = i + 1; while (b < n && (kind(b) === 'tld' || (kind(b) === 'dot' && kind(b + 1) === 'tld'))) { const stop = !!toks[b].trail; b++; if (stop) break; }
    for (let k = a + 1; k < b; k++) span[k] = true;
  }
  // 3. רצף של שתי אותיות מאויתות ומעלה (עם ספרות וסימנים ביניהן): איות גם בלי כתובת
  for (let i = 0; i < n; i++) {
    if (span[i] || toks[i].kind !== 'letter') continue;
    let b = i, letters = 0;
    while (b < n && SPELLABLE.has(toks[b].kind)) { if (toks[b].kind === 'letter') letters++; const stop = !!toks[b].trail; b++; if (stop) break; }
    if (letters >= 2) for (let k = i; k < b; k++) span[k] = true;
    i = b - 1;
  }
  // 4. רצף של שלוש מילות-מספר ומעלה ("אפס חמש חמש שש...", "מאה עשרים ושלוש"): ספרות
  for (let i = 0; i < n; i++) {
    if (span[i] || toks[i].kind !== 'numword') continue;
    let b = i, words = 0;
    while (b < n && (toks[b].kind === 'numword' || toks[b].kind === 'digits')) { if (toks[b].kind === 'numword') words++; const stop = !!toks[b].trail; b++; if (stop) break; }
    if (words >= 3) for (let k = i; k < b; k++) span[k] = true;
    i = b - 1;
  }

  // הרכבה: בתוך קטע מאוית מחברים בלי רווחים ומספרים במילים הופכים לספרות; מחוץ לו הכל נשאר כפי שהיה
  const out: string[] = [];
  for (let i = 0; i < n;) {
    if (!span[i]) { out.push(toks[i].raw); i++; continue; }
    let buf = '', afterAt = false, last = i;
    while (i < n && span[i]) {
      const tk = toks[i];
      last = i;
      if (tk.kind === 'numword' || tk.kind === 'digits') {
        const words: string[] = [];
        for (let k = i; k < n && span[k] && (toks[k].kind === 'numword' || toks[k].kind === 'digits'); k++) { words.push(toks[k].kind === 'digits' ? toks[k].val : toks[k].raw.slice(0, toks[k].raw.length - toks[k].trail.length)); if (toks[k].trail) break; }
        const parsed = parseNumberWords(words);
        if (parsed) { buf += parsed[0]; last = i + parsed[1] - 1; i += parsed[1]; continue; }
      }
      let piece = tk.kind === 'word' ? tk.raw.slice(0, tk.raw.length - tk.trail.length) : tk.val;
      if (tk.kind === 'at') afterAt = true;
      if ((tk.kind === 'letter' || tk.kind === 'latin') && afterAt) piece = piece.toLowerCase();
      buf += piece;
      i++;
    }
    out.push(buf + toks[last].trail);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
