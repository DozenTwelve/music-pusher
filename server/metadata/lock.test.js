import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireAlbum,
  releaseAlbum,
  withAlbumLock,
  acquireLibrary,
  releaseLibrary
} from './lock.js';

test('the lock excludes a second holder and frees on release', () => {
  assert.equal(acquireAlbum('a'), true);
  assert.equal(acquireAlbum('a'), false);
  assert.equal(acquireAlbum('b'), true, 'a different album is not blocked');
  releaseAlbum('a');
  assert.equal(acquireAlbum('a'), true);
  releaseAlbum('a');
  releaseAlbum('b');
});

test('withAlbumLock releases even when the task throws', async () => {
  await assert.rejects(
    withAlbumLock('c', 'busy', () => {
      throw new Error('boom');
    }),
    /boom/
  );
  // A leak here strands the album: every later fix, cover embed and import on
  // it would report "busy" until the process restarts.
  assert.equal(acquireAlbum('c'), true);
  releaseAlbum('c');
});

// `beet update` moves files across every album at once, so the two locks have to
// exclude each other both ways. One direction holding and the other not would
// let a repair rename the exact file a fix is renaming its temp file over.
test('the library lock and the album locks exclude each other in both directions', () => {
  assert.equal(acquireAlbum('e'), true);
  assert.equal(acquireLibrary(), false, 'a repair must not start while an album is in flight');
  releaseAlbum('e');

  assert.equal(acquireLibrary(), true);
  assert.equal(acquireLibrary(), false, 'and not twice');
  assert.equal(acquireAlbum('e'), false, 'no album may start while a repair is running');
  releaseLibrary();

  assert.equal(acquireAlbum('e'), true);
  releaseAlbum('e');
});

test('withAlbumLock reports busy instead of running the task', async () => {
  assert.equal(acquireAlbum('d'), true);
  let ran = false;
  const result = await withAlbumLock('d', 'fix_busy', () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(result.code, 'fix_busy');
  releaseAlbum('d');
});
