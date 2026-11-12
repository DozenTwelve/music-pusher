import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// The import lifecycle through the real routes, against a stand-in for beets
// that can be told to hang, to die part-way or to leave tracks behind — the
// ways a real one has. Everything here is about the job ending: on its own, at
// a timeout, at a cancel, or in a state a retry has to undo.

// The forced-match overlay lives in the temp dir, named when shell.js loads; a
// private temp dir lets one test make it unwritable without touching the host.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'import-tmp-'));
const { config } = await import('./config.js');
const { apiRouter } = await import('./routes.js');
const { limits } = await import('./shell.js');
const { albumLocked } = await import('./metadata/lock.js');
const { FAKE_BEET } = await import('./fake-beet.fixture.js');


let root;
let home;
let rawDir;
let server;
let base;
const saved = {};
const savedLimits = { ...limits };

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'import-'));
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
  await fsp.rm(process.env.TMPDIR, { recursive: true, force: true });
});

afterEach(async () => {
  Object.assign(limits, savedLimits);
  await fsp.rm(path.join(home, 'mode'), { force: true });
  await fsp.rm(path.join(home, 'slowdb'), { force: true });
  await fsp.rm(path.join(home, 'slowremove'), { force: true });
});

function setMode(mode) {
  return fsp.writeFile(path.join(home, 'mode'), mode);
}

async function stage(album, files) {
  const dir = path.join(rawDir, album);
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), body);
  }
  return dir;
}

