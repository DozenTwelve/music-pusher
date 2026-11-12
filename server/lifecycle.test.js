import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FAKE_BEET } from './fake-beet.fixture.js';

// The real server, as a process of its own, against a stand-in for beets —
// for what only happens when the server itself stops or starts.

const ROOT = path.resolve(import.meta.dirname, '..');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, what, ms = 10000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  proc.stdout.on('data', (chunk) => (output += chunk));
  proc.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await until(() => output.includes('listening'), 'the server to listen');
  } catch (error) {
    proc.kill('SIGKILL');
    throw new Error(`${error.message}: ${output}`);
  }
  return { proc, base: `http://127.0.0.1:${port}/api`, exited, output: () => output };
}

test('a beet still running when the server is stopped dies with it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifecycle-'));
  let server;
  let pid;
  try {
    // `beet config` that never answers, and says who it is first.
    const beet = path.join(dir, 'beet');
    await fsp.writeFile(beet, `#!/bin/sh\necho $$ > '${dir}/pid'\nexec sleep 60\n`, { mode: 0o755 });
    server = await startServer({ RAW_DIR: path.join(dir, 'RAW'), BEET_BIN: beet });

    fetch(`${server.base}/library/health`).catch(() => {});
    await until(() => fsp.access(path.join(dir, 'pid')).then(() => true, () => false), 'beet to start');
    pid = Number(await fsp.readFile(path.join(dir, 'pid'), 'utf8'));
    assert.equal(alive(pid), true);

    server.proc.kill('SIGTERM');
    await server.exited;
    await until(() => !alive(pid), 'beet to die with the server', 3000);
  } finally {
    // A failure above must not leave either process holding the test runner open.
    server?.proc.kill('SIGKILL');
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// A restart mid-import — `npm run deploy` is a `pm2 reload` — used to lose the
// job outright: jobs lived in memory, so its stream 404ed, Undo and retry found
// nothing to retry, and the album sat half in the library and half in RAW with
// no record of which was which.
async function stagedImport(dir, mode) {
  const raw = path.join(dir, 'RAW');
  const home = path.join(dir, 'beet');
  await fsp.mkdir(path.join(raw, 'Album'), { recursive: true });
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(raw, 'Album', '01.flac'), 'one');
  await fsp.writeFile(path.join(raw, 'Album', '02.flac'), 'two');
  await fsp.writeFile(path.join(home, 'beet'), FAKE_BEET, { mode: 0o755 });
  await fsp.writeFile(path.join(home, 'mode'), mode);
  const env = { RAW_DIR: raw, BEET_BIN: path.join(home, 'beet') };
  const server = await startServer(env);
  const response = await fetch(`${server.base}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ album: 'Album', force: true })
  });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  // `stall` records both tracks and moves the first before it hangs.
  if (mode === 'stall') {
    await until(() => fsp.access(path.join(home, 'lib', 'Album', '01.flac')).then(() => true, () => false), 'beets to move a track');
  }
  await until(() => fsp.access(path.join(home, 'pid')).then(() => true, () => false), 'beets to start');
  const pid = Number(await fsp.readFile(path.join(home, 'pid'), 'utf8'));
  return { server, env, home, raw, jobId: job.id, pid };
}

async function settled(base, id) {
  let job;
  await until(async () => {
    job = (await (await fetch(`${base}/import/${id}`)).json()).job;
    return job && job.status !== 'running';
  }, `import ${id} to settle`);
  return job;
}

async function recoversAfter(kill) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifecycle-'));
  const servers = [];
  let pid;
  try {
    const run = await stagedImport(dir, 'stall');
    servers.push(run.server);
    pid = run.pid;
    await kill(run.server);
    await run.server.exited;

    await fsp.rm(path.join(run.home, 'mode'));
    const restarted = await startServer(run.env);
    servers.push(restarted);
    await until(() => !alive(pid), 'beets to be gone after the restart', 8000);

    const response = await fetch(`${restarted.base}/import/${run.jobId}`);
    assert.equal(response.status, 200, 'the job survived the restart');
    const job = (await response.json()).job;
    assert.equal(job.status, 'partial');
    assert.equal(job.verification.imported, 2);

    const stream = await fetch(`${restarted.base}/import/${run.jobId}/stream`);
    assert.equal(stream.status, 200);
    const text = await stream.text();
    assert.match(text, /server stopped while this import was running/);
    assert.match(text, /event: end/);

    const retry = await fetch(`${restarted.base}/import/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ album: 'Album' })
    });
    const result = await retry.json();
    assert.equal(retry.status, 202, JSON.stringify(result));
    const retried = await settled(restarted.base, result.job.id);
    assert.equal(retried.status, 'done');
    assert.equal(retried.verification.imported, 2);
  } finally {
    for (const server of servers) {
      server.proc.kill('SIGKILL');
    }
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('an import interrupted by a restart is reported after it, and Undo and retry works', async () => {
  await recoversAfter((server) => server.proc.kill('SIGINT')); // what pm2 reload sends
});

// SIGKILL runs no exit hook, so beets is orphaned and keeps going on its own.
test('a beet orphaned by a server that was killed outright is reaped at the next start', async () => {
  await recoversAfter(async (server) => {
    server.proc.kill('SIGKILL');
  });
});

test('deploy refuses while an import runs, unless forced', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifecycle-'));
  let run;
  try {
    run = await stagedImport(dir, 'hang');
    // Stand-ins for everything the deploy would change; each notes its call.
    const bin = path.join(dir, 'bin');
    const calls = path.join(dir, 'calls');
    await fsp.mkdir(bin);
    for (const tool of ['git', 'npm', 'pm2']) {
      await fsp.writeFile(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${calls}'\n`, { mode: 0o755 });
    }
    const port = new URL(run.server.base).port;
    const deploy = (args) =>
      new Promise((resolve) => {
        const proc = spawn('bash', ['scripts/deploy.sh', ...args], {
          cwd: ROOT,
          env: { ...process.env, PORT: port, PATH: `${bin}:${process.env.PATH}`, FORCE: '' },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        proc.stdout.on('data', (chunk) => (output += chunk));
        proc.stderr.on('data', (chunk) => (output += chunk));
        proc.on('close', (code) => resolve({ code, output }));
      });

    const refused = await deploy([]);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /An import is running for 'Album'/);
    assert.equal(await fsp.readFile(calls, 'utf8').catch(() => ''), '', 'nothing was pulled, built or reloaded');

    const forced = await deploy(['--force']);
    assert.equal(forced.code, 0, forced.output);
    assert.match(await fsp.readFile(calls, 'utf8'), /pm2 reload/);
  } finally {
    run?.server.proc.kill('SIGKILL');
    if (run?.pid && alive(run.pid)) {
      process.kill(-run.pid, 'SIGKILL');
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
