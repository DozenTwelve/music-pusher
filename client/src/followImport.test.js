import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import { followImport } from './api.js';

// The import log stream used to be closed for good on its first error and the
// import marked failed — while the server, which had only blipped, or was
// restarting, carried on with it. followImport is what the panel follows a job
// with now; pinned against a stand-in EventSource and a stand-in GET.

let server;
let jobStatus; // what GET /api/import/:id answers: a status code, or 'down'

before(async () => {
  server = http.createServer((req, res) => {
    if (jobStatus === 'down') {
      req.socket.destroy();
      return;
    }
    res.writeHead(jobStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jobStatus === 200 ? { ok: true, job: { status: 'running' } } : { ok: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  axios.defaults.baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

let sources;
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    sources.push(this);
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  close() {
    this.closed = true;
  }
  emit(name, payload) {
    this.listeners[name]?.({ data: JSON.stringify(payload) });
  }
  fail() {
    this.onerror?.();
  }
}

beforeEach(() => {
  sources = [];
  jobStatus = 200;
});

function follow() {
  const seen = { resets: 0, logs: [], ends: [] };
  const stop = followImport(
    'job-1',
    {
      onReset: () => {
        seen.resets += 1;
        seen.logs = [];
      },
      onLog: (entry) => seen.logs.push(entry.line),
      onEnd: (payload) => seen.ends.push(payload)
    },
    { EventSourceImpl: FakeEventSource, retryMs: 10 }
  );
  return { seen, stop };
}

async function until(check) {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'condition never held');
}

test('a dropped stream is reopened, not reported as a failed import', async () => {
  const { seen, stop } = follow();
  sources[0].emit('log', { line: 'one' });
  sources[0].fail();
  assert.equal(sources[0].closed, true);
  assert.deepEqual(seen.ends, [], 'a blip is not the end of the import');

  await until(() => sources.length === 2);
  assert.equal(sources[1].url, '/api/import/job-1/stream');
  // The server replays the whole log on a new stream, so the old copy goes.
  sources[1].emit('log', { line: 'one' });
  sources[1].emit('log', { line: 'two' });
  assert.deepEqual(seen.logs, ['one', 'two']);
  sources[1].emit('end', { status: 'done' });
  assert.deepEqual(seen.ends, [{ status: 'done' }]);
  assert.equal(sources[1].closed, true);
  stop();
});

test('while the server is down it keeps checking, and picks the job up when it is back', async () => {
  jobStatus = 'down';
  const { seen, stop } = follow();
  sources[0].fail();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sources.length, 1, 'no stream reopened while the server does not answer');
  assert.deepEqual(seen.ends, []);

  jobStatus = 200;
  await until(() => sources.length === 2);
  sources[1].emit('end', { status: 'partial' });
  assert.deepEqual(seen.ends, [{ status: 'partial' }]);
  stop();
});

test('a job the server no longer knows ends as lost', async () => {
  jobStatus = 404;
  const { seen } = follow();
  sources[0].fail();
  await until(() => seen.ends.length === 1);
  assert.equal(seen.ends[0].status, 'failed');
  assert.equal(seen.ends[0].lost, true);
});

test('stop closes the stream and ends the checking', async () => {
  const { seen, stop } = follow();
  sources[0].fail();
  stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sources.length, 1);
  assert.deepEqual(seen.ends, []);
});
