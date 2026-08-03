// Read side of the beets library.
//
// beets remains the only writer: anything that changes the library goes through
// `beet` so the database, the on-disk path templates and the tags stay in
// agreement. Reading, though, goes straight at beets' SQLite file. Two reasons:
// beets' query language has no LIMIT/OFFSET, so there is no way to page a
// growing library through the CLI; and every `beet` invocation pays a fixed
// Python + beets start-up cost that dwarfs the query itself. Direct SQL gives
// real ORDER BY / LIMIT / search at a few milliseconds and keeps that flat as
// the library grows.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, expandHome } from './config.js';
import { runProcess } from './metadata/probe.js';
import { AUDIO_EXTENSIONS } from '../shared/extensions.js';

// Columns this module reads. Checked on open so a beets schema change fails
// loudly here instead of surfacing as silently empty columns in the UI.
const REQUIRED_COLUMNS = {
  albums: ['id', 'album', 'albumartist', 'year', 'genre', 'artpath'],
  items: ['id', 'album_id', 'path', 'title', 'artist', 'track', 'format', 'samplerate', 'bitdepth']
};

// Long lists are truncated in the response — the counts stay exact. A library
// with thousands of stale rows should not turn its own health report into a
// multi-megabyte payload.
const MAX_SAMPLE = 25;

let cachedPaths = null;

// beets knows where its own database and library directory are, so ask it once
// rather than keeping a second copy in .env that drifts the moment the beets
// config changes. `beet config` prints the fully resolved configuration.
// Pull `library:` and `directory:` out of `beet config` output. Both are
// top-level YAML keys, so anchoring at column 0 keeps same-named keys nested
// under a plugin from matching. Values may be quoted and may start with `~`.
export function parseBeetsConfig(stdout) {
  const read = (key) => {
    const match = stdout.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'));
    if (!match) {
      return null;
    }
    return expandHome(match[1].trim().replace(/^['"]|['"]$/g, ''));
  };

  const dbPath = read('library');
  const libraryDir = read('directory');
  if (!dbPath || !libraryDir) {
    throw new Error("Could not read 'library:' and 'directory:' from the beets config.");
  }
  return { dbPath, libraryDir };
}

export async function beetsPaths() {
  if (cachedPaths) {
    return cachedPaths;
  }

  const { code, stdout, stderr } = await runProcess(config.beetBin, ['config']);
  if (code !== 0) {
    throw new Error(`'${config.beetBin} config' failed (exit ${code}): ${stderr.trim()}`);
  }

  cachedPaths = parseBeetsConfig(stdout);
  return cachedPaths;
}

function assertColumns(db, table, required) {
  const present = new Set(db.prepare(`pragma table_info(${table})`).all().map((c) => c.name));
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `beets '${table}' table is missing expected column(s): ${missing.join(', ')}. ` +
        'The beets schema may have changed — library reads are disabled until this is updated.'
    );
  }
}

// Open beets' database read-only. Read-only is not just hygiene: beets owns
// every write, and its journal_mode is `delete`, so a writer takes an exclusive
// lock on the whole file. busy_timeout makes our reads wait out a concurrent
// `beet` run instead of failing with SQLITE_BUSY.
export async function openLibraryDb(paths) {
  const { dbPath } = paths || (await beetsPaths());
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('pragma busy_timeout = 5000');
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      assertColumns(db, table, columns);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

// beets stores paths as raw bytes, not text. Keep them as Buffers for anything
// that touches the filesystem: decoding to a string and back can differ from
// the real name (Unicode normalization, undecodable bytes) and would report a
// perfectly healthy file as missing.
function toPathBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

// Byte-exact key for set comparison — 'latin1' is a lossless byte<->char
// mapping, unlike utf8, which normalizes and replaces invalid sequences.
function pathKey(buffer) {
  return buffer.toString('latin1');
}

// Walk the library directory for audio files, as Buffers so the byte-level
// comparison against the database holds.
async function listLibraryFiles(rootBuffer) {
  const found = [];
  const stack = [rootBuffer];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true, encoding: 'buffer' });
    } catch {
      continue; // unreadable directory: reported via the missing-file side instead
    }
    for (const entry of entries) {
      const full = Buffer.concat([current, Buffer.from('/'), entry.name]);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name.toString()).toLowerCase())) {
        found.push(full);
      }
    }
  }

  return found;
}

// Reconcile the beets database against the filesystem, in both directions:
// rows whose file is gone, and audio files sitting in the library that beets
// has never seen. Read-only — it reports, it does not repair.
// `paths` is optional; without it the locations come from beets itself.
export async function checkLibraryHealth(paths) {
  const resolved = paths || (await beetsPaths());
  const { dbPath, libraryDir } = resolved;
  const db = await openLibraryDb(resolved);

  let rows;
  try {
    rows = db
      .prepare(
        `select i.id, i.album_id, i.path, a.album, a.albumartist
           from items i left join albums a on a.id = i.album_id`
      )
      .all();
  } finally {
    db.close();
  }

  const libraryRoot = Buffer.from(libraryDir.replace(/\/+$/, ''));
  const insideLibrary = (buffer) =>
    buffer.length > libraryRoot.length &&
    buffer.subarray(0, libraryRoot.length).equals(libraryRoot) &&
    buffer[libraryRoot.length] === 0x2f;

  const known = new Set();
  const byAlbum = new Map();
  let missingInside = 0;
  let missingOutside = 0;

  for (const row of rows) {
    const buffer = toPathBuffer(row.path);
    known.add(pathKey(buffer));

    if (fs.existsSync(buffer)) {
      continue;
    }

    // Outside the configured library directory means the row predates a move of
    // `directory:` — the file is not misplaced, its whole tree is gone. Inside
    // means the file was renamed, moved or deleted behind beets' back. The two
    // need different repairs, so they are counted apart.
    const outside = !insideLibrary(buffer);
    if (outside) {
      missingOutside += 1;
    } else {
      missingInside += 1;
    }

    const key = row.album_id ?? `item:${row.id}`;
    if (!byAlbum.has(key)) {
      byAlbum.set(key, {
        albumId: row.album_id ?? null,
        album: row.album || '(no album)',
        albumartist: row.albumartist || '',
        missing: 0,
        outside,
        files: []
      });
    }
    const entry = byAlbum.get(key);
    entry.missing += 1;
    if (entry.files.length < MAX_SAMPLE) {
      entry.files.push(buffer.toString('utf8'));
    }
  }

  // The other direction: audio on disk that no database row points at.
  const onDisk = await listLibraryFiles(libraryRoot);
  const orphans = onDisk.filter((buffer) => !known.has(pathKey(buffer)));

  const albumsAffected = [...byAlbum.values()].sort(
    (a, b) => b.missing - a.missing || a.album.localeCompare(b.album)
  );

  return {
    ok: true,
    dbPath,
    libraryDir,
    totals: {
      items: rows.length,
      filesOnDisk: onDisk.length,
      missing: missingInside + missingOutside,
      missingInside,
      missingOutside,
      albumsAffected: albumsAffected.length,
      orphans: orphans.length
    },
    albums: albumsAffected.slice(0, MAX_SAMPLE),
    albumsTruncated: Math.max(0, albumsAffected.length - MAX_SAMPLE),
    orphans: orphans.slice(0, MAX_SAMPLE).map((buffer) => buffer.toString('utf8')),
    orphansTruncated: Math.max(0, orphans.length - MAX_SAMPLE)
  };
}
