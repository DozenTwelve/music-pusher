// A stand-in for beets, shared by the tests that drive the real import.
//
// `config` names a library dir and db. `import -q DIR` acts on `mode`:
//   (none)  move every track and record it, exit 0
//   hang    never finish (until killed)
//   partial move and record the first track only, exit 0
//   die     record every track, move the first, then exit 1 — a beet killed
//           mid-move: beets adds the rows before it moves the files
//   stall   as die, but hang instead of exiting
//   prune   move and record every track, remove the emptied folder, exit 1
//   stubborn hang, with a child that ignores SIGTERM and holds no pipes
// `remove -f id:1 , id:2` drops those rows (slowly, given `slowremove`). `slowdb` leaves the db locked for a
// second after an import.
export const FAKE_BEET = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const H = __dirname, DB = path.join(H, 'db.sqlite'), LIB = path.join(H, 'lib');
const args = process.argv.slice(2);
function db() {
  const d = new DatabaseSync(DB);
  d.exec(\`create table if not exists albums (id integer primary key, album text, albumartist text,
             year integer, genre text, artpath blob);
           create table if not exists items (id integer primary key, album_id integer, path blob,
             title text, artist text, track integer, format text, samplerate integer,
             bitdepth integer, mb_albumid text)\`);
  return d;
}
const command = args.find((a) => !a.startsWith('-') && !a.endsWith('.yaml'));
if (command === 'config') {
  db().close(); console.log('directory: ' + LIB + '\\nlibrary: ' + DB); process.exit(0);
}
if (command === 'remove') {
  if (fs.existsSync(path.join(H, 'slowremove'))) { const end = Date.now() + 1000; while (Date.now() < end); }
  const d = db();
  for (const a of args) { const m = /^id:(\\d+)$/.exec(a); if (m) d.prepare('delete from items where id = ?').run(Number(m[1])); }
  process.exit(0);
}
if (command !== 'import') process.exit(0);
const mode = fs.existsSync(path.join(H, 'mode')) ? fs.readFileSync(path.join(H, 'mode'), 'utf8').trim() : '';
fs.writeFileSync(path.join(H, 'pid'), String(process.pid));
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
if (mode === 'stubborn') {
  const child = require('child_process').spawn('sh', ['-c', 'trap "" TERM; exec sleep 30'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(H, 'stubborn'), String(child.pid));
  setInterval(() => {}, 1000);
  return;
}
const dir = args[args.length - 1];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.flac')).sort();
const d = db();
const dest = path.join(LIB, path.basename(dir));
fs.mkdirSync(dest, { recursive: true });
const a = d.prepare('insert into albums (album, albumartist) values (?, ?)').run('X', 'Y').lastInsertRowid;
const take = mode === 'partial' ? files.slice(0, 1) : files;
for (const f of take) {
  const row = d.prepare('insert into items (album_id, path, title, mb_albumid) values (?, ?, ?, ?)')
    .run(a, Buffer.from(path.join(dir, f)), f, 'x').lastInsertRowid;
  if ((mode === 'die' || mode === 'stall') && f !== files[0]) continue;
  fs.renameSync(path.join(dir, f), path.join(dest, f));
  d.prepare('update items set path = ? where id = ?').run(Buffer.from(path.join(dest, f)), row);
}
d.close();
if (mode === 'prune') { fs.rmdirSync(dir); process.exit(1); }
if (fs.existsSync(path.join(H, 'slowdb'))) {
  // Leave behind a writer holding the db for a second, so whatever reads it
  // next (the verification) is slow.
  const locked = path.join(H, 'locked');
  require('child_process').spawn(process.execPath, ['-e', \`
    const d = new (require('node:sqlite').DatabaseSync)(\${JSON.stringify(DB)});
    d.exec('begin exclusive');
    require('fs').writeFileSync(\${JSON.stringify(locked)}, '');
    setTimeout(() => d.exec('rollback'), 1000);
  \`], { stdio: 'ignore' }).unref();
  while (!fs.existsSync(locked)) { const end = Date.now() + 10; while (Date.now() < end); }
  fs.rmSync(locked);
}
if (mode === 'stall') { setInterval(() => {}, 1000); return; }
process.exit(mode === 'die' ? 1 : 0);
`;
