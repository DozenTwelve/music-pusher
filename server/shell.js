import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { acquireAlbum, releaseAlbum, albumBusyMessage } from './metadata/lock.js';
import { listAudioFiles, runProcess } from './metadata/probe.js';
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
    .filter((job) => job.id !== activeJobId && job.status !== 'running')
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));

  while (jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
    jobs.delete(finished.shift().id);
  }
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

  if (activeJobId) {
    const activeJob = jobs.get(activeJobId);
    if (activeJob && activeJob.status === 'running') {
      return {
        ok: false,
        error: 'import_busy',
        message: `Import already running for album '${activeJob.album}'.`
      };
    }
  }

  // beets is configured with `move: yes`, so an import relocates the very files
  // a tag fix or cover embed renames its temp file over. Hold the album lock for
  // the whole beets run, not just this call — it is released in the `close`
  // handler below.
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
    status: 'running',
    cleanup: null,
    verification: null,
    createdAt: Date.now(),
    finishedAt: null,
    logs: [],
    partial: { stdout: '', stderr: '' },
    clients: new Set()
  };

  jobs.set(id, job);
  activeJobId = id;

  // Measured before the run so the close handler can tell how much of the album
  // actually landed. beets exits 0 whether it imported all of the files, some of
  // them or none, and this app then deletes the RAW folder on that exit code —
  // which is how an 8-track album came to be represented in the library by a
  // single track, with its source already gone.
  //
  // Counting rows either side beats matching on the album name: beets decides
  // the imported album's name itself, and matching would have to agree with that
  // decision forever. Only one import runs at a time (activeJobId above) and a
  // library repair cannot overlap one (the album lock), so nothing else moves
  // the total in between.
  let expected = null;
  let before = null;
  try {
    expected = (await listAudioFiles(albumPath)).length;
    before = await maxItemId();
  } catch (error) {
    // Verification is a safety net, not a precondition: if beets is unreachable
    // the import still runs, it just goes unchecked — and says so.
    pushLine(job, 'stderr', `Could not measure the library before importing: ${error.message}`);
    expected = null;
    before = null;
  }

  // `-q` (non-interactive), not `-A` (no autotag). `-A` told beets to take the
  // files' own tags as final, so an album that arrived with no titles landed in
  // the library with no titles — which is how `空洞です` became eight blank rows
  // and one track numbered 00. Dropping it lets beets match against MusicBrainz
  // and, via the chroma plugin already enabled in its config, fingerprint the
  // tracks that carry nothing to match on.
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

  const processRef = spawn(config.beetBin, beetArgs, {
    shell: false
  });

  processRef.stdout.on('data', (chunk) => appendChunk(job, 'stdout', chunk));
  processRef.stderr.on('data', (chunk) => appendChunk(job, 'stderr', chunk));

  processRef.on('error', (error) => {
    pushLine(job, 'stderr', error.message);
  });

  processRef.on('close', async (code) => {
    flushPartial(job, 'stdout');
    flushPartial(job, 'stderr');

    job.status = code === 0 ? 'done' : 'failed';
    job.finishedAt = Date.now();
    activeJobId = null;

    if (job.status === 'done' && before !== null) {
      try {
        const added = await itemsAddedSince(before);
        job.verification = {
          expected,
          imported: added.length,
          // Kept so a retry can undo exactly this run — see retryImport.
          added: added.map((row) => ({ id: row.id, path: row.path.toString('utf8') }))
        };
        const imported = added.length;
        if (imported !== expected) {
          job.status = 'partial';
          pushLine(
            job,
            'stderr',
            `Only ${imported} of ${expected} tracks reached the library. The RAW folder is kept ` +
              'so nothing is lost — check the log above for what beets skipped.'
          );
        }
      } catch (error) {
        job.status = 'partial';
        pushLine(job, 'stderr', `Could not verify the import: ${error.message}`);
      }
    }

    // Cleanup is gated on the verified status, not on the exit code. Deleting
    // the source of a partial import is the one mistake there is no recovering
    // from.
    if (job.status === 'done' && config.cleanupRawAfterImport) {
      try {
        await fsp.rm(albumPath, { recursive: true, force: true });
        job.cleanup = {
          ok: true,
          removedPath: albumPath
        };
        pushLine(job, 'stdout', `Cleanup complete: removed RAW folder '${album}'.`);
      } catch (error) {
        job.cleanup = {
          ok: false,
          removedPath: albumPath,
          message: error.message
        };
        pushLine(job, 'stderr', `Cleanup failed for RAW folder '${album}': ${error.message}`);
      }
    }

    // Released only here: the cleanup above still deletes the album's RAW
    // folder, so the lock has to outlive it too.
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
  });

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

  const added = job.verification?.added ?? [];
  const albumPath = path.join(config.rawDir, album);

  if (!acquireAlbum(album)) {
    return { ok: false, error: 'import_busy', message: albumBusyMessage(album) };
  }

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
      const { code, stderr } = await runProcess(config.beetBin, args);
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
      await fsp.rename(row.path, destination);
      undo.movedBack += 1;
    }
  } catch (error) {
    releaseAlbum(album);
    return {
      ok: false,
      error: 'retry_undo_failed',
      message: `Could not undo the partial import: ${error.message}. Nothing was deleted; run a library check to see the current state.`
    };
  }

  // startImport takes the lock itself, and holds it past its own cleanup.
  releaseAlbum(album);

  const result = await startImport(album);
  return result.ok ? { ...result, undo } : result;
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
