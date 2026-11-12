import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs, { constants as fsConstants } from 'node:fs';
import { config } from './config.js';
import { acquireAlbum, releaseAlbum, albumBusyMessage } from './metadata/lock.js';
import { listAudioFiles, runProcess, spawnGroup, killGroup } from './metadata/probe.js';
import { maxItemId, itemsAddedSince } from './library.js';

const jobs = new Map();
let activeJobId = null;

// Every status a finished job can hold. Named because it was previously spelled
// out inline as `done || failed`, which silently omitted `partial` — so a client
// reconnecting to a finished partial import was never sent an `end` event and
// waited on a job that had already stopped. Anything that assigns a new terminal
// status has to appear here too.
export const TERMINAL_STATUSES = new Set(['done', 'failed', 'partial']);

const MAX_RETAINED_JOBS = 20;

// Jobs are kept on disk as well, so a restart mid-import (`npm run deploy` is a
// `pm2 reload`) is something the next start can report and Undo and retry can
// act on, rather than an album left half in the library with no record. In
// RAW, which this app owns; the album list only shows folders.
const STATE_FILE = '.music-pusher-jobs.json';
const PERSISTED_LOG_LINES = 200;

function statePath() {
  return path.join(config.rawDir, STATE_FILE);
}

// Synchronous so it can never interleave with itself; the file is small and
// written twice per import. A failure to save costs the record, not the import.
function saveJobs() {
  try {
    const records = [...jobs.values()].map((job) => ({
      id: job.id,
      album: job.album,
      status: job.status,
      cleanup: job.cleanup,
      verification: job.verification,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      logs: job.logs.slice(-PERSISTED_LOG_LINES),
      // What recovery needs to find a beet left running and count what landed.
      pid: job.process?.pid ?? null,
      run: job.run ?? null
    }));
    fs.mkdirSync(config.rawDir, { recursive: true });
    const temp = `${statePath()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(records));
    fs.renameSync(temp, statePath());
  } catch (error) {
    console.error(`Could not save the import jobs: ${error.message}`);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The command line of a running process, or null.
async function commandLine(pid) {
  try {
    return (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
  } catch {
    // no /proc (macOS)
  }
  const { code, stdout } = await runProcess('ps', ['-o', 'args=', '-p', String(pid)], { timeoutMs: 10000 });
  return code === 0 ? stdout : null;
}

// A server killed outright (SIGKILL, the OOM killer) runs no exit hook, so its
// beet carries on alone, moving files nobody is tracking. Stop it — but only if
// the pid is still that beet: after a reboot it can belong to anything.
async function reapOrphan(job, pid, albumPath) {
  const args = await commandLine(pid);
  if (!args || !albumPath || !args.includes(config.beetBin) || !args.includes(albumPath)) {
    return;
  }
  pushLine(job, 'stderr', `beets (pid ${pid}) was still running on its own; stopping it.`);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
    for (let i = 0; i < 50 && processAlive(pid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Load the jobs saved by the previous run and settle any it left running: stop
// a beet that outlived it, then count what reached the library. Tracks that
// landed make the job `partial`, which is what Undo and retry acts on.
// Run once at startup, before the server takes requests.
export async function recoverJobs() {
  let records;
  try {
    records = JSON.parse(await fsp.readFile(statePath(), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Could not read the saved import jobs: ${error.message}`);
    }
    return;
  }
  if (!Array.isArray(records)) {
    return;
  }

  for (const { pid, run, ...record } of records.filter((entry) => entry && typeof entry === 'object')) {
    if (typeof record.id !== 'string' || jobs.has(record.id)) {
      continue;
    }
    const job = {
      ...record,
      logs: Array.isArray(record.logs) ? record.logs : [],
      partial: { stdout: '', stderr: '' },
      clients: new Set(),
      stopping: null,
      process: null,
      run
    };
    jobs.set(job.id, job);
    if (job.status !== 'running') {
      continue;
    }

    pushLine(job, 'stderr', 'The server stopped while this import was running.');
    const albumPath = run?.albumPath ?? path.join(config.rawDir, job.album);
    if (pid) {
      await reapOrphan(job, pid, albumPath);
    }
    if (run?.before == null) {
      pushLine(job, 'stderr', 'Nothing was measured before it started, so run a library check to see what landed.');
    }
    job.stopping = 'interrupted';
    acquireAlbum(job.album); // finishImport releases it
    await finishImport(job, null, {
      albumPath,
      expected: run?.expected ?? null,
      before: run?.before ?? null,
      staged: null
    });
  }
  pruneJobs();
  saveJobs();
}

function sendEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function pushLine(job, stream, line) {
  const entry = {
    stream,
    line,
    ts: Date.now()
  };

  job.logs.push(entry);
  if (job.logs.length > 5000) {
    job.logs.shift();
  }

  for (const client of job.clients) {
    sendEvent(client, 'log', entry);
  }
}

// Process data chunks do not align to line boundaries, so hold the trailing
// partial line per stream until the next chunk (or stream end) completes it.
function appendChunk(job, stream, chunk) {
  const text = job.partial[stream] + String(chunk);
  const parts = text.split(/\r?\n/);
  job.partial[stream] = parts.pop();

  for (const line of parts) {
    if (line) {
      pushLine(job, stream, line);
    }
  }
}

function flushPartial(job, stream) {
  const rest = job.partial[stream];
  job.partial[stream] = '';
  if (rest) {
    pushLine(job, stream, rest);
  }
}

function pruneJobs() {
  if (jobs.size <= MAX_RETAINED_JOBS) {
    return;
  }

  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));

  while (jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
    jobs.delete(finished.shift().id);
  }
}

// Every file under dir, with the size and mtime it has now.
async function snapshotFiles(dir) {
  const files = new Map();
  for (const rel of await fsp.readdir(dir, { recursive: true })) {
    const stat = await fsp.lstat(path.join(dir, rel));
    if (stat.isFile()) {
      files.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}

// Delete what the RAW folder held when beets was handed it — the files still
// exactly as they were, then the folders that leaves empty — and return the
// relative paths of whatever is left. A file that arrived or changed during the
// import was never beets', so it stays, and so does the folder around it.
async function removeStaged(dir, staged) {
  for (const [rel, before] of staged) {
    const file = path.join(dir, rel);
    const now = await fsp.lstat(file).catch(() => null); // gone: beets moved it
    if (now?.isFile() && now.size === before.size && now.mtimeMs === before.mtimeMs) {
      await fsp.rm(file);
    }
  }

  // beets prunes a source folder it emptied, so the folder may already be gone.
  const dirs = [];
  for (const rel of await fsp.readdir(dir, { recursive: true }).catch(() => [])) {
    if ((await fsp.lstat(path.join(dir, rel))).isDirectory()) {
      dirs.push(path.join(dir, rel));
    }
  }
  // Deepest first; rmdir refuses a folder that still holds anything.
  dirs.sort((a, b) => b.length - a.length);
  for (const folder of [...dirs, dir]) {
    await fsp.rmdir(folder).catch(() => {});
  }

  const left = await snapshotFiles(dir).catch(() => new Map());
  return [...left.keys()];
}

export function runAudit(album) {
  return new Promise((resolve) => {
    const albumPath = path.join(config.rawDir, album);
    const processRef = spawn(config.exiftoolBin, ['-r', albumPath], {
      shell: false
    });

    let stdout = '';
    let stderr = '';

    processRef.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    processRef.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    processRef.on('error', (error) => {
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim()
      });
    });

    processRef.on('close', (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr
      });
    });
  });
}

const RELEASE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A per-run beets config that accepts a match the default thresholds reject.
//
// This is only ever combined with `--search-id`, and that pairing is what makes
// it safe: the candidate set is one release a human has just confirmed by name,
// date and track count, so "accept the best candidate" means "accept the one
// they picked". Raising the threshold in the real config would instead apply to
// every album forever, silently accepting mediocre matches nobody looked at —
// which is the opposite of the point.
//
// It has to be a file: beets takes an overlay config with `-c` and has no
// command-line equivalent for a single setting.
const FORCED_MATCH_CONFIG = path.join(os.tmpdir(), 'music-pusher-forced-match.yaml');
let forcedMatchConfigWritten = false;

async function forcedMatchConfigPath() {
  if (!forcedMatchConfigWritten) {
    // 1.0 is the maximum distance, so this accepts whatever the single
    // candidate scores rather than guessing a cutoff that would reject the
    // badly-tagged albums this exists for.
    await fsp.writeFile(FORCED_MATCH_CONFIG, 'match:\n  strong_rec_thresh: 1.0\n');
    forcedMatchConfigWritten = true;
  }
  return FORCED_MATCH_CONFIG;
}

