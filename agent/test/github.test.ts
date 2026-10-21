import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { GitHubRepos, GitHubError } from '../src/github.ts';

const TOKEN = 'ghp_' + 'a'.repeat(36);

function setup(rows: any[] = [], over: { status?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cpg-'));
  const parent = join(dir, 'projects');
  const store = new Store(':memory:');
  const gitCalls: { args: string[]; cwd?: string }[] = [];
  const urls: Record<string, string> = {};
  const f = (async (url: any, init: any) => {
    const u = String(url);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    if (over.status) return new Response('{}', { status: over.status });
    if (u.endsWith('/user')) return Response.json({ login: 'me' });
    if (u.includes('/user/repos')) return Response.json(rows);
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const git = async (args: string[], cwd?: string) => {
    gitCalls.push({ args, cwd });
    if (args[0] === 'clone') { mkdirSync(join(args[args.length - 1], '.git'), { recursive: true }); urls[args[args.length - 1]] = args[args.length - 2]; }
    if (args[0] === 'remote') return urls[cwd!] ?? '';
    return '';
  };
  const gh = new GitHubRepos({ tokenFile: join(dir, 'data', 'github.token'), parent: () => parent, store, fetch: f, git });
  return { gh, store, parent, gitCalls, dir };
}

test('טוקן: נבדק מול GitHub, נשמר בקובץ בלבד, ריק מוחק', async () => {
  const { gh, dir } = setup();
  await assert.rejects(gh.saveToken('קצר'), GitHubError);
  assert.equal(await gh.saveToken(TOKEN), 'me');
  assert.ok(gh.hasToken());
  const file = join(dir, 'data', 'github.token');
  assert.equal(readFileSync(file, 'utf8').trim(), TOKEN);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(await gh.saveToken(''), null);
  assert.ok(!gh.hasToken());
  assert.ok(!existsSync(file));
});

test('טוקן שפג תוקפו נדחה בהודעה ברורה ולא נשמר', async () => {
  const { gh } = setup([], { status: 401 });
  await assert.rejects(gh.saveToken(TOKEN), /לא תקין/);
  assert.ok(!gh.hasToken());
});

test('רשימת מאגרים: ארכיון מוסר, שם מוקרא בלי מקפים', async () => {
  const { gh } = setup([
    { full_name: 'me/my-site', name: 'my-site', private: true },
    { full_name: 'me/old', name: 'old', archived: true },
    { full_name: 'bad name', name: 'x' },
  ]);
  await gh.saveToken(TOKEN);
  assert.deepEqual(await gh.list(), [{ fullName: 'me/my-site', name: 'my-site', spokenName: 'מיי סייט', private: true }]);
});

test('פתיחת מאגר: שכפול ורישום פרויקט, בלי הטוקן בכתובת, ובפעם השנייה pull', async () => {
  const { gh, store, parent, gitCalls } = setup();
  await gh.saveToken(TOKEN);
  const p = await gh.open('me/my-site');
  assert.equal(p.path, join(parent, 'my-site'));
  assert.equal(p.spokenName, 'מיי סייט');
  const clone = gitCalls.find(c => c.args[0] === 'clone')!;
  assert.ok(clone.args.includes('https://github.com/me/my-site.git'));
  assert.ok(!gitCalls.some(c => c.args.join(' ').includes(TOKEN)));
  const cfg = gitCalls.find(c => c.args[0] === 'config')!;
  assert.match(cfg.args.join(' '), /credential\.https:\/\/github\.com\.helper/);
  assert.ok(!cfg.args.join(' ').includes(TOKEN));
  const again = await gh.open('me/my-site');
  assert.equal(again.id, p.id);
  assert.equal(gitCalls.filter(c => c.args[0] === 'clone').length, 1);
  assert.ok(gitCalls.some(c => c.args[0] === 'pull' && c.cwd === p.path));
  assert.equal(store.listMenuProjects().filter(x => x.path === p.path).length, 1);
});

test('תיקייה תפוסה במשהו אחר: משתמשים ב-בעלים-שם', async () => {
  const { gh, parent } = setup();
  await gh.saveToken(TOKEN);
  mkdirSync(join(parent, 'tool'), { recursive: true });
  const p = await gh.open('me/tool');
  assert.equal(p.path, join(parent, 'me-tool'));
});

test('פתיחה בלי טוקן או עם שם לא תקין נכשלת', async () => {
  const { gh } = setup();
  await assert.rejects(gh.open('me/x'), /לא מחובר/);
  await assert.rejects(gh.open('../evil'), /לא תקין/);
});
