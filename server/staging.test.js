import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { apiRouter } from './routes.js';

// The real routes and the real import lifecycle, driven against a stand-in for
// beets. Everything here is about what happens to RAW while an import is in
// flight — the window where beets has been handed a folder and the app later
// deletes it — so the stand-in holds that window open until the test lets go.

// A fake `beet`: `config` names a library dir and db; `import -q DIR` snapshots
// the folder's audio files, waits for the release file, then moves exactly
// those into the library and records them, the way `move: yes` does.
const FAKE_BEET = `#!/usr/bin/env node
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
if (args[0] === 'config') { db().close(); console.log('directory: ' + LIB + '\\nlibrary: ' + DB); process.exit(0); }
if (args[0] !== 'import') process.exit(0);
const dir = args[args.length - 1];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.flac'));
fs.writeFileSync(path.join(H, 'scanned'), files.join('\\n'));
const started = Date.now();
const wait = setInterval(() => {
  if (Date.now() - started > 10000) process.exit(1); // never hang the suite
  if (!fs.existsSync(path.join(H, 'release'))) return;
  clearInterval(wait);
  fs.rmSync(path.join(H, 'release'));
  const d = db();
  const dest = path.join(LIB, path.basename(dir));
  fs.mkdirSync(dest, { recursive: true });
  const a = d.prepare('insert into albums (album, albumartist) values (?, ?)').run('X', 'Y').lastInsertRowid;
  for (const f of files) {
    fs.renameSync(path.join(dir, f), path.join(dest, f));
    d.prepare('insert into items (album_id, path, title, mb_albumid) values (?, ?, ?, ?)')
      .run(a, Buffer.from(path.join(dest, f)), f, 'x');
  }
  d.close();
  // beets prunes a source folder its move left empty.
  try { fs.rmdirSync(dir); } catch {}
}, 20);
`;

let root;
let home;
let rawDir;
let server;
let base;
const saved = {};

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staging-'));
  home = path.join(root, 'beet');
  rawDir = path.join(root, 'RAW');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(rawDir, { recursive: true });
  await fsp.writeFile(path.join(home, 'beet'), FAKE_BEET, { mode: 0o755 });

  for (const key of ['rawDir', 'beetBin', 'cleanupRawAfterImport']) {
    saved[key] = config[key];
  }
  config.rawDir = rawDir;
  config.beetBin = path.join(home, 'beet');
  config.cleanupRawAfterImport = true;

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  Object.assign(config, saved);
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(root, { recursive: true, force: true });
});

async function stage(album, files) {
  const dir = path.join(rawDir, album);
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), body);
  }
  return dir;
}

