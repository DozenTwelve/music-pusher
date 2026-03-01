import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const jobs = new Map();
let activeJobId = null;

function sendEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function appendLog(job, stream, chunk) {
  const text = String(chunk);
  const lines = text.split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
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

export function startImport(album) {
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

  const albumPath = path.join(config.rawDir, album);
  const id = randomUUID();
  const job = {
    id,
    album,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    logs: [],
    clients: new Set()
  };

  jobs.set(id, job);
  activeJobId = id;

  const processRef = spawn(config.beetBin, ['import', '-A', albumPath], {
    shell: false
  });

  processRef.stdout.on('data', (chunk) => appendLog(job, 'stdout', chunk));
  processRef.stderr.on('data', (chunk) => appendLog(job, 'stderr', chunk));

  processRef.on('error', (error) => {
    appendLog(job, 'stderr', error.message);
  });

  processRef.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.finishedAt = Date.now();
    activeJobId = null;

    const payload = {
      status: job.status,
      code
    };

    for (const client of job.clients) {
      sendEvent(client, 'end', payload);
      client.end();
    }

    job.clients.clear();
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
    finishedAt: job.finishedAt
  });

  for (const entry of job.logs) {
    sendEvent(response, 'log', entry);
  }

  if (job.status === 'done' || job.status === 'failed') {
    sendEvent(response, 'end', {
      status: job.status,
      code: job.status === 'done' ? 0 : 1
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
