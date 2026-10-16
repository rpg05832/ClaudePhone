// בונה את קבצי ההתקנה ללינוקס: ClaudePhone-linux-<x64|arm64>-<גרסה>.tar.gz (+ .sha256), ו-install.sh לפרסום ב-Release.
// רץ גם ב-Windows וגם בלינוקס (Node בלבד, בלי tar/xz חיצוניים), כך שאפשר לבנות את שתי הגרסאות מאותו מחשב.
//
//   node installer/build-linux.mjs --version 0.8.0            שתי הארכיטקטורות
//   node installer/build-linux.mjs --version 0.8.0 --arch x64
//
// מה נכנס לחבילה (מבנה זהה ל-Windows, בתיקייה claudephone/):
//   runtime/node                Node.js ללינוקס (אותה גרסה כמו ה-Node שמריץ את הבנייה)
//   agent/dist/agent.mjs        הסוכן ארוז לקובץ אחד (esbuild), ו-schema.sql
//   agent/node_modules          Agent SDK עם Claude Code ללינוקס
//   agent/bin/cloudflared       רכיב המנהרה
//   agent/web, channel, stt     לוח הבקרה, ערוץ הסשן החי, סקריפט התמלול
//   install.sh launcher.sh stop.sh uninstall.sh icon.png version.txt
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const VERSION = opt('--version');
const ARCHES = (opt('--arch', 'all') === 'all' ? ['x64', 'arm64'] : [opt('--arch')]);
if (!/^\d+\.\d+\.\d+$/.test(VERSION ?? '')) { console.error('צריך --version X.Y.Z'); process.exit(2); }
for (const a of ARCHES) if (!['x64', 'arm64'].includes(a)) { console.error(`ארכיטקטורה לא נתמכת: ${a}`); process.exit(2); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INST = join(ROOT, 'installer');
const OUT = join(INST, 'output');
const WORK = join(INST, 'build-linux');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const step = (t) => console.log(`== ${t}`);
// ב-Windows npm.cmd דורש מעטפת; כל הארגומנטים של npm כאן בלי רווחים, ולכן זה בטוח
const sh = (cmd, a, cwd = ROOT) => execFileSync(cmd, a, { cwd, stdio: 'inherit', shell: isWin });

async function download(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`ההורדה נכשלה (${r.status}): ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- tar (ustar + pax לשמות ארוכים), בלי תלות בכלים חיצוניים ----------
function tarHeader(name, size, mode, type = '0', linkname = '') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  if (linkname) h.write(linkname.slice(0, 100), 157, 'utf8');
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
function paxRecord(k, v) {
  const body = ` ${k}=${v}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}
function tarEntry(name, data, mode, type = '0', linkname = '') {
  const parts = [];
  const long = Buffer.byteLength(name) > 100 || Buffer.byteLength(linkname) > 100 || /[^\x20-\x7e]/.test(name + linkname);
  if (long) {
    const pax = Buffer.from(paxRecord('path', name) + (linkname ? paxRecord('linkpath', linkname) : ''), 'utf8');
    parts.push(tarHeader('PaxHeader', pax.length, 0o644, 'x'), pax, pad(pax.length));
  }
  parts.push(tarHeader(name.replace(/[^\x20-\x7e]/g, '_'), data.length, mode, type, linkname.replace(/[^\x20-\x7e]/g, '_')), data, pad(data.length));
  return parts;
}
/** קובצי הרצה: לפי שם ולפי חתימת ELF/#!. */
function isExec(rel, buf) {
  if (/\.sh$/.test(rel) || /(^|\/)(node|claude|cloudflared)$/.test(rel)) return true;
  return buf.length > 4 && (buf.readUInt32BE(0) === 0x7f454c46 || (buf[0] === 0x23 && buf[1] === 0x21));
}
function tarDir(srcRoot, prefix) {
  const parts = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      const rel = prefix + '/' + relative(srcRoot, p).split(sep).join('/');
      const st = lstatSync(p);
      if (st.isSymbolicLink()) { parts.push(...tarEntry(rel, Buffer.alloc(0), 0o777, '2', readlinkSync(p))); continue; }
      if (st.isDirectory()) { parts.push(...tarEntry(rel + '/', Buffer.alloc(0), 0o755, '5')); walk(p); continue; }
      const buf = readFileSync(p);
      parts.push(...tarEntry(rel, buf, isExec(rel, buf) ? 0o755 : 0o644));
    }
  };
  parts.push(...tarEntry(prefix + '/', Buffer.alloc(0), 0o755, '5'));
  walk(srcRoot);
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
/** חילוץ קובץ אחד מתוך tar.gz (בשביל bin/node מתוך החבילה של Node). */
function extractFromTgz(tgz, wanted) {
  const t = gunzipSync(tgz);
  let off = 0, paxPath = null;
  while (off + 512 <= t.length) {
    const h = t.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const name = paxPath ?? (h.toString('utf8', 345, 500).replace(/\0.*$/s, '') ? h.toString('utf8', 345, 500).replace(/\0.*$/s, '') + '/' : '') + h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const size = parseInt(h.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    const data = t.subarray(off + 512, off + 512 + size);
    paxPath = null;
    if (type === 'x') { const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; }
    else if (wanted(name)) return Buffer.from(data);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('הקובץ לא נמצא בחבילה');
}

// ---------- בנייה ----------
step('אריזת הסוכן (esbuild)');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'common', 'dist'), { recursive: true });
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(ROOT, 'node_modules', 'esbuild'))) sh(npm, ['install', '--no-save', '--no-audit', '--no-fund', 'esbuild@0.24.2']);
const banner = "import { createRequire as __cpRequire } from 'node:module'; const require = __cpRequire(import.meta.url);";
// דרך ה-API של esbuild (ולא שורת פקודה), כדי שהבאנר עם הרווחים יעבור נכון גם ב-Windows
const esbuild = createRequire(join(ROOT, 'package.json'))('esbuild');
await esbuild.build({
  entryPoints: [join(ROOT, 'agent', 'src', 'main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: join(WORK, 'common', 'dist', 'agent.mjs'), external: ['@anthropic-ai/claude-agent-sdk'], banner: { js: banner }, logLevel: 'warning',
});
execFileSync(process.execPath, ['--check', join(WORK, 'common', 'dist', 'agent.mjs')], { stdio: 'inherit' });

const sdkVer = JSON.parse(readFileSync(join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
const nodeVer = process.version;

for (const arch of ARCHES) {
  const app = join(WORK, arch, 'claudephone');
  const agent = join(app, 'agent');
  step(`לינוקס ${arch}: קבצי הסוכן`);
  mkdirSync(join(agent, 'dist'), { recursive: true });
  cpSync(join(WORK, 'common', 'dist', 'agent.mjs'), join(agent, 'dist', 'agent.mjs'));
  cpSync(join(ROOT, 'agent', 'src', 'store', 'schema.sql'), join(agent, 'dist', 'schema.sql'));
  cpSync(join(ROOT, 'agent', 'config.example.json'), join(agent, 'config.example.json'));
  cpSync(join(ROOT, 'agent', 'web'), join(agent, 'web'), { recursive: true });
  cpSync(join(ROOT, 'agent', 'channel'), join(agent, 'channel'), { recursive: true });
  mkdirSync(join(agent, 'stt'), { recursive: true });
  cpSync(join(ROOT, 'agent', 'stt', 'transcribe.py'), join(agent, 'stt', 'transcribe.py'));

  step(`לינוקס ${arch}: Agent SDK (כולל Claude Code ללינוקס)`);
  writeFileSync(join(agent, 'package.json'), JSON.stringify({ name: 'claude-phone-agent', version: VERSION, private: true, type: 'module', dependencies: { '@anthropic-ai/claude-agent-sdk': sdkVer } }, null, 2));
  sh(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--os=linux', `--cpu=${arch}`, '--libc=glibc'], agent);
  const sdkBin = join(agent, 'node_modules', '@anthropic-ai', `claude-agent-sdk-linux-${arch}`, 'claude');
  if (!existsSync(sdkBin)) throw new Error(`Claude Code ללינוקס ${arch} לא הותקן עם ה-SDK`);
  // רק הקובץ של המערכת הזו (בלי musl/Windows/Mac אם npm הוריד אותם)
  for (const d of readdirSync(join(agent, 'node_modules', '@anthropic-ai'))) {
    if (/^claude-agent-sdk-/.test(d) && d !== `claude-agent-sdk-linux-${arch}`) rmSync(join(agent, 'node_modules', '@anthropic-ai', d), { recursive: true, force: true });
  }

  step(`לינוקס ${arch}: Node.js ${nodeVer}`);
  const nodeTgz = await download(`https://nodejs.org/dist/${nodeVer}/node-${nodeVer}-linux-${arch}.tar.gz`);
  mkdirSync(join(app, 'runtime'), { recursive: true });
  writeFileSync(join(app, 'runtime', 'node'), extractFromTgz(nodeTgz, n => /^node-v[\d.]+-linux-\w+\/bin\/node$/.test(n)));

  step(`לינוקס ${arch}: cloudflared`);
  mkdirSync(join(agent, 'bin'), { recursive: true });
  writeFileSync(join(agent, 'bin', 'cloudflared'), await download(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch === 'x64' ? 'amd64' : 'arm64'}`));

  step(`לינוקס ${arch}: מפעיל וסקריפטים`);
  for (const f of ['install.sh', 'launcher.sh', 'stop.sh', 'uninstall.sh', 'icon.png']) cpSync(join(INST, 'linux', f), join(app, f));
  writeFileSync(join(app, 'version.txt'), VERSION + '\n');

  step(`לינוקס ${arch}: אריזה`);
  const tgz = gzipSync(tarDir(app, 'claudephone'), { level: 9 });
  const name = `ClaudePhone-linux-${arch}-${VERSION}.tar.gz`;
  writeFileSync(join(OUT, name), tgz);
  const hash = createHash('sha256').update(tgz).digest('hex');
  writeFileSync(join(OUT, name + '.sha256'), `${hash}  ${name}\n`);
  console.log(`נוצר: ${join(OUT, name)} (${(tgz.length / 1048576).toFixed(0)} MB)\nSHA256: ${hash}`);
}
cpSync(join(INST, 'linux', 'install.sh'), join(OUT, 'install.sh'));
console.log(`נוצר: ${join(OUT, 'install.sh')} (לפרסום ב-Release, להתקנה בפקודה אחת)`);