// How long a single beet import may run before it is killed. Generous: a big
// album with many MusicBrainz lookups is slow, but a beet stuck on a
// MusicBrainz request never returns at all, and until it did every other
// import, fix and library repair was refused. Mutable for the tests.
export const limits = { importMs: 60 * 60 * 1000 };

// Set while a retry undoes a partial, before its import starts, so another
// import cannot start in between and leave the undo half-done behind a 409.
let reservedAlbum = null;

// The album an import is running (or about to run) for, or null.
function importInFlight() {
  const active = activeJobId ? jobs.get(activeJobId) : null;
  if (active && active.status === 'running') {
    return active.album;
  }
  return reservedAlbum;
}

function busyResult(running) {
  return {
    ok: false,
    error: 'import_busy',
    message: `Import already running for album '${running}'.`
  };
}

// Async only for the pre-import measurements below; it still returns as soon as
// beets is spawned, and the job is followed over SSE.
export async function startImport(album, { releaseId = null } = {}) {
  if (releaseId != null && !RELEASE_ID_RE.test(releaseId)) {
    return {
      ok: false,
      error: 'bad_release_id',
      message: 'That is not a MusicBrainz release ID.'
    };
  }

  const running = importInFlight();
  if (running) {
    return busyResult(running);
  }

  // beets is configured with `move: yes`, so an import relocates the very files
  // a tag fix or cover embed renames its temp file over. Hold the album lock for
  // the whole beets run, not just this call — it is released in finishImport.
  if (!acquireAlbum(album)) {
    return {
      ok: false,
      error: 'import_busy',
      message: albumBusyMessage(album)
    };
  }

  const albumPath = path.join(config.rawDir, album);
  const id = randomUUID();
  const job = {
    id,
    album,
    // Stays 'running' until verification and cleanup are done, not just until
    // beets exits: a caller polling GET /import/:id must not see `done` while
    // the RAW folder is still being deleted, or before the count says whether
    // it should have been.
    status: 'running',
    cleanup: null,
    verification: null,
    createdAt: Date.now(),
    finishedAt: null,
    logs: [],
    partial: { stdout: '', stderr: '' },
    clients: new Set(),
    // Why the run was stopped from here, when it was: 'timeout' or 'cancelled'.
    stopping: null,
    process: null
  };

  jobs.set(id, job);
  activeJobId = id;

  // Measured before the run so finishImport can tell how much of the album
  // actually landed. beets exits 0 whether it imported all of the files, some of
  // them or none, and this app then deletes the RAW folder on that exit code —
  // which is how an 8-track album came to be represented in the library by a
  // single track, with its source already gone.
  //
  // Counting rows either side beats matching on the album name: beets decides
  // the imported album's name itself, and matching would have to agree with that
  // decision forever. Only one import runs at a time (importInFlight above, held
  // until finishImport is done) and a library repair cannot overlap one (the
  // album lock), so nothing else moves the total in between.
  const run = { albumPath, expected: null, before: null, staged: null };
  try {
    // What cleanup may delete afterwards: the folder as beets is handed it. No
    // snapshot, no cleanup.
    try {
      run.staged = await snapshotFiles(albumPath);
    } catch (error) {
      pushLine(job, 'stderr', `Could not list the RAW folder before importing: ${error.message}`);
    }
    try {
      run.expected = (await listAudioFiles(albumPath)).length;
      run.before = await maxItemId();
    } catch (error) {
      // Verification is a safety net, not a precondition: if beets is unreachable
      // the import still runs, it just goes unchecked — and says so.
      pushLine(job, 'stderr', `Could not measure the library before importing: ${error.message}`);
      run.expected = null;
      run.before = null;
    }

    // `-q` (non-interactive), not `-A` (no autotag). `-A` told beets to take the
    // files' own tags as final, so an album that arrived with no titles landed in
    // the library with no titles — which is how `空洞です` became eight blank rows
    // and one track numbered 00. Dropping it lets beets match against MusicBrainz.
    //
    // The chroma plugin is deliberately off in the beets config. Its AcoustID
    // recording ids rarely line up with the release being matched, which added
    // about 0.11 to the distance and pushed exact matches (0.00 without it) past
    // strong_rec_thresh 0.04 — so quiet imports fell back to asis, and 50 of 53
    // albums landed unmatched that way. An album with no usable tags is not
    // fingerprinted, then: it goes through the release picker, which imports
    // with `--search-id` (below).
    //
    // `-q` is required, not stylistic: without `-A` an unmatched album prompts,
    // and there is no terminal on the other end of these pipes to answer it.
    //
    // This pairs with `import.quiet_fallback: asis` in the beets config. Under
    // `skip` — its previous value — a quiet run drops every album it cannot match,
    // exits 0, and reproduces exactly the partial import 12ab309 exists to catch.
    // With `asis` an unmatched album imports on its own tags, which is what `-A`
    // did for every album; matched ones are corrected. Neither is worse than
    // before.
    // `-c` is a global beets option and has to precede the subcommand.
    const beetArgs = releaseId
      ? ['-c', await forcedMatchConfigPath(), 'import', '-q', '--search-id', releaseId, albumPath]
      : ['import', '-q', albumPath];
    if (releaseId) {
      pushLine(job, 'stdout', `Importing as MusicBrainz release ${releaseId}.`);
    }

    const processRef = spawnGroup(config.beetBin, beetArgs);
    job.process = processRef;
    job.run = { albumPath, expected: run.expected, before: run.before };
    saveJobs();
    job.timer = setTimeout(() => stopJob(job, 'timeout'), limits.importMs);

    processRef.stdout.on('data', (chunk) => appendChunk(job, 'stdout', chunk));
    processRef.stderr.on('data', (chunk) => appendChunk(job, 'stderr', chunk));
    processRef.on('error', (error) => {
      pushLine(job, 'stderr', error.message);
    });
    processRef.on('close', async (code) => {
      // A stopped run is finished only once its whole group is gone: a
      // descendant still writing must not overlap a retry or a repair.
      await processRef.killing;
      finishImport(job, code, run).catch((error) => {
        // finishImport guards each step; this is the last word if it still
        // throws, so the job and its lock can never be left held.
        console.error(`Import ${job.id} did not finish cleanly:`, error);
      });
    });
  } catch (error) {
    // Anything that throws before beets is running (the forced-match config
    // write, a spawn that throws outright) would otherwise leave the job
    // 'running' and the album locked until a restart.
    pushLine(job, 'stderr', `Could not start beets: ${error.message}`);
    await finishImport(job, null, { ...run, before: null });
  }

  return {
    ok: true,
    job: {
      id: job.id,
      album: job.album,
      status: job.status,
      createdAt: job.createdAt
    }
  };
}