async function until(check, what) {
  for (let i = 0; i < 250; i += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Runs an import with `during` called once beets has scanned the folder — the
// moment from which anything new in RAW is something it was never handed —
// and returns the finished job. The import is let go even if `during` throws.
async function heldImport(album, during) {
  const jobId = await startHeldImport(album);
  let failure = null;
  try {
    await during();
  } catch (error) {
    failure = error;
  }
  const job = await releaseImport(jobId);
  if (failure) {
    throw failure;
  }
  return job;
}

async function startHeldImport(album) {
  await fsp.rm(path.join(home, 'scanned'), { force: true });
  const response = await fetch(`${base}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ album, force: true })
  });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  await until(() => fs.existsSync(path.join(home, 'scanned')), 'beets to scan the folder');
  return job.id;
}

// Waits for the stream's `end` event, which is sent once verification and
// cleanup have run (the status leaves `running` at the same moment).
async function releaseImport(jobId) {
  const stream = await fetch(`${base}/import/${jobId}/stream`);
  await fsp.writeFile(path.join(home, 'release'), '');
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes('event: end')) {
      break;
    }
  }
  return (await (await fetch(`${base}/import/${jobId}`)).json()).job;
}

function exists(file) {
  return fsp.stat(file).then(
    () => true,
    () => false
  );
}

test('an upload into an album that is importing is refused, not lost', async () => {
  const dir = await stage('Busy', { '01.flac': 'one', 'cover.jpg': 'art' });

  const job = await heldImport('Busy', async () => {
    const body = new FormData();
    body.append('files', new Blob(['late']), 'Busy/02.flac');
    const response = await fetch(`${base}/upload`, { method: 'POST', body });
    const result = await response.json();
    assert.equal(response.status, 409, JSON.stringify(result));
    assert.equal(result.code, 'album_busy');
    assert.equal(await exists(path.join(dir, '02.flac')), false, 'the refused file was never written');
  });

  assert.equal(job.status, 'done');
  assert.equal(await exists(dir), false, 'a clean import still removes its RAW folder');
});

test('an upload into a different album is not held up by an import', async () => {
  await stage('Importing', { '01.flac': 'one' });
  await heldImport('Importing', async () => {
    const body = new FormData();
    body.append('files', new Blob(['other']), 'Elsewhere/01.flac');
    const response = await fetch(`${base}/upload`, { method: 'POST', body });
    assert.equal(response.status, 200);
  });
  assert.equal(await fsp.readFile(path.join(rawDir, 'Elsewhere', '01.flac'), 'utf8'), 'other');
});

// The refusal above cannot close the window on its own: an upload that began
// before the import can still be writing when beets is handed the folder. So
// cleanup, the only thing that deletes, must delete only what it was handed.
test('cleanup keeps a file that reached RAW after beets scanned the folder', async () => {
  const dir = await stage('Race', { '01.flac': 'one', 'cover.jpg': 'art' });

  const job = await heldImport('Race', async () => {
    await fsp.writeFile(path.join(dir, '02.flac'), 'arrived mid-import');
    await fsp.mkdir(path.join(dir, 'CD2'));
    await fsp.writeFile(path.join(dir, 'CD2', '01.flac'), 'also mid-import');
  });

  assert.equal(job.status, 'done');
  assert.equal(await fsp.readFile(path.join(dir, '02.flac'), 'utf8'), 'arrived mid-import');
  assert.equal(await fsp.readFile(path.join(dir, 'CD2', '01.flac'), 'utf8'), 'also mid-import');
  assert.equal(await exists(path.join(dir, 'cover.jpg')), false, 'what beets was handed is still cleaned up');
  assert.equal(await exists(path.join(dir, '01.flac')), false);
  assert.equal(job.cleanup.ok, false, 'the RAW folder is reported as still there');
  assert.deepEqual(job.cleanup.kept.sort(), ['02.flac', path.join('CD2', '01.flac')]);
});

test('cleanup keeps a file that was rewritten while beets had the folder', async () => {
  const dir = await stage('Rewritten', { '01.flac': 'one', 'notes.txt': 'old' });

  const job = await heldImport('Rewritten', async () => {
    // A different size, so the change shows whatever the mtime resolution.
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'replaced while importing');
  });

  assert.equal(job.status, 'done');
  assert.equal(await fsp.readFile(path.join(dir, 'notes.txt'), 'utf8'), 'replaced while importing');
});

test('a folder beets emptied and pruned itself still counts as cleaned up', async () => {
  const dir = await stage('Pruned', { '01.flac': 'one' });
  const job = await heldImport('Pruned', async () => {});
  assert.equal(job.status, 'done');
  assert.equal(job.cleanup.ok, true, JSON.stringify(job.cleanup));
  assert.equal(await exists(dir), false);
});

test('deleting an album that is importing is refused', async () => {
  const dir = await stage('Doomed', { '01.flac': 'one' });

  const job = await heldImport('Doomed', async () => {
    const response = await fetch(`${base}/albums/Doomed`, { method: 'DELETE' });
    const result = await response.json();
    assert.equal(response.status, 409, JSON.stringify(result));
    assert.equal(result.code, 'album_busy');
    assert.equal(await fsp.readFile(path.join(dir, '01.flac'), 'utf8'), 'one', 'the folder beets is reading is intact');
  });

  assert.equal(job.status, 'done');
  assert.equal(job.verification.imported, 1, 'beets got the whole album');
});

test('deleting an idle album still works', async () => {
  const dir = await stage('Idle', { '01.flac': 'one' });
  const response = await fetch(`${base}/albums/Idle`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(await exists(dir), false);
});