async function until(check, what, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function post(route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function startImport(album, extra = {}) {
  await fsp.rm(path.join(home, 'pid'), { force: true });
  const response = await post('/import', { album, force: true, ...extra });
  const result = await response.json();
  assert.equal(response.status, 202, JSON.stringify(result));
  return result.job.id;
}

async function getJob(id) {
  return (await (await fetch(`${base}/import/${id}`)).json()).job;
}

async function finished(id) {
  let job;
  await until(async () => {
    job = await getJob(id);
    return job.status !== 'running';
  }, `import ${id} to finish`);
  return job;
}

async function logs(id) {
  const text = await (await fetch(`${base}/import/${id}/stream`)).text();
  return text;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function beetPid() {
  await until(() => fs.existsSync(path.join(home, 'pid')), 'beets to start');
  return Number(await fsp.readFile(path.join(home, 'pid'), 'utf8'));
}

function exists(file) {
  return fsp.stat(file).then(
    () => true,
    () => false
  );
}

test('a beet that never exits is killed at the timeout, and every lock comes back', async () => {
  await stage('Hung', { '01.flac': 'one' });
  await stage('Next', { '01.flac': 'one' });
  await setMode('hang');
  limits.importMs = 300;

  const id = await startImport('Hung');
  const pid = await beetPid();
  const job = await finished(id);

  assert.equal(job.status, 'failed');
  assert.match(await logs(id), /without finishing and is being stopped/);
  await until(() => !alive(pid), 'beet to be killed');
  assert.equal(albumLocked('Hung'), false, 'the album lock was released');
  assert.equal(await fsp.readFile(path.join(rawDir, 'Hung', '01.flac'), 'utf8'), 'one', 'RAW untouched');

  await fsp.rm(path.join(home, 'mode'));
  const next = await startImport('Next');
  assert.equal((await finished(next)).status, 'done', 'the next import is not refused as busy');
});

test('a running import can be cancelled', async () => {
  await stage('Cancel', { '01.flac': 'one' });
  await setMode('hang');

  const id = await startImport('Cancel');
  const pid = await beetPid();
  const response = await post(`/import/${id}/cancel`, {});
  assert.equal(response.status, 202);
  const job = await finished(id);

  assert.equal(job.status, 'failed');
  assert.match(await logs(id), /Import cancelled/);
  await until(() => !alive(pid), 'beet to be killed');
  assert.equal(albumLocked('Cancel'), false);

  const again = await post(`/import/${id}/cancel`, {});
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'not_running');
  assert.equal((await post('/import/no-such-job/cancel', {})).status, 404);
});

// The status flipped to `done` the moment beets exited, before the count that
// decides whether it really is done, and before cleanup had deleted RAW.
test('GET /import/:id does not say done until verification and cleanup have run', async () => {
  await stage('Slow', { '01.flac': 'one' });
  // The verification's read of the db waits a second behind a lock.
  await fsp.writeFile(path.join(home, 'slowdb'), '');
  const id = await startImport('Slow');

  let job;
  await until(async () => {
    job = await getJob(id);
    if (job.status !== 'running') {
      return true;
    }
    return false;
  }, 'the import to finish');
  assert.equal(job.status, 'done');
  assert.ok(job.verification, 'verified by the time it says done');
  assert.equal(job.cleanup?.ok, true, 'cleaned up by the time it says done');
});

test('a forced-match config that cannot be written fails the job and frees the album', async () => {
  await stage('Forced', { '01.flac': 'one' });
  const overlay = path.join(os.tmpdir(), 'music-pusher-forced-match.yaml');
  await fsp.mkdir(overlay); // writeFile onto a directory: EISDIR
  try {
    const response = await post('/import', {
      album: 'Forced',
      force: true,
      releaseId: '0b5ee42b-8c56-4b5e-9c7b-33f4bc3e4d6a'
    });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    const done = await finished(job.id);
    assert.equal(done.status, 'failed');
    assert.match(await logs(job.id), /Could not start beets/);
    assert.equal(albumLocked('Forced'), false);
  } finally {
    await fsp.rm(overlay, { recursive: true, force: true });
  }
});

// beets adds the rows first and moves the files after, so a beet that dies
// part-way leaves some tracks in the library and the rest in RAW. That used to
// be `failed`, with no record of which were which.
test('a beet that dies part-way leaves a partial that Undo and retry can put right', async () => {
  const dir = await stage('Died', { '01.flac': 'one', '02.flac': 'two' });
  await setMode('die');
  const id = await startImport('Died');
  const job = await finished(id);

  assert.equal(job.status, 'partial');
  assert.equal(job.verification.imported, 2);
  assert.equal(await exists(path.join(dir, '01.flac')), false, 'one track reached the library');
  assert.equal(await exists(dir), true, 'RAW is kept');

  await fsp.rm(path.join(home, 'mode'));
  const response = await post('/import/retry', { album: 'Died' });
  const result = await response.json();
  assert.equal(response.status, 202, JSON.stringify(result));
  assert.equal(result.undo.removed, 2);
  assert.equal(result.undo.movedBack, 1);
  const retried = await finished(result.job.id);
  assert.equal(retried.status, 'done');
  assert.equal(retried.verification.imported, 2);
});

test('retry refuses while another import runs, before it undoes anything', async () => {
  const dir = await stage('Short', { '01.flac': 'one', '02.flac': 'two' });
  await setMode('partial');
  const partial = await finished(await startImport('Short'));
  assert.equal(partial.status, 'partial');
  const landed = partial.verification.added[0].path;

  await stage('Blocking', { '01.flac': 'one' });
  await setMode('hang');
  const blocking = await startImport('Blocking');
  await beetPid();
  try {
    const response = await post('/import/retry', { album: 'Short' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'import_busy');
    assert.equal(await exists(landed), true, 'the landed track was not moved back');
    assert.equal(await exists(path.join(dir, '01.flac')), false);
  } finally {
    await post(`/import/${blocking}/cancel`, {});
    await finished(blocking);
  }

  await fsp.rm(path.join(home, 'mode'));
  const response = await post('/import/retry', { album: 'Short' });
  assert.equal(response.status, 202);
  assert.equal((await finished((await response.json()).job.id)).status, 'done');
});

test('retry moves tracks back across filesystems', async () => {
  const dir = await stage('Mounts', { '01.flac': 'one', '02.flac': 'two' });
  await setMode('partial');
  const partial = await finished(await startImport('Mounts'));
  assert.equal(partial.status, 'partial');
  const landed = partial.verification.added[0].path;
  await fsp.rm(path.join(home, 'mode'));

  const realRename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (String(from) === landed) {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    }
    return realRename(from, to);
  };
  try {
    const response = await post('/import/retry', { album: 'Mounts' });
    const result = await response.json();
    assert.equal(response.status, 202, JSON.stringify(result));
    assert.equal(result.undo.movedBack, 1);
    assert.equal(await exists(landed), false, 'the copy replaced the move: nothing left behind');
    assert.equal(await fsp.readFile(path.join(dir, '01.flac'), 'utf8'), 'one');
    assert.equal((await finished(result.job.id)).status, 'done');
  } finally {
    fsp.rename = realRename;
  }
});

// With the destination checked free, a file can still arrive under that name
// before the copy lands (an upload into RAW). The failed exclusive copy must
// not then delete the file that beat it there.
test('a cross-filesystem move back never deletes a file that took the name first', async () => {
  const dir = await stage('Raced', { '01.flac': 'one', '02.flac': 'two' });
  await setMode('partial');
  const partial = await finished(await startImport('Raced'));
  const landed = partial.verification.added[0].path;
  await fsp.rm(path.join(home, 'mode'));

  const realRename = fsp.rename;
  fsp.rename = async (from, to) => {
    if (String(from) === landed) {
      await fsp.writeFile(to, 'arrived first');
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    }
    return realRename(from, to);
  };
  try {
    const response = await post('/import/retry', { album: 'Raced' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'retry_undo_failed');
  } finally {
    fsp.rename = realRename;
  }
  assert.equal(await fsp.readFile(path.join(dir, '01.flac'), 'utf8'), 'arrived first');
  assert.equal(await fsp.readFile(landed, 'utf8'), 'one', 'and the library copy is still there');
});

test('a cancelled import holds its album until everything beets started is gone', async () => {
  await stage('Stubborn', { '01.flac': 'one' });
  await setMode('stubborn');
  const id = await startImport('Stubborn');
  await until(() => fs.existsSync(path.join(home, 'stubborn')), 'the stubborn child to start');
  const child = Number(await fsp.readFile(path.join(home, 'stubborn'), 'utf8'));
  await fsp.rm(path.join(home, 'stubborn'));

  await post(`/import/${id}/cancel`, {});
  await until(async () => (await getJob(id)).status !== 'running' || !alive(child), 'the job or the child to end', 10000);
  assert.equal(alive(child), false, 'nothing beets started is alive when the job lets go');
  await finished(id);
  assert.equal(albumLocked('Stubborn'), false);
});

// beets prunes a source folder it emptied, so a run that moved everything and
// then failed leaves a partial with no RAW folder at all.
test('a partial whose RAW folder beets pruned can still be retried', async () => {
  const dir = await stage('Pruned', { '01.flac': 'one', '02.flac': 'two' });
  await setMode('prune');
  const partial = await finished(await startImport('Pruned'));
  assert.equal(partial.status, 'partial');
  assert.equal(await exists(dir), false);
  await fsp.rm(path.join(home, 'mode'));

  const response = await post('/import/retry', { album: 'Pruned' });
  const result = await response.json();
  assert.equal(response.status, 202, JSON.stringify(result));
  assert.equal(result.undo.movedBack, 2);
  assert.equal((await finished(result.job.id)).status, 'done');
});

// The deploy asks /import/active before it reloads; a retry still undoing its
// partial has no running job yet, but a reload then would stop it half-way.
test('a retry that is still undoing counts as an import in flight', async () => {
  await stage('Undoing', { '01.flac': 'one', '02.flac': 'two' });
  await setMode('partial');
  assert.equal((await finished(await startImport('Undoing'))).status, 'partial');
  await fsp.rm(path.join(home, 'mode'));
  await fsp.writeFile(path.join(home, 'slowremove'), '');

  const retry = post('/import/retry', { album: 'Undoing' });
  let seen = null;
  await until(async () => {
    seen = (await (await fetch(`${base}/import/active`)).json()).job;
    return seen !== null;
  }, 'the retry to show as active');
  assert.equal(seen.album, 'Undoing');
  assert.equal(seen.status, 'undoing', 'seen while the undo runs, not only once beets starts');
  const response = await retry;
  assert.equal(response.status, 202);
  assert.equal((await finished((await response.json()).job.id)).status, 'done');
});