function stopJob(job, reason) {
  if (job.status !== 'running' || !job.process || job.stopping) {
    return;
  }
  job.stopping = reason;
  pushLine(
    job,
    'stderr',
    reason === 'timeout'
      ? `beets ran for ${Math.round(limits.importMs / 60000)} minutes without finishing and is being stopped.`
      : 'Import cancelled; stopping beets.'
  );
  killGroup(job.process);
}

// Stop a running import (and everything beets started). The job finishes the
// usual way once beets is gone, as `failed` — or `partial` if some tracks had
// already landed, so Undo and retry can put them back.
export function cancelImport(id) {
  const job = jobs.get(id);
  if (!job) {
    return { ok: false, error: 'job_not_found', message: 'No import job found for the given id.' };
  }
  if (job.status !== 'running' || !job.process) {
    return {
      ok: false,
      error: 'not_running',
      message: `beets is not running for '${job.album}' (the import has finished or is finishing).`
    };
  }
  stopJob(job, 'cancelled');
  return { ok: true };
}

async function finishImport(job, code, { albumPath, expected, before, staged }) {
  const { album } = job;
  clearTimeout(job.timer);
  // beets is gone; nothing is left to cancel or time out.
  job.process = null;
  flushPartial(job, 'stdout');
  flushPartial(job, 'stderr');

  let status = code === 0 && !job.stopping ? 'done' : 'failed';

  if (before !== null) {
    try {
      const added = await itemsAddedSince(before);
      job.verification = {
        expected,
        imported: added.length,
        // Kept so a retry can undo exactly this run — see retryImport.
        added: added.map((row) => ({ id: row.id, path: row.path.toString('utf8') }))
      };
      const imported = added.length;
      if (status !== 'done') {
        // A beet that died, timed out or was cancelled part-way can leave the
        // album split between the library and RAW. Calling that `failed` gave
        // no way back: the leftovers then met the duplicate guard, and Import
        // anyway filed them as a second album.
        if (imported > 0) {
          status = 'partial';
          pushLine(
            job,
            'stderr',
            `beets stopped before finishing; ${imported} of ${expected} tracks had already reached the ` +
              'library. The RAW folder is kept — Undo and retry puts them back and imports again.'
          );
        }
      } else {
        if (imported !== expected) {
          status = 'partial';
          pushLine(
            job,
            'stderr',
            `Only ${imported} of ${expected} tracks reached the library. The RAW folder is kept ` +
              'so nothing is lost — check the log above for what beets skipped.'
          );
        }

        // Arriving and arriving usable are different questions, and until now
        // only the first one was asked. An album beets cannot match imports
        // `asis`: every track lands, every count agrees, the exit code is 0,
        // and what got written back is exactly the nothing the files arrived
        // with. That is how ゆらゆら帝国 and Francis of Delirium sat in the
        // library as blank names for months — nothing in the run said a word.
        // These two counts are what a person would have noticed, asked at the
        // one moment they can still act on cheaply.
        const untitled = added.filter((row) => row.title.trim() === '').length;
        const matched = added.some((row) => row.mbAlbumId !== '');
        job.verification.untitled = untitled;
        job.verification.matched = matched;

        if (untitled > 0) {
          pushLine(
            job,
            'stderr',
            `${untitled} of ${imported} imported tracks have no title. beets had nothing to ` +
              'match them on and filed them as they arrived.'
          );
        }
        if (!matched && imported > 0) {
          pushLine(
            job,
            'stderr',
            'beets matched no MusicBrainz release for this album, so the tags are unchanged ' +
              'from what the files came with. Pick the release in step 3 and import again to ' +
              'correct them.'
          );
        }
      }
    } catch (error) {
      if (status === 'done') {
        status = 'partial';
      }
      pushLine(job, 'stderr', `Could not verify the import: ${error.message}`);
    }
  }

  // Cleanup is gated on the verified status, not on the exit code. Deleting
  // the source of a partial import is the one mistake there is no recovering
  // from.
  //
  // And it deletes only what beets was handed. A file that reached the folder
  // after the snapshot above — an upload already in flight when the import
  // began — is in neither RAW's past nor the library, so removing the whole
  // folder would lose it outright.
  if (status === 'done' && config.cleanupRawAfterImport && staged) {
    try {
      const kept = await removeStaged(albumPath, staged);
      if (kept.length === 0) {
        job.cleanup = {
          ok: true,
          removedPath: albumPath
        };
        pushLine(job, 'stdout', `Cleanup complete: removed RAW folder '${album}'.`);
      } else {
        job.cleanup = {
          ok: false,
          removedPath: albumPath,
          kept,
          message: `${kept.length} file(s) arrived or changed during the import and were kept.`
        };
        pushLine(
          job,
          'stderr',
          `Kept RAW folder '${album}': ${kept.join(', ')} arrived or changed while beets was ` +
            'importing, so they were not part of this import.'
        );
      }
    } catch (error) {
      job.cleanup = {
        ok: false,
        removedPath: albumPath,
        message: error.message
      };
      pushLine(job, 'stderr', `Cleanup failed for RAW folder '${album}': ${error.message}`);
    }
  }

  // Only now, with verification and cleanup behind it, is the job finished:
  // the status, the single-import slot and the album lock all change together.
  job.status = status;
  job.finishedAt = Date.now();
  if (activeJobId === job.id) {
    activeJobId = null;
  }
  releaseAlbum(album);

  const payload = {
    status: job.status,
    code,
    cleanup: job.cleanup,
    verification: job.verification ?? null
  };

  for (const client of job.clients) {
    sendEvent(client, 'end', payload);
    client.end();
  }

  job.clients.clear();
  pruneJobs();
  saveJobs();
}

