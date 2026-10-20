import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkStaleClaudeLock, claudeLockPath } from '../src/claude/lock.ts';

test('נתיב הנעילה: ליד תיקיית ההגדרות של Claude Code', () => {
  assert.ok(claudeLockPath({}).endsWith('.claude.lock'));
  assert.equal(claudeLockPath({ CLAUDE_CONFIG_DIR: '/x/cfg' }), '/x/cfg.lock');
});

test('נעילה תקועה: תיקייה עם קובץ בפנים מוזזת הצידה; נעילה רגעית לא נוגעים בה', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cplock-'));
  const lock = join(dir, '.claude.lock');

  // אין נעילה
  assert.equal(checkStaleClaudeLock(lock, { fix: true }).stale, false);

  // נעילה רגעית (ריקה וטרייה): לא תקועה
  mkdirSync(lock);
  const fresh = checkStaleClaudeLock(lock, { fix: true });
  assert.equal(fresh.stale, false);
  assert.ok(existsSync(lock));

  // קובץ בפנים (המקרה שנמצא אצל משתמש: .nomedia): תקועה. בלי fix רק מדווחים
  writeFileSync(join(lock, '.nomedia'), '');
  const report = checkStaleClaudeLock(lock);
  assert.equal(report.stale, true);
  assert.equal(report.movedTo, null);
  assert.match(report.detail, /\.nomedia/);
  assert.ok(existsSync(lock));

  // עם fix: שינוי שם (לא מחיקה), והקובץ נשאר בתוך התיקייה שהוזזה
  const fixed = checkStaleClaudeLock(lock, { fix: true, now: Date.UTC(2026, 9, 20, 7, 30) });
  assert.equal(fixed.stale, true);
  assert.ok(fixed.movedTo && fixed.movedTo.startsWith(lock + '.stale-'));
  assert.ok(!existsSync(lock));
  assert.deepEqual(readdirSync(fixed.movedTo!), ['.nomedia']);
});

test('נעילה תקועה: תיקייה ריקה אבל ישנה מעשר דקות', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cplock-'));
  const lock = join(dir, '.claude.lock');
  mkdirSync(lock);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(lock, old, old);
  const r = checkStaleClaudeLock(lock, { fix: false });
  assert.equal(r.stale, true);
  assert.match(r.detail, /דקות/);
  // בגבול זמן גדול יותר היא עדיין "חיה"
  assert.equal(checkStaleClaudeLock(lock, { maxAgeMs: 2 * 3600_000 }).stale, false);
});
