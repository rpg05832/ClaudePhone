// הגדרת קוד PIN: נקלט מהמקלדת (לא מוצג), נשמר כגיבוב ב-data/pin.hash. הקוד עצמו לא נשמר בשום מקום.
import { scryptSync, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pin = (process.env.CP_NEW_PIN || '').trim();
if (!/^\d{4,8}$/.test(pin)) { console.error('הקוד חייב להיות 4 עד 8 ספרות'); process.exit(1); }
const salt = randomBytes(16);
const hash = scryptSync(pin, salt, 32);
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'pin.hash'), `scrypt$${salt.toString('hex')}$${hash.toString('hex')}\n`, 'utf8');
console.log('הקוד נשמר (כגיבוב בלבד).');