// Move one file, across filesystems if it has to: RAW and the library are
// allowed to be separate mounts, where rename fails with EXDEV.
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    // EXCL: never overwrite. The copy is removed if it does not complete, and
    // the source only once it has.
    try {
      await fsp.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      // EEXIST: someone else's file took the name in between; it is not ours.
      if (copyError.code !== 'EEXIST') {
        await fsp.rm(to, { force: true }).catch(() => {});
      }
      throw copyError;
    }
    await fsp.unlink(from);
  }
}

// Undo a partial import, then run it again.
//
// A partial leaves the album split across two places: the tracks beets accepted
// were moved into the library (`move: yes`), and the ones it skipped are still
// in the RAW folder, which the verification deliberately did not delete.
// Importing RAW again as-is would file the leftovers as an album of their own,
// so the two halves have to be reunited first.
//
// Every step is chosen so that a failure part-way cannot lose audio: rows are
// removed without `-d`, so files survive as orphans that /library/health will
// report; the moves are into the RAW folder, which is never deleted except after
// a verified-complete import; and a name already taken in RAW is left alone
// rather than overwritten.
export async function retryImport(album) {
  const job = [...jobs.values()]
    .filter((candidate) => candidate.album === album && candidate.status === 'partial')
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];

  if (!job) {
    return {
      ok: false,
      error: 'nothing_to_retry',
      message: `No partial import is on record for album '${album}'.`
    };
  }

  // Checked before anything is undone, not left to startImport afterwards:
  // finding out then meant the rows were already gone and the files back in
  // RAW, with the retry refused.
  const running = importInFlight();
  if (running) {
    return busyResult(running);
  }

  const added = job.verification?.added ?? [];
  const albumPath = path.join(config.rawDir, album);

  if (!acquireAlbum(album)) {
    return { ok: false, error: 'import_busy', message: albumBusyMessage(album) };
  }
  reservedAlbum = album;

  const undo = { removed: 0, movedBack: 0, skipped: [] };
  try {
    if (added.length > 0) {
      // `id:1 , id:2 , …` — a comma is beets' OR between query terms. Without
      // `-d` this drops the rows and leaves every file where it is.
      const args = ['remove', '-f'];
      added.forEach((row, index) => {
        if (index > 0) {
          args.push(',');
        }
        args.push(`id:${row.id}`);
      });
      const { code, stderr } = await runProcess(config.beetBin, args, { timeoutMs: 2 * 60 * 1000 });
      if (code !== 0) {
        throw new Error(`'beet remove' failed (exit ${code}): ${stderr.trim()}`);
      }
      undo.removed = added.length;
    }

    await fsp.mkdir(albumPath, { recursive: true });
    for (const row of added) {
      const destination = path.join(albumPath, path.basename(row.path));
      if (row.path === destination) {
        continue; // never moved out of RAW in the first place
      }
      try {
        await fsp.access(destination);
        undo.skipped.push(destination); // something is already there; do not clobber
        continue;
      } catch {
        // free to take the name
      }
      await moveFile(row.path, destination);
      undo.movedBack += 1;
    }
  } catch (error) {
    return {
      ok: false,
      error: 'retry_undo_failed',
      message: `Could not undo the partial import: ${error.message}. Nothing was deleted; run a library check to see the current state.`
    };
  } finally {
    // startImport takes the lock itself, and holds it past its own cleanup.
    // Nothing awaits between here and its acquireAlbum, so nothing can slip in.
    reservedAlbum = null;
    releaseAlbum(album);
  }

  // This partial is undone; it must not be undone a second time.
  job.status = 'failed';
  const result = await startImport(album);
  return result.ok ? { ...result, undo } : result;
}

