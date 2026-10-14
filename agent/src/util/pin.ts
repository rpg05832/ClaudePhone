// קוד PIN: נשמר כגיבוב scrypt עם מלח, לעולם לא כטקסט ולא ביומן (אפיון 5).
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.trim().split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export function savePinHash(path: string, pin: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, hashPin(pin) + '\n', 'utf8');
}

export function loadPinHash(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null;
}

/** נעילה זמנית אחרי ניסיונות שגויים, לכל מספר טלפון בנפרד. */
export class PinLockout {
  private attempts = new Map<string, number[]>();
  constructor(private maxAttempts: number, private windowMinutes: number) {}

  isLocked(phone: string, now = Date.now()): boolean {
    return this.recent(phone, now).length >= this.maxAttempts;
  }

  recordFailure(phone: string, now = Date.now()): void {
    const r = this.recent(phone, now); r.push(now); this.attempts.set(phone, r);
  }

  reset(phone: string): void { this.attempts.delete(phone); }

  private recent(phone: string, now: number): number[] {
    const cutoff = now - this.windowMinutes * 60_000;
    return (this.attempts.get(phone) || []).filter(t => t > cutoff);
  }
}
