// גרסת לינוקס (16.10.2026): שכבת המערכת, בדיקת המחשב, בחירת קובץ העדכון, Python נייד.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  sdkBinaryPackage, cloudflaredFileName, cloudflaredUrl, hasGui, serviceUnit, desktopEntry, writeClaudeScript, which, findTerminal, shq,
} from '../src/platform.ts';
import { osCheck } from '../src/setup/checks.ts';
import { pickStandaloneAsset } from '../src/setup/jobs.ts';
import { Updater, assetPattern } from '../src/update/updater.ts';
import { execFileSync } from 'node:child_process';

test('לינוקס: חבילת Claude Code וקובץ המנהרה לפי מערכת ומעבד', () => {
  assert.deepEqual(sdkBinaryPackage('linux', 'x64', false), { pkg: '@anthropic-ai/claude-agent-sdk-linux-x64', file: 'claude' });
  assert.deepEqual(sdkBinaryPackage('linux', 'arm64', false), { pkg: '@anthropic-ai/claude-agent-sdk-linux-arm64', file: 'claude' });
  assert.deepEqual(sdkBinaryPackage('linux', 'x64', true).pkg, '@anthropic-ai/claude-agent-sdk-linux-x64-musl');
  assert.deepEqual(sdkBinaryPackage('win32', 'x64', false), { pkg: '@anthropic-ai/claude-agent-sdk-win32-x64', file: 'claude.exe' });
  assert.equal(cloudflaredFileName('linux'), 'cloudflared');
  assert.equal(cloudflaredFileName('win32'), 'cloudflared.exe');
  assert.match(cloudflaredUrl('linux', 'x64'), /cloudflared-linux-amd64$/);
  assert.match(cloudflaredUrl('linux', 'arm64'), /cloudflared-linux-arm64$/);
  assert.match(cloudflaredUrl('win32', 'x64'), /cloudflared-windows-amd64\.exe$/);
});

test('לינוקס: זיהוי מסך (שרת בלי מסך מול שולחן עבודה)', { skip: process.platform !== 'linux' }, () => {
  assert.equal(hasGui({}), false);
  assert.equal(hasGui({ DISPLAY: ':0' }), true);
  assert.equal(hasGui({ WAYLAND_DISPLAY: 'wayland-0' }), true);
});

test('בדיקת המחשב: Windows, לינוקס x64/arm64, ומה לא נתמך', () => {
  assert.equal(osCheck('win32', '10.0.26100', 'x64').state, 'ok');
  assert.equal(osCheck('win32', '10.0.17000', 'x64').state, 'old');
  assert.equal(osCheck('linux', '6.8.0', 'x64', false).state, 'ok');
  assert.equal(osCheck('linux', '6.8.0', 'arm64', false).state, 'ok');
  assert.equal(osCheck('linux', '6.8.0', 'ia32', false).state, 'error');
  assert.equal(osCheck('linux', '6.8.0', 'x64', true).state, 'error');        // Alpine
  assert.equal(osCheck('darwin', '24.0.0', 'arm64').state, 'error');
  assert.equal(osCheck('linux', '6.8.0', 'x64', false).id, 'os');
});

