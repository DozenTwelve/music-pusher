import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDate } from './fix.js';

test('normalizeDate accepts the separators a person types', () => {
  // The one that started this: typed into the fix form, written verbatim by
  // ffmpeg, then discarded by beets as DATE=0000.
  assert.equal(normalizeDate('2026.5.29'), '2026-05-29');
  assert.equal(normalizeDate('2026/5/29'), '2026-05-29');
  assert.equal(normalizeDate('2026-5-29'), '2026-05-29');
  assert.equal(normalizeDate(' 2026-05-29 '), '2026-05-29');
});

test('normalizeDate keeps a partial date partial', () => {
  assert.equal(normalizeDate('2026'), '2026');
  assert.equal(normalizeDate('2026-05'), '2026-05');
  assert.equal(normalizeDate('2026.5'), '2026-05');
});

test('normalizeDate rejects what beets would discard', () => {
  assert.equal(normalizeDate('26-05-29'), null); // two-digit year
  assert.equal(normalizeDate('2026-13-01'), null); // no such month
  assert.equal(normalizeDate('2026-05-32'), null); // no such day
  assert.equal(normalizeDate('May 2026'), null);
  assert.equal(normalizeDate('20260529'), null);
  assert.equal(normalizeDate(''), null);
});
