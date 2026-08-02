import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumBase } from './inspect.js';

test('albumBase strips trailing bracket markers so variants match', () => {
  const base = 'The Scholars';
  assert.equal(albumBase('The Scholars [Explicit]'), base);
  assert.equal(albumBase('The Scholars'), base);
  assert.equal(albumBase('The Scholars (Deluxe Edition)'), base);
  assert.equal(albumBase('The Scholars (Deluxe) [Explicit]'), base); // multiple trailing groups
  assert.equal(albumBase('The Scholars [Explicit] '), base); // trailing space
});

test('albumBase keeps a mid-name bracket (not a trailing marker)', () => {
  assert.equal(albumBase('Album [Live] Sessions'), 'Album [Live] Sessions');
});
