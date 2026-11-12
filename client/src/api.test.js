import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import { uploadAlbum } from './api.js';

// uploadAlbum fans one folder out over several POSTs. When one of them fails it
// cleans up after the others — and that cleanup is a DELETE of whole albums, so
// it must only ever reach an album this upload brought into being. Pinned
// against a stand-in server that records what the client asked it to delete.

let server;
let staged; // what GET /api/albums reports before the upload
let failListing;
let deleted;
let posts;

before(async () => {
  server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/albums') {
        if (failListing) {
          reply(500, { ok: false });
        } else {
          reply(200, { ok: true, albums: staged.map((album) => ({ album })) });
        }
      } else if (req.method === 'POST' && req.url === '/api/upload') {
        posts += 1;
        // One bin of the fan-out fails; the others land in both albums.
        if (posts === 2) {
          reply(500, { ok: false, code: 'upload_failed', message: 'disk full' });
        } else {
          reply(200, { ok: true, albums: ['Old', 'New'], acceptedCount: 1 });
        }
      } else if (req.method === 'DELETE') {
        deleted.push(decodeURIComponent(req.url.replace('/api/albums/', '')));
        reply(200, { ok: true });
      } else {
        reply(404, { ok: false });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  axios.defaults.baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  staged = [];
  failListing = false;
  deleted = [];
  posts = 0;
});

const entries = ['Old/01.flac', 'Old/02.flac', 'New/01.flac', 'New/02.flac'].map((path) => ({
  path,
  file: new File(['x'.repeat(10)], path.split('/').pop())
}));

test('a failed upload removes only the albums it created', async () => {
  staged = ['Old'];
  await assert.rejects(uploadAlbum(entries, null), /500/);
  assert.deepEqual(deleted, ['New'], 'the album that was already staged is left alone');
});

test('when what was already staged is unknown, a failed upload deletes nothing', async () => {
  failListing = true;
  await assert.rejects(uploadAlbum(entries, null), /500/);
  assert.deepEqual(deleted, []);
});
