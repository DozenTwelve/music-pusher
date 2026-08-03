import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkLibraryHealth, parseBeetsConfig } from './library.js';

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
             artist text, track integer, format text, samplerate integer, bitdepth integer)`);
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
