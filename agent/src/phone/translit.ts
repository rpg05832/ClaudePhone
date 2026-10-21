// תעתיק לעברית של שמות באנגלית, כדי שההקראה בטלפון תישאר בקול העברי ולא תעבור לקול אנגלי
// (שאז גם המספרים אחריה מוקראים באנגלית). השם האמיתי של המאגר והתיקייה לא משתנה, רק איך שהוא נשמע.

const WORDS: Record<string, string> = {
  site: 'סייט', app: 'אפ', apps: 'אפס', api: 'איי פי איי', web: 'ווב', website: 'ווב סייט', bot: 'בוט', test: 'טסט', tests: 'טסטס',
  project: 'פרויקט', claude: 'קלוד', phone: 'פון', github: 'גיטהאב', git: 'גיט', hub: 'האב', my: 'מיי', the: 'דה', new: 'ניו',
  old: 'אולד', server: 'סרבר', client: 'קליינט', dashboard: 'דשבורד', agent: 'אייגנט', code: 'קוד', data: 'דאטה', shop: 'שופ',
  store: 'סטור', game: 'גיים', chat: 'צאט', ai: 'איי איי', ui: 'יו איי', tool: 'טול', tools: 'טולס', system: 'סיסטם',
  manager: 'מנג׳ר', admin: 'אדמין', mobile: 'מובייל', android: 'אנדרואיד', ios: 'איי או אס', react: 'ריאקט', node: 'נוד',
  js: 'ג׳יי אס', ts: 'טי אס', python: 'פייתון', home: 'הום', page: 'פייג׳', landing: 'לנדינג', blog: 'בלוג', demo: 'דמו',
  backup: 'בקאפ', docs: 'דוקס', main: 'מיין', free: 'פרי', yemot: 'ימות', ivr: 'איי וי אר', bank: 'בנק', online: 'אונליין',
  list: 'ליסט', todo: 'טודו', calendar: 'קלנדר', email: 'אימייל', mail: 'מייל', video: 'וידאו', music: 'מיוזיק', school: 'סקול',
  cloud: 'קלאוד', tracker: 'טראקר', service: 'סרוויס', pro: 'פרו', lite: 'לייט', beta: 'בטא', v: 'וי',
};

const DIGITS = ['אפס', 'אחד', 'שניים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע'];

/** מספר מקש בעברית מדוברת ("הקש שניים"), כדי שההקראה לא תעבור לקול אנגלי. */
export function keyWord(n: number): string { return n >= 0 && n <= 9 ? DIGITS[n] : String(n); }

const FINAL: Record<string, string> = { מ: 'ם', נ: 'ן', פ: 'ף', צ: 'ץ', כ: 'ך' };

function letters(word: string): string {
  const w = word.toLowerCase();
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i], n = w[i + 1] ?? '', pair = c + n, start = i === 0;
    const two: Record<string, string> = { sh: 'ש', ch: 'צ׳', th: 'ת', ph: 'פ', ck: 'ק', kh: 'ח', oo: 'ו', ee: 'י', ou: 'או', ai: 'אי', ay: 'יי', ea: 'י', au: 'או', qu: 'קו' };
    if (two[pair]) { out += two[pair]; i++; continue; }
    switch (c) {
      case 'a': out += start ? 'א' : ''; break;
      case 'e': out += start ? 'א' : ''; break;
      case 'i': out += start ? 'אי' : 'י'; break;
      case 'o': out += start ? 'או' : 'ו'; break;
      case 'u': out += start ? 'או' : 'ו'; break;
      case 'y': out += 'י'; break;
      case 'b': out += 'ב'; break;
      case 'c': out += 'eiy'.includes(n) && n ? 'ס' : 'ק'; break;
      case 'd': out += 'ד'; break;
      case 'f': out += 'פ'; break;
      case 'g': out += 'eiy'.includes(n) && n ? 'ג׳' : 'ג'; break;
      case 'h': out += 'ה'; break;
      case 'j': out += 'ג׳'; break;
      case 'k': out += 'ק'; break;
      case 'l': out += 'ל'; break;
      case 'm': out += 'מ'; break;
      case 'n': out += 'נ'; break;
      case 'p': out += 'פ'; break;
      case 'q': out += 'ק'; break;
      case 'r': out += 'ר'; break;
      case 's': out += 'ס'; break;
      case 't': out += 'ט'; break;
      case 'v': case 'w': out += 'ו'; break;
      case 'x': out += 'קס'; break;
      case 'z': out += 'ז'; break;
      default: break;
    }
  }
  if (!out) return '';
  const last = out[out.length - 1];
  return FINAL[last] ? out.slice(0, -1) + FINAL[last] : out;
}

/** שם באנגלית (גם עם מקפים, קווים תחתונים, נקודות ומספרים) בתעתיק עברי להקראה. מילים בעברית נשארות כמו שהן. */
export function spokenHebrew(name: string): string {
  const parts = name.match(/[A-Za-z]+|[0-9]+|[֐-׿]+/g) ?? [];
  const spoken = parts.map(p => {
    if (/^[0-9]+$/.test(p)) return [...p].map(d => DIGITS[Number(d)]).join(' ');
    if (/^[A-Za-z]+$/.test(p)) return WORDS[p.toLowerCase()] ?? letters(p);
    return p;
  }).filter(Boolean);
  return spoken.join(' ').trim() || name;
}
