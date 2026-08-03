import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireAlbum, releaseAlbum, withAlbumLock } from './lock.js';

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
