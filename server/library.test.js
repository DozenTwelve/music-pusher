import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  checkLibraryHealth,
  parseBeetsConfig,
  findExistingAlbums,
  repairLibrary,
  maxItemId,
  itemsAddedSince
} from './library.js';

// Trimmed from the real `beet config` output on the deployment box (beets
// 2.5.1). The nested `directory:` under a plugin is the trap: only the
// column-0 keys are the library's own.
const BEET_CONFIG = `directory: /home/yzr/Music/Library
library: ~/.config/beets/musiclibrary.db
import:
    write: yes
    move: yes
fetchart:
    directory: /somewhere/else
plugins: fetchart embedart lastgenre chroma web
`;

test('beets config parsing takes the top-level keys, not a plugin\'s', () => {
  const { dbPath, libraryDir } = parseBeetsConfig(BEET_CONFIG);
  assert.equal(libraryDir, '/home/yzr/Music/Library');
  assert.equal(dbPath, path.join(os.homedir(), '.config/beets/musiclibrary.db'), '~ is expanded');
});

test('beets config parsing fails loudly when a key is absent', () => {
  assert.throws(() => parseBeetsConfig('plugins: web\n'), /Could not read/);
});

// A stand-in for beets' database: only the columns library.js declares it reads.
async function buildLibrary(tracks) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beetslib-'));
  const libraryDir = path.join(root, 'Library');
  const dbPath = path.join(root, 'musiclibrary.db');
  await fsp.mkdir(libraryDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`create table albums (id integer primary key, album text, albumartist text,
             year integer, genre text, artpath blob)`);
  db.exec(`create table items (id integer primary key, album_id integer, path blob, title text,
             artist text, track integer, format text, samplerate integer, bitdepth integer,
             mb_albumid text)`);
  db.prepare('insert into albums (id, album, albumartist, year) values (1, ?, ?, 2020)').run(
    'Test Album',
    'Test Artist'
  );

  const insert = db.prepare('insert into items (id, album_id, path, title) values (?, 1, ?, ?)');
  let id = 0;
  for (const track of tracks) {
    id += 1;
    const absolute = path.join(track.outside ? path.join(root, 'OldLibrary') : libraryDir, track.file);
    insert.run(id, Buffer.from(absolute), track.file);
    if (track.onDisk) {
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, 'x');
    }
  }
  db.close();

  return { root, paths: { dbPath, libraryDir } };
}

