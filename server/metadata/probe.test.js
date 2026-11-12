import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './probe.js';

// A tool that never exits used to hold its caller forever: a fix, a cover
// embed, `beet remove` in a retry, a library repair — each under a lock nothing
// else could then take until the server restarted.

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a process that hangs is killed at its timeout, with whatever it started', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'probe-'));
  const pidFile = path.join(dir, 'child');
  try {
    const started = Date.now();
    const result = await runProcess('sh', ['-c', `sleep 30 & echo $! > '${pidFile}'; echo hello; wait`], {
      timeoutMs: 300
    });
    assert.ok(Date.now() - started < 5000, 'resolved at the timeout, not when sleep finished');
    assert.notEqual(result.code, 0);
    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /hello/);
    assert.match(result.stderr, /timed out/);
    const child = Number(await fsp.readFile(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(child), false, 'the grandchild died with it');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a process that ignores SIGTERM is SIGKILLed after the grace period', async () => {
  const started = Date.now();
  const result = await runProcess('sh', ['-c', 'trap "" TERM; sleep 30'], { timeoutMs: 200, graceMs: 200 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.timedOut, true);
});

test('a descendant that ignores SIGTERM and lets go of the pipes is still killed', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'probe-'));
  const pidFile = path.join(dir, 'child');
  try {
    const result = await runProcess(
      'sh',
      ['-c', `(trap "" TERM; exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; sleep 30`],
      { timeoutMs: 200, graceMs: 200 }
    );
    assert.equal(result.timedOut, true);
    const child = Number(await fsp.readFile(pidFile, 'utf8'));
    for (let i = 0; i < 40 && alive(child); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive(child), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a process that finishes in time is untouched', async () => {
  const result = await runProcess('sh', ['-c', 'echo out; echo err >&2; exit 3'], { timeoutMs: 5000 });
  assert.deepEqual(result, { code: 3, stdout: 'out\n', stderr: 'err\n' });
});

test('a binary that cannot be launched is reported, not thrown', async () => {
  const result = await runProcess('/nonexistent/tool', []);
  assert.equal(result.code, -1);
  assert.match(result.stderr, /ENOENT/);
});
