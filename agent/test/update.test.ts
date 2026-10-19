import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Updater, compareVersions, installedVersion } from '../src/update/updater.ts';
import { ProjectsLocation, encodeCwd, defaultProjectsParent } from '../src/projects-location.ts';
import { Store } from '../src/store/db.ts';
import { ClaudeHistory } from '../src/history/claude-history.ts';
import { ConversationIndex } from '../src/history/conversations.ts';

// ---------- עדכון ----------

function fakeGitHub(opts: { version: string; body: Buffer; digest?: 'good' | 'bad' | 'none'; status?: number; sideSha?: boolean }) {
  const sha = createHash('sha256').update(opts.body).digest('hex');
  const name = `ClaudePhone-Setup-${opts.version}.exe`;
  const calls: string[] = [];
  const f = (async (url: any) => {
    const u = String(url); calls.push(u);
    if (u.endsWith('/releases/latest')) {
      if (opts.status) return new Response('{}', { status: opts.status });
      const assets: any[] = [{ name, size: opts.body.length, browser_download_url: 'https://dl/' + name,
        ...(opts.digest === 'none' ? {} : { digest: 'sha256:' + (opts.digest === 'bad' ? '0'.repeat(64) : sha) }) }];
      if (opts.sideSha) assets.push({ name: name + '.sha256', size: 80, browser_download_url: 'https://dl/' + name + '.sha256' });
      return Response.json({ tag_name: 'v' + opts.version, body: 'מה חדש', html_url: 'https://github.com/x/y/releases/tag/v' + opts.version, published_at: '2026-10-14T10:00:00Z', assets });
    }
    if (u === 'https://dl/' + name + '.sha256') return new Response(`${sha}  ${name}\n`);
    if (u === 'https://dl/' + name) return new Response(opts.body, { headers: { 'content-length': String(opts.body.length) } });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls, sha, name };
}

test('השוואת גרסאות וקריאת הגרסה המותקנת', () => {
  assert.ok(compareVersions('0.6.10', '0.6.9') > 0);
  assert.ok(compareVersions('v1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.6.1', '0.6.1'), 0);
  assert.ok(compareVersions('0.6.1', '0.7.0') < 0);
  const d = mkdtempSync(join(tmpdir(), 'cpv-'));
  assert.equal(installedVersion(d), null);
  writeFileSync(join(d, 'version.txt'), '\uFEFF0.6.2\r\n');
  assert.equal(installedVersion(d), '0.6.2');
});

test('עדכון: מזהה גרסה חדשה, מוריד, מאמת ומריץ את ההתקנה', async () => {
  const body = Buffer.from('installer-bytes-'.repeat(5000));
  const gh = fakeGitHub({ version: '0.7.0', body });
  const launched: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'cpu-'));
  const u = new Updater({ platform: 'win32', repo: 'a/b', current: '0.6.2', fetch: gh.f, downloadDir: dir, launch: (exe) => launched.push(exe) });
  const s = await u.check();
  assert.equal(s.available, true); assert.equal(s.latest, '0.7.0'); assert.equal(s.error, null); assert.equal(s.notes, 'מה חדש');
  await u.install();
  assert.equal(u.state.phase, 'installing'); assert.equal(u.state.progress, 1);
  assert.equal(launched.length, 1);
  assert.equal(basename(launched[0]), gh.name);
  assert.deepEqual(readFileSync(launched[0]), body);
  assert.ok(!readdirSync(dir).some(f => f.endsWith('.part')));
});

test('עדכון: אין גרסה חדשה, מאגר פרטי, וחתימה שלא תואמת', async () => {
  const body = Buffer.from('x'.repeat(1000));
  const same = new Updater({ platform: 'win32', repo: 'a/b', current: '0.7.0', fetch: fakeGitHub({ version: '0.7.0', body }).f });
  assert.equal((await same.check()).available, false);
  await assert.rejects(same.install(), /אין גרסה חדשה/);

  const priv = new Updater({ platform: 'win32', repo: 'a/b', current: '0.6.0', fetch: fakeGitHub({ version: '0.7.0', body, status: 404 }).f });
  assert.match((await priv.check()).error ?? '', /פרטי/);

  const launched: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'cpu-'));
  const bad = new Updater({ platform: 'win32', repo: 'a/b', current: '0.6.0', fetch: fakeGitHub({ version: '0.7.0', body, digest: 'bad' }).f, downloadDir: dir, launch: (e) => launched.push(e) });
  await assert.rejects(bad.install(), /לא תואם/);
  assert.equal(bad.state.phase, 'failed'); assert.equal(launched.length, 0);
  assert.equal(readdirSync(dir).length, 0);

  // בלי digest מ-GitHub: משתמשים בקובץ .sha256 שלצד ההתקנה
  const side = fakeGitHub({ version: '0.7.0', body, digest: 'none', sideSha: true });
  const u2 = new Updater({ platform: 'win32', repo: 'a/b', current: '0.6.0', fetch: side.f, downloadDir: mkdtempSync(join(tmpdir(), 'cpu-')), launch: (e) => launched.push(e) });
  await u2.install();
  assert.equal(launched.length, 1);
});

test('עדכון: כבוי בגרסת פיתוח, ושם מאגר לא תקין נדחה', async () => {
  const u = new Updater({ platform: 'win32', repo: 'a/b', current: null, fetch: (async () => { throw new Error('לא אמור לפנות'); }) as any });
  assert.equal(u.state.enabled, false);
  assert.equal((await u.check()).checkedAt, null);
  await assert.rejects(u.install(), /פיתוח/);
  assert.throws(() => u.setRepo('not a repo'), /owner\/repo/);
});

// ---------- תיקיית הפרויקטים ----------