test('שירות systemd: נתיבים מלאים, הפעלה מחדש אוטומטית, וסימון שירות', () => {
  const u = serviceUnit('/home/u/.local/share/claudephone');
  // --use-system-ca: אישורי האבטחה של המערכת (נדרש מאחורי סינון כמו נטפרי), כמו ב-launcher.vbs של Windows
  assert.match(u, /^ExecStart="\/home\/u\/\.local\/share\/claudephone\/runtime\/node" --no-warnings --use-system-ca "\/home\/u\/\.local\/share\/claudephone\/agent\/dist\/agent\.mjs" --no-open$/m);
  assert.match(u, /^WorkingDirectory=\/home\/u\/\.local\/share\/claudephone\/agent$/m);
  assert.match(u, /^Restart=always$/m);
  assert.match(u, /^Environment=CLAUDEPHONE_SERVICE=1$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
  const d = desktopEntry('/opt/cp', '/opt/cp/launcher.sh', '--open');
  assert.match(d, /^Exec="\/opt\/cp\/launcher\.sh" --open$/m);
  assert.match(d, /^Icon=\/opt\/cp\/icon\.png$/m);
});

test('סקריפט Claude לטרמינל: ציטוט נכון של נתיבים עם רווחים, עברית וגרש', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  // "Claude" מזויף שמדפיס את הארגומנטים שקיבל
  const fake = join(dir, "קלוד עם רווח ו'גרש");
  writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n'); chmodSync(fake, 0o755);
  const p = writeClaudeScript(join(dir, 'claude-resume'), fake, ['--resume'], true);
  assert.ok(p.endsWith('.sh'));
  assert.ok(statSync(p).mode & 0o100, 'הסקריפט צריך להיות בר-הרצה');
  // מריצים בלי המעטפת שבסוף (SHELL=true יוצא מיד)
  const out = execFileSync('/bin/sh', [p, 'abc-123'], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/true' } });
  assert.equal(out.trim().split('\n').filter(Boolean).join(' '), '[--resume] [abc-123]');
  const live = writeClaudeScript(join(dir, 'claude-live'), fake, ['--mcp-config', '/x y/live-mcp.json', 'server:claudephone'], true);
  const out2 = execFileSync('/bin/sh', [live], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/true' } });
  assert.equal(out2.trim().split('\n').filter(Boolean).join(' '), '[--mcp-config] [/x y/live-mcp.json] [server:claudephone]');
  assert.equal(shq("a'b"), `'a'\\''b'`);
});

test('טרמינל: נמצא לפי PATH, ואם אין אף אחד מחזיר null', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpt-'));
  assert.equal(findTerminal({ PATH: dir }), null);
  writeFileSync(join(dir, 'konsole'), ''); chmodSync(join(dir, 'konsole'), 0o755);
  const t = findTerminal({ PATH: dir })!;
  assert.equal(t.bin, 'konsole');
  assert.deepEqual(t.args('/s.sh', ['x']), ['-e', '/s.sh', 'x']);
  writeFileSync(join(dir, 'gnome-terminal'), '');
  assert.equal(findTerminal({ PATH: dir })!.bin, 'gnome-terminal');
  assert.deepEqual(findTerminal({ PATH: dir })!.args('/s.sh', []), ['--', '/s.sh']);
  assert.equal(which('konsole', { PATH: dir }), join(dir, 'konsole'));
});

test('Python נייד: בחירת הקובץ הנכון מתוך ה-Release (3.12, glibc, install_only, עדיף stripped)', () => {
  const a = (name: string) => ({ name, browser_download_url: 'https://dl/' + name });
  const assets = [
    a('cpython-3.13.1+20260101-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'),
    a('cpython-3.12.12+20260101-x86_64-unknown-linux-musl-install_only_stripped.tar.gz'),
    a('cpython-3.12.12+20260101-x86_64-unknown-linux-gnu-install_only.tar.gz'),
    a('cpython-3.12.12+20260101-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'),
    a('cpython-3.12.12+20260101-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst'),
    a('cpython-3.12.12+20260101-aarch64-unknown-linux-gnu-install_only.tar.gz'),
  ];
  assert.equal(pickStandaloneAsset(assets, 'x86_64')?.name, 'cpython-3.12.12+20260101-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz');
  assert.equal(pickStandaloneAsset(assets, 'aarch64')?.name, 'cpython-3.12.12+20260101-aarch64-unknown-linux-gnu-install_only.tar.gz');
  assert.equal(pickStandaloneAsset([], 'x86_64'), null);
});

test('עדכון: כל מערכת בוחרת את הקובץ שלה מתוך אותו Release', async () => {
  assert.match('ClaudePhone-linux-x64-0.8.0.tar.gz', assetPattern('linux', 'x64'));
  assert.doesNotMatch('ClaudePhone-linux-arm64-0.8.0.tar.gz', assetPattern('linux', 'x64'));
  assert.match('ClaudePhone-linux-arm64-0.8.0.tar.gz', assetPattern('linux', 'arm64'));
  assert.match('ClaudePhone-Setup-0.8.0.exe', assetPattern('win32', 'x64'));

  const files: Record<string, Buffer> = {
    'ClaudePhone-Setup-0.8.0.exe': Buffer.from('win'.repeat(1000)),
    'ClaudePhone-linux-x64-0.8.0.tar.gz': Buffer.from('lx64'.repeat(1000)),
    'ClaudePhone-linux-arm64-0.8.0.tar.gz': Buffer.from('larm'.repeat(1000)),
  };
  const f = (async (url: string) => {
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v0.8.0', body: 'חדש', assets: Object.entries(files).map(([name, b]) => ({ name, size: b.length, browser_download_url: 'https://dl/' + name, digest: 'sha256:' + createHash('sha256').update(b).digest('hex') })) });
    const n = url.replace('https://dl/', '');
    return files[n] ? new Response(files[n]) : new Response('', { status: 404 });
  }) as typeof fetch;
  for (const [platform, arch, want] of [['linux', 'x64', 'ClaudePhone-linux-x64-0.8.0.tar.gz'], ['linux', 'arm64', 'ClaudePhone-linux-arm64-0.8.0.tar.gz'], ['win32', 'x64', 'ClaudePhone-Setup-0.8.0.exe']] as const) {
    const launched: string[] = [];
    const u = new Updater({ platform, arch, repo: 'a/b', current: '0.7.2', fetch: f, downloadDir: mkdtempSync(join(tmpdir(), 'cpl-')), launch: (e) => launched.push(e) });
    const s = await u.check();
    assert.equal(s.available, true, `${platform}-${arch}`);
    await u.install();
    assert.ok(launched[0].endsWith(want), `${platform}-${arch}: ${launched[0]}`);
    assert.deepEqual(readFileSync(launched[0]), files[want]);
  }
  // Release עם קובץ Windows בלבד: בלינוקס אין עדכון זמין
  const onlyWin = (async (url: string) => url.endsWith('/latest')
    ? Response.json({ tag_name: 'v0.9.0', assets: [{ name: 'ClaudePhone-Setup-0.9.0.exe', size: 3, browser_download_url: 'https://dl/x' }] })
    : new Response('abc')) as typeof fetch;
  const u = new Updater({ platform: 'linux', arch: 'x64', repo: 'a/b', current: '0.7.2', fetch: onlyWin });
  assert.equal((await u.check()).available, false);
});

test('install.sh: תחביר תקין ו-help', { skip: process.platform === 'win32' }, () => {
  const script = join(import.meta.dirname, '..', '..', 'installer', 'linux', 'install.sh');
  execFileSync('bash', ['-n', script]);
  const out = execFileSync('bash', [script, '--help'], { encoding: 'utf8' });
  assert.match(out, /--from-file/);
  for (const f of ['launcher.sh', 'stop.sh', 'uninstall.sh']) execFileSync('bash', ['-n', join(import.meta.dirname, '..', '..', 'installer', 'linux', f)]);
});

test('install.sh: התקנה מקובץ לתיקייה זמנית, ועדכון שלא דורס הגדרות ונתונים', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'cpi-'));
  const stage = join(root, 'stage', 'claudephone');
  // חבילה מזויפת במבנה של החבילה האמיתית
  for (const d of ['runtime', 'agent/dist', 'agent/web']) mkdirSync(join(stage, d), { recursive: true });
  writeFileSync(join(stage, 'runtime', 'node'), '#!/bin/sh\nexit 0\n'); chmodSync(join(stage, 'runtime', 'node'), 0o755);
  writeFileSync(join(stage, 'agent', 'dist', 'agent.mjs'), '// v1');
  writeFileSync(join(stage, 'agent', 'config.example.json'), '{}');
  writeFileSync(join(stage, 'version.txt'), '0.8.0\n');
  const src = join(import.meta.dirname, '..', '..', 'installer', 'linux');
  for (const f of ['install.sh', 'launcher.sh', 'stop.sh', 'uninstall.sh']) { writeFileSync(join(stage, f), readFileSync(join(src, f))); chmodSync(join(stage, f), 0o755); }
  const tgz = join(root, 'ClaudePhone-linux-x64-0.8.0.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', join(root, 'stage'), 'claudephone']);
  const app = join(root, 'app');
  const env = { ...process.env, HOME: join(root, 'home'), CLAUDEPHONE_DIR: app, CLAUDEPHONE_NO_SERVICE: '1', DISPLAY: '' };
  mkdirSync(env.HOME, { recursive: true });
  execFileSync('bash', [join(src, 'install.sh'), '--from-file', tgz, '--quiet'], { env, encoding: 'utf8' });
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), '0.8.0');
  assert.ok(statSync(join(app, 'launcher.sh')).mode & 0o100);
  // הגדרות ונתונים של המשתמש
  mkdirSync(join(app, 'agent', 'data'), { recursive: true });
  writeFileSync(join(app, 'agent', 'data', 'yemot.token'), 'secret');
  writeFileSync(join(app, 'agent', 'config.json'), '{"a":1}');
  // גרסה חדשה
  writeFileSync(join(stage, 'agent', 'dist', 'agent.mjs'), '// v2');
  writeFileSync(join(stage, 'version.txt'), '0.8.1\n');
  const tgz2 = join(root, 'ClaudePhone-linux-x64-0.8.1.tar.gz');
  execFileSync('tar', ['-czf', tgz2, '-C', join(root, 'stage'), 'claudephone']);
  execFileSync('bash', [join(app, 'install.sh'), '--from-file', tgz2, '--quiet'], { env, encoding: 'utf8' });
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), '0.8.1');
  assert.equal(readFileSync(join(app, 'agent', 'dist', 'agent.mjs'), 'utf8'), '// v2');
  assert.equal(readFileSync(join(app, 'agent', 'data', 'yemot.token'), 'utf8'), 'secret');
  assert.equal(readFileSync(join(app, 'agent', 'config.json'), 'utf8'), '{"a":1}');
});
