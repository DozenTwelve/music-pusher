import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { apiRouter, safe } from './routes.js';

// Express 4 hands a rejected promise from an async handler to nobody: it is an
// unhandled rejection, and Node exits on those. One bad MusicBrainz reply was
// enough to stop the server that way.

test('a handler that rejects answers 500 instead of rejecting into the void', async () => {
  const app = express();
  app.get('/boom', safe(async () => {
    throw new Error('boom');
  }));
  app.get('/sync', safe(() => {
    throw new Error('sync boom');
  }));
  app.use((error, req, res, next) => res.status(500).json({ message: error.message }));

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [route, message] of [['/boom', 'boom'], ['/sync', 'sync boom']]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 500);
      assert.equal((await response.json()).message, message);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
    await new Promise((resolve) => server.close(resolve));
  }
});

// Checked on the router itself rather than route by route, so a route added
// later cannot forget it.
test('every API handler goes through the wrapper', () => {
  const handlers = apiRouter.stack.flatMap((layer) =>
    layer.route ? layer.route.stack.map((inner) => inner.handle) : [layer.handle]
  );
  assert.ok(handlers.length > 10);
  for (const handle of handlers) {
    assert.equal(handle.name, 'safeHandler');
  }
});