test('health check counts missing files and splits them by location', async () => {
  const { root, paths } = await buildLibrary([
    { file: '01.flac', onDisk: true },
    { file: '02.flac', onDisk: false }, // deleted behind beets' back
    { file: '03.flac', onDisk: false, outside: true }, // predates a directory: move
    { file: '04.flac', onDisk: true, outside: true } // outside but still present
  ]);

  try {
    const health = await checkLibraryHealth(paths);

    assert.equal(health.totals.items, 4);
    assert.equal(health.totals.missing, 2);
    assert.equal(health.totals.missingInside, 1, 'gone from the current library folder');
    assert.equal(health.totals.missingOutside, 1, 'whole tree gone with the old directory:');
    assert.equal(health.totals.albumsAffected, 1);
    assert.equal(health.albums[0].missing, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('health check finds audio on disk that beets does not know', async () => {
  const { root, paths } = await buildLibrary([{ file: '01.flac', onDisk: true }]);

  try {
    await fsp.writeFile(path.join(paths.libraryDir, 'stray.mp3'), 'x');
    // A non-audio sidecar must never count as an orphan.
    await fsp.writeFile(path.join(paths.libraryDir, 'cover.jpg'), 'x');

    const health = await checkLibraryHealth(paths);

    assert.equal(health.totals.orphans, 1);
    assert.match(health.orphans[0], /stray\.mp3$/);
    assert.equal(health.totals.filesOnDisk, 2, 'the tracked track plus the stray one');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a clean library reports nothing to fix', async () => {
  const { root, paths } = await buildLibrary([
    { file: '01.flac', onDisk: true },
    { file: 'disc2/02.flac', onDisk: true }
  ]);

  try {
    const health = await checkLibraryHealth(paths);
    assert.equal(health.totals.missing, 0);
    assert.equal(health.totals.orphans, 0);
    assert.deepEqual(health.albums, []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// Only the albums table matters here, so build it directly rather than dragging
// in buildLibrary's item/disk machinery.
async function buildAlbums(rows) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beetsdup-'));
  const dbPath = path.join(root, 'musiclibrary.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`create table albums (id integer primary key, album text, albumartist text,
             year integer, genre text, artpath blob)`);
  db.exec(`create table items (id integer primary key, album_id integer, path blob, title text,
             artist text, track integer, format text, samplerate integer, bitdepth integer,
             mb_albumid text)`);
  const insertAlbum = db.prepare('insert into albums (id, album, albumartist) values (?, ?, ?)');
  const insertItem = db.prepare(
    'insert into items (id, album_id, path, title, mb_albumid) values (?, ?, ?, ?, ?)'
  );

  let itemId = 0;
  for (const [index, row] of rows.entries()) {
    const albumId = index + 1;
    insertAlbum.run(albumId, row.album, row.albumartist);
    // Default to one track that exists: the common case is an album whose files
    // are really there, and `onDisk: false` is how a ghost is spelled.
    for (let n = 0; n < (row.tracks ?? 1); n += 1) {
      itemId += 1;
      const file = path.join(root, `${albumId}-${n}.flac`);
      // `untitled` is how an album beets could not match is spelled: it lands
      // complete and carries nothing that says which release it is.
      insertItem.run(
        itemId,
        albumId,
        Buffer.from(file),
        row.untitled ? '' : `track ${n}`,
        row.mbAlbumId ?? ''
      );
      if (row.onDisk !== false) {
        await fsp.writeFile(file, 'x');
      }
    }
  }
  db.close();
  return { root, paths: { dbPath, libraryDir: root } };
}

test('a re-download under the other name variant still matches the album beets has', async () => {
  const { root, paths } = await buildAlbums([
    { album: 'The Scholars', albumartist: 'Car Seat Headrest' },
    { album: 'Ellington Uptown', albumartist: 'Duke Ellington' }
  ]);

  try {
    // The real duplicates in this library arrived exactly like this: the same
    // album re-downloaded with a trailing "[Explicit]" marker, which beets then
    // filed as a second album and disambiguated with its album id.
    const variant = await findExistingAlbums(
      { album: 'The Scholars [Explicit]', albumartist: 'Car Seat Headrest' },
      paths
    );
    assert.equal(variant.length, 1);
    assert.equal(variant[0].album, 'The Scholars');

    const spaced = await findExistingAlbums(
      { album: '  the   scholars ', albumartist: 'car seat headrest' },
      paths
    );
    assert.equal(spaced.length, 1, 'case and whitespace drift is not a different album');

    const otherArtist = await findExistingAlbums(
      { album: 'The Scholars', albumartist: 'Someone Else' },
      paths
    );
    assert.deepEqual(otherArtist, [], 'same album name under a different artist is not a duplicate');

    const unknown = await findExistingAlbums({ album: 'Not In The Library' }, paths);
    assert.deepEqual(unknown, []);

    const nameless = await findExistingAlbums({ album: '' }, paths);
    assert.deepEqual(nameless, [], 'no album name means nothing to match on, not everything');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// The rows /library/health calls "missing, outside the library" are repaired by
// re-importing. If a duplicate match counted those, the guard would refuse the
// one action that fixes them and the row could never be cleared.
test('a match whose files are all gone is reported as a ghost, not a live copy', async () => {
  const { root, paths } = await buildAlbums([
    { album: 'Quarks', albumartist: 'Timothée Robert', tracks: 3, onDisk: false },
    { album: 'Modal Soul', albumartist: 'Nujabes', tracks: 2 }
  ]);

  try {
    const [ghost] = await findExistingAlbums(
      { album: 'Quarks', albumartist: 'Timothée Robert' },
      paths
    );
    assert.equal(ghost.trackCount, 3);
    assert.equal(ghost.presentFiles, 0, 'nothing left on disk — re-import is the repair');

    const [live] = await findExistingAlbums({ album: 'Modal Soul', albumartist: 'Nujabes' }, paths);
    assert.equal(live.presentFiles, 2, 'a real copy still blocks');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// beets cannot tell an unmounted library from one whose every file was deleted;
// it would answer by dropping the whole database.
test('applying a repair refuses when the library directory is not there', async () => {
  const { root, paths } = await buildAlbums([{ album: 'Modal Soul', albumartist: 'Nujabes' }]);

  try {
    await assert.rejects(
      repairLibrary({ pretend: false }, { ...paths, libraryDir: path.join(root, 'not-mounted') }),
      /does not exist. Refusing to repair/
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// The import verification compares these two against the number of files handed
// to beets, and a retry removes exactly the rows itemsAddedSince names. Getting
// either wrong turns a healthy import into a "partial" one, or — worse — points
// a removal at rows the import did not create.
test('the added rows are the ones past the high-water mark, and nothing else', async () => {
  const { root, paths } = await buildAlbums([
    { album: 'Modal Soul', albumartist: 'Nujabes', tracks: 14 },
    // Rows, not files: a row whose file is gone is still a row, which is what
    // keeps the before/after comparison equal to what an import actually added.
    { album: 'Quarks', albumartist: 'Timothée Robert', tracks: 11, onDisk: false }
  ]);

  try {
    const high = await maxItemId(paths);
    assert.equal(high, 25, 'ids are dense in the fixture, so the max is the count');

    assert.deepEqual(await itemsAddedSince(high, paths), [], 'nothing added yet');

    const added = await itemsAddedSince(20, paths);
    assert.deepEqual(
      added.map((row) => row.id),
      [21, 22, 23, 24, 25]
    );
    assert.ok(Buffer.isBuffer(added[0].path), 'paths stay Buffers for filesystem use');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// The two counts that separate a corrected import from one beets gave up on and
// filed as-is. Both runs exit 0 and add every track they were handed, so the row
// count cannot tell them apart and the post-import check reads these instead.
test('an import beets could not match is visible in the rows it added', async () => {
  const { root, paths } = await buildAlbums([
    { album: 'Lighthouse', albumartist: 'Francis of Delirium', tracks: 2, mbAlbumId: 'abc' },
    { album: 'Run, Run Pure Beauty', albumartist: 'Francis of Delirium', tracks: 3, untitled: true }
  ]);

  try {
    const matchedAlbum = (await itemsAddedSince(0, paths)).slice(0, 2);
    assert.ok(
      matchedAlbum.every((row) => row.title !== '' && row.mbAlbumId !== ''),
      'a matched import carries both'
    );

    const asIs = await itemsAddedSince(2, paths);
    assert.equal(asIs.filter((row) => row.title.trim() === '').length, 3, 'every track untitled');
    assert.ok(
      asIs.every((row) => row.mbAlbumId === ''),
      'and no release id, which is what makes it an as-is import rather than a bad match'
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a beets schema without the columns we read fails loudly', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beetslib-bad-'));
  try {
    const dbPath = path.join(root, 'musiclibrary.db');
    const db = new DatabaseSync(dbPath);
    db.exec('create table albums (id integer primary key)');
    db.exec('create table items (id integer primary key)');
    db.close();

    await assert.rejects(
      checkLibraryHealth({ dbPath, libraryDir: root }),
      /missing expected column/,
      'silently empty columns in the UI would be far worse than an error here'
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
