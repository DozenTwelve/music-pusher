import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { acquireAlbum, releaseAlbum, albumBusyMessage } from './metadata/lock.js';
import { listAudioFiles } from './metadata/probe.js';
import { countLibraryItems } from './library.js';

const jobs = new Map();
let activeJobId = null;

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

// Async only for the pre-import measurements below; it still returns as soon as
// beets is spawned, and the job is followed over SSE.
export async function startImport(album) {
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
    before = await countLibraryItems();
  } catch (error) {
    // Verification is a safety net, not a precondition: if beets is unreachable
    // the import still runs, it just goes unchecked — and says so.
    pushLine(job, 'stderr', `Could not measure the library before importing: ${error.message}`);
    expected = null;
    before = null;
  }

  const processRef = spawn(config.beetBin, ['import', '-A', albumPath], {
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
        const imported = (await countLibraryItems()) - before;
        job.verification = { expected, imported };
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

  if (job.status === 'done' || job.status === 'failed') {
    sendEvent(response, 'end', {
      status: job.status,
      code: job.status === 'done' ? 0 : 1,
      cleanup: job.cleanup
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
