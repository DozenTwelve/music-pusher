import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { basename, extname } from './paths.js';

// The helpers replaced node:path calls in code that already ran in production,
// so the bar is not "sensible" but "the same answer node:path gave". POSIX
// flavour on purpose: that is what the deployment runs, and it keeps this test
// meaning the same thing on any machine.
const posix = path.posix;

const TRICKY = [
  // no extension
  'README',
  'Track',
  '01 Song',
  // ordinary
  '01 Song.flac',
  'cover.JPG',
  // leading dot
  '.hidden',
  '.hidden.flac',
  '.DS_Store',
  '.',
  '..',
  '...',
  '..flac',
  // trailing dot
  'Song.',
  'Song..',
  '.Song.',
  'Vol. 1.',
  // multiple dots
  'archive.tar.gz',
  'Mr. Blue Sky.flac',
  '01. Intro (feat. X).m4a',
  'a.b.c.d.e',
  'Song..flac',
  // unicode
  '空洞です.flac',
  '01 ゆらゆら帝国 - 空洞です',
  'Café del Mar.mp3',
  'Björk – Jóga.flac',
  '🎵.ogg',
  '.空洞',
  `Don${String.fromCharCode(0x2019)}t Stop.flac`,
  // spaces, and a backslash, which POSIX reads as an ordinary character
  ' leading space.flac',
  'trailing space .flac',
  'AC\\DC.flac',
  'dir\\file.flac',
  // nested subfolders
  'CD1/01 Song.flac',
  'CD1/01 Song',
  'Disc 2/Bonus/03. Live.flac',
  'scans/Back.PNG',
  'a/b/c/.hidden',
  'a/b/c/.hidden.txt',
  // a dot in the folder must not be read as the file's extension
  'v1.0/README',
  'Vol. 2/Track',
  'Album.flac/01',
  'a.b/.c',
  'a.b/c.',
  '../sibling/01.flac',
  './01.flac',
  '/data/RAW/Some Album/CD1/07 Song.flac',
  '/01.flac',
  'a//b.flac',
  ''
];

test('basename agrees with node:path on tricky file names', () => {
  for (const name of TRICKY) {
    assert.equal(basename(name), posix.basename(name), JSON.stringify(name));
  }
});

test('extname agrees with node:path on tricky file names', () => {
  for (const name of TRICKY) {
    assert.equal(extname(name), posix.extname(name), JSON.stringify(name));
  }
});

test('basename and extname agree with node:path on every short path there is', () => {
  // Every string of up to six characters over an alphabet with a letter, a dot,
  // a separator and a space — all the shapes dots and slashes can take, not just
  // the ones someone thought to list. Paths ending in "/" are folders and are
  // outside what the helpers promise.
  const alphabet = ['a', '.', '/', ' '];
  let names = [''];
  let checked = 0;
  for (let length = 1; length <= 6; length += 1) {
    names = names.flatMap((prefix) => alphabet.map((ch) => prefix + ch));
    for (const name of names) {
      if (name.endsWith('/')) {
        continue;
      }
      assert.equal(basename(name), posix.basename(name), JSON.stringify(name));
      assert.equal(extname(name), posix.extname(name), JSON.stringify(name));
      checked += 1;
    }
  }
  assert.equal(checked, 4095);
});

test('a non-string is refused, as node:path refuses it', () => {
  for (const value of [null, undefined, 7]) {
    assert.throws(() => basename(value), TypeError);
    assert.throws(() => extname(value), TypeError);
    assert.throws(() => posix.basename(value), TypeError);
    assert.throws(() => posix.extname(value), TypeError);
  }
});