function locFixture() {
  const home = mkdtempSync(join(tmpdir(), 'cph-home-'));
  const root = mkdtempSync(join(tmpdir(), 'cph-cfg-'));
  const claudeHome = join(home, '.claude', 'projects');
  const oldParent = join(home, 'Desktop', 'ClaudeProjects');
  mkdirSync(join(oldParent, 'אתר', 'src'), { recursive: true });
  writeFileSync(join(oldParent, 'אתר', 'src', 'index.html'), '<h1>שלום</h1>');
  mkdirSync(join(oldParent, 'רץ'), { recursive: true });
  const store = new Store(':memory:');
  const site = store.addProject({ name: 'אתר', path: join(oldParent, 'אתר') });
  const busyP = store.addProject({ name: 'רץ', path: join(oldParent, 'רץ') });
  const outside = store.addProject({ name: 'חיצוני', path: join(home, 'elsewhere') });
  mkdirSync(outside.path, { recursive: true });
  // תמליל של שיחה בפרויקט "אתר", בתיקייה המקודדת של Claude Code
  const encDir = join(claudeHome, encodeCwd(site.path));
  mkdirSync(join(encDir, 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(join(encDir, 'sess-1.jsonl'), JSON.stringify({ type: 'user', cwd: site.path, entrypoint: 'cli', timestamp: '2026-10-11T10:00:00Z', message: { content: 'תסדר את הכותרת' } }) + '\n');
  const hourAgo = new Date(Date.now() - 3600_000); utimesSync(join(encDir, 'sess-1.jsonl'), hourAgo, hourAgo);   // לא "פתוחה כרגע"
  const cfg: any = { projects: { newProjectsParent: oldParent, initGit: false, list: [{ name: 'אתר', path: site.path }] } };
  const loc = new ProjectsLocation({ cfg, store, root, claudeHome, home, busy: (id) => id === busyP.id ? 'יש משימה פעילה בפרויקט' : null });
  return { home, root, claudeHome, oldParent, store, site, busyP, outside, cfg, loc };
}

test('תיקיית פרויקטים: הצעות, ושינוי מיקום בלי העברה', () => {
  const f = locFixture();
  const info = f.loc.info();
  assert.equal(info.parent, f.oldParent);
  assert.deepEqual(info.inside.map(p => p.name).sort(), ['אתר', 'רץ']);
  assert.ok(info.suggestions.some(s => s.current));
  assert.equal(defaultProjectsParent(f.home), join(f.home, 'Desktop', 'ClaudeProjects'));
  mkdirSync(join(f.home, 'Documents', 'Claude', 'Projects', 'קיים'), { recursive: true });
  assert.equal(defaultProjectsParent(f.home), join(f.home, 'Documents', 'Claude', 'Projects'));
  assert.match(f.loc.info().suggestions[0].label, /Claude/);

  const target = join(f.home, 'Documents', 'Claude', 'Projects');
  const r = f.loc.change(target, false);
  assert.equal(r.moved.length, 0);
  assert.equal(r.added, 1);                      // התיקייה "קיים" נרשמה כפרויקט
  assert.equal(f.cfg.projects.newProjectsParent, target);
  assert.ok(existsSync(f.site.path));           // לא הועבר
  const saved = JSON.parse(readFileSync(join(f.root, 'config.json'), 'utf8'));
  assert.equal(saved.projects.newProjectsParent, target);
  assert.throws(() => f.loc.change('relative\\path', false), /נתיב מלא/);
});

test('תיקיית פרויקטים: העברה עם התמלילים, דילוג על פרויקט עסוק, ושיחות ישנות נשארות משויכות', () => {
  const f = locFixture();
  const target = join(f.home, 'Documents', 'Claude', 'Projects');
  const r = f.loc.change(target, true);
  assert.deepEqual(r.moved.map(m => m.name), ['אתר']);
  assert.equal(r.moved[0].transcripts, 1);
  assert.deepEqual(r.skipped, [{ name: 'רץ', reason: 'יש משימה פעילה בפרויקט' }]);
  const newPath = join(target, 'אתר');
  assert.ok(existsSync(join(newPath, 'src', 'index.html')));
  assert.ok(!existsSync(f.site.path));
  // הפרויקט החיצוני לא זז
  assert.equal(f.store.getProject(f.outside.id)!.path, f.outside.path);
  // הנתיב החדש והקודם נשמרים
  const moved = f.store.getProject(f.site.id)!;
  assert.equal(moved.path, newPath);
  assert.deepEqual(moved.formerPaths, [f.site.path]);
  assert.equal(f.cfg.projects.list[0].path, newPath);
  // התמליל עבר לתיקייה המקודדת של הנתיב החדש, עם תיקיית הלוואי
  const newEnc = join(f.claudeHome, encodeCwd(newPath));
  assert.ok(existsSync(join(newEnc, 'sess-1.jsonl')));
  assert.ok(existsSync(join(newEnc, 'sess-1', 'subagents')));
  // ההיסטוריה עדיין משייכת את השיחה לפרויקט (התמליל עדיין רשום עם הנתיב הישן)
  const idx = new ConversationIndex(f.store, new ClaudeHistory(f.claudeHome), { resumeSources: ['cli'], activeMinutes: 3 });
  const conv = idx.get('sess-1')!;
  assert.equal(conv.projectId, f.site.id);
  assert.equal(conv.canContinue, true);
});

test('תיקיית פרויקטים: לא בתוך פרויקט שעובר, ולא כונן שלם', () => {
  const f = locFixture();
  assert.throws(() => f.loc.change(join(f.site.path, 'פנימי'), true), /בתוך הפרויקט/);
  if (process.platform === 'win32') assert.throws(() => f.loc.change('D:\\', false), /כונן/);
});