// The import running now, if any — what a deploy checks before it reloads. A
// retry still undoing its partial counts: a reload would stop that half-way.
export function activeJob() {
  const job = activeJobId ? jobs.get(activeJobId) : null;
  if (job?.status === 'running') {
    return job;
  }
  return reservedAlbum ? { id: null, album: reservedAlbum, status: 'undoing', createdAt: null } : null;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function streamJob(id, response) {
  const job = jobs.get(id);
  if (!job) {
    return { ok: false };
  }

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');

  response.flushHeaders();

  sendEvent(response, 'meta', {
    id: job.id,
    album: job.album,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    cleanup: job.cleanup
  });

  for (const entry of job.logs) {
    sendEvent(response, 'log', entry);
  }

  // The same shape the live run sends, verification included. Without it a
  // client that connects after the job finished — a page refresh during a long
  // import is enough — is told the import could not be verified, when in fact
  // it was verified and found short. The count is the one thing that says how
  // much of the album is actually there.
  if (TERMINAL_STATUSES.has(job.status)) {
    sendEvent(response, 'end', {
      status: job.status,
      code: job.status === 'failed' ? 1 : 0,
      cleanup: job.cleanup,
      verification: job.verification ?? null
    });
    response.end();
    return { ok: true };
  }

  const keepAlive = setInterval(() => {
    sendEvent(response, 'ping', { ts: Date.now() });
  }, 15000);

  job.clients.add(response);

  response.on('close', () => {
    clearInterval(keepAlive);
    job.clients.delete(response);
  });

  return { ok: true };
}
