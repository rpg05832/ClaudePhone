// זמני שקט: שעות לילה, שבת וחג לפי זמני ירושלים (@hebcal/core, חישוב מקומי בלי רשת).
// שבת/חג: מזמן הדלקת נרות (40 דקות לפני השקיעה, מנהג ירושלים) ועד צאת הכוכבים (8.5 מעלות), ועוד מרווח ביטחון.
import { HebrewCalendar, HDate, Location, Zmanim, flags } from '@hebcal/core';

export interface QuietConfig {
  start: string;              // "23:00"
  end: string;                // "07:00"
  shabbatAndChag: boolean;
  includeCholHamoed: boolean; // ברירת מחדל: לא (רק יום טוב)
  candleMinutes: number;      // דקות לפני השקיעה (ירושלים: 40)
  marginMinutes: number;      // מרווח ביטחון בכניסה וביציאה
}

export const DEFAULT_QUIET: QuietConfig = { start: '23:00', end: '07:00', shabbatAndChag: true, includeCholHamoed: false, candleMinutes: 40, marginMinutes: 20 };

const JERUSALEM = Location.lookup('Jerusalem')!;
const TZ = 'Asia/Jerusalem';

/** תאריך ושעה אזרחיים בירושלים. */
function jlmParts(t: Date): { y: number; m: number; d: number; hh: number; mm: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, dow };
}

function civilDate(y: number, m: number, d: number): Date { return new Date(y, m - 1, d, 12); }

/** האם היום האזרחי הזה הוא שבת או יום טוב (ולפי ההגדרה גם חול המועד). */
export function isRestDay(y: number, m: number, d: number, cfg: QuietConfig = DEFAULT_QUIET): { rest: boolean; name: string } {
  const dt = civilDate(y, m, d);
  if (dt.getDay() === 6) return { rest: true, name: 'שבת' };
  const evs = HebrewCalendar.getHolidaysOnDate(new HDate(dt), true) || [];
  for (const e of evs) {
    const f = e.getFlags();
    if (f & flags.CHAG) return { rest: true, name: 'חג' };
    if (cfg.includeCholHamoed && (f & flags.CHOL_HAMOED)) return { rest: true, name: 'חול המועד' };
  }
  return { rest: false, name: '' };
}

function zmanim(y: number, m: number, d: number) {
  const z = new Zmanim(JERUSALEM, civilDate(y, m, d), false);
  return { sunset: z.sunset().getTime(), tzeit: z.tzeit(8.5).getTime() };
}

function addDays(y: number, m: number, d: number, n: number) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function minutesOf(hhmm: string): number { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); }

export interface QuietState { quiet: boolean; reason: '' | 'night' | 'shabbat' | 'chag' | 'cholhamoed'; }

export function quietState(t: Date = new Date(), cfg: QuietConfig = DEFAULT_QUIET): QuietState {
  const p = jlmParts(t);
  const ms = t.getTime();
  const margin = cfg.marginMinutes * 60_000;
  if (cfg.shabbatAndChag) {
    // היום הוא יום מנוחה: שקט עד צאת הכוכבים + מרווח
    const today = isRestDay(p.y, p.m, p.d, cfg);
    if (today.rest && ms < zmanim(p.y, p.m, p.d).tzeit + margin) return { quiet: true, reason: reasonOf(today.name) };
    // מחר יום מנוחה: שקט מהדלקת נרות היום פחות מרווח
    const tm = addDays(p.y, p.m, p.d, 1);
    const tomorrow = isRestDay(tm.y, tm.m, tm.d, cfg);
    if (tomorrow.rest && ms >= zmanim(p.y, p.m, p.d).sunset - cfg.candleMinutes * 60_000 - margin) return { quiet: true, reason: reasonOf(tomorrow.name) };
  }
  const now = p.hh * 60 + p.mm, s = minutesOf(cfg.start), e = minutesOf(cfg.end);
  const night = s <= e ? (now >= s && now < e) : (now >= s || now < e);
  return night ? { quiet: true, reason: 'night' } : { quiet: false, reason: '' };
}

function reasonOf(name: string): QuietState['reason'] {
  return name === 'שבת' ? 'shabbat' : name === 'חג' ? 'chag' : 'cholhamoed';
}
