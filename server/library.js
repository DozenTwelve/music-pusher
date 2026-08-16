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
import { albumBase } from './metadata/inspect.js';
import { normalizeTagValue } from './metadata/text.js';
import { AUDIO_EXTENSIONS } from '../shared/extensions.js';

// Columns this module reads. Checked on open so a beets schema change fails
// loudly here instead of surfacing as silently empty columns in the UI.
const REQUIRED_COLUMNS = {
  albums: ['id', 'album', 'albumartist', 'year', 'genre', 'artpath'],
  items: [
    'id',
    'album_id',
    'path',
    'title',
    'artist',
    'track',
    'format',
    'samplerate',
    'bitdepth',
    'mb_albumid'
  ]
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

// The high-water mark of beets' item ids, sampled before an import so that
// itemsAddedSince can name exactly what the run added. beets exits 0 having
// imported some, all or none of what it was handed, so the exit code alone says
// nothing about how much arrived.
// `paths` is optional; without it the locations come from beets itself.
export async function maxItemId(paths) {
  const db = await openLibraryDb(paths);
  try {
    return db.prepare('select coalesce(max(id), 0) as n from items').get().n;
  } finally {
    db.close();
  }
}

// The rows an import added, by id and path. Ids rather than a plain count,
// because undoing a partial import has to name the rows it removes — and beets
// picks the imported album's name itself, so there is nothing else to match on.
//
// `title` and `mbAlbumId` come along because counting the rows only answers
// whether the tracks arrived, not whether they arrived usable. These two are
// what separate a corrected import from one beets gave up on and filed as-is.
export async function itemsAddedSince(sinceId, paths) {
  const db = await openLibraryDb(paths);
  try {
    return db
      .prepare('select id, path, title, mb_albumid from items where id > ? order by id')
      .all(sinceId)
      .map((row) => ({
        id: row.id,
        path: toPathBuffer(row.path),
        title: row.title || '',
        mbAlbumId: row.mb_albumid || ''
      }));
  } finally {
    db.close();
  }
}

// The duplicate import is what creates the stale rows repairLibrary cleans up,
// so this is the cheaper end of the same problem. beets accepts an album it
// already holds without complaint: it writes a second album row, and because two
// rows now share albumartist + album, `$album%aunique{}` disambiguates the
// newcomer's folder with its own album id. Every `[8]` / `[57]` suffix in this
// library is that, and when the older copy's files are later replaced its rows
// are stranded.
//
// Matching is on the album *base* name — the same normalization the inspect step
// uses to merge "[Explicit]"-style variants — because a re-download under the
// other variant of the name is exactly how the second copy tends to arrive.
// That normalization is deliberately blunt: albumBase strips *any* trailing
// bracket group, so `Greatest Hits (Deluxe Edition)` matches `Greatest Hits` by
// the same artist, and an album with no album artist at all matches on name
// alone. Both are over-matches by design — every match is reported for the user
// to look at and one press overrides it, so the cost of being wrong is a glance
// while the cost of missing a duplicate is another stranded copy.
//
// Each match carries how many of its files are still on disk. A match with none
// left is a ghost: rows whose album was moved or deleted out from under beets,
// which is precisely the case whose documented repair is to re-import. Blocking
// that would leave the row unfixable, so callers are expected to ignore ghosts.
// `paths` is optional; without it the locations come from beets itself.
export async function findExistingAlbums({ album, albumartist }, paths) {
  const wanted = albumBase(album || '').toLowerCase();
  if (!wanted) {
    return [];
  }
  const wantedArtist = normalizeTagValue(albumartist || '').toLowerCase();

  const db = await openLibraryDb(paths);
  try {
    const matches = db
      .prepare('select id, album, albumartist from albums')
      .all()
      .filter((row) => {
        if (albumBase(String(row.album ?? '')).toLowerCase() !== wanted) {
          return false;
        }
        if (!wantedArtist) {
          return true;
        }
        return normalizeTagValue(String(row.albumartist ?? '')).toLowerCase() === wantedArtist;
      });

    const countFiles = db.prepare('select path from items where album_id = ?');
    return matches.map((row) => {
      const items = countFiles.all(row.id);
      return {
        ...row,
        trackCount: items.length,
        // Buffers, not strings: a decode/re-encode round trip can differ from the
        // real name and would report a present file as missing.
        presentFiles: items.filter((item) => fs.existsSync(toPathBuffer(item.path))).length
      };
    });
  } finally {
    db.close();
  }
}

// beets colours its output when it detects a terminal, and spawning it without
// one is not enough — it still emits SGR codes here. Strip them so the text can
// be rendered and pattern-matched.
function stripAnsi(value) {
  // Anchored on an explicit ESC escape rather than a literal control byte:
  // album names in this library really do contain things like
  // `Ellington Uptown [14]`, and a pattern that starts at the bracket eats them.
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

// The repair is two beets commands, and it needs both.
//
// `beet update` re-reads the on-disk tags of every surviving file into the
// database and drops rows whose file is gone. With `move: yes` in the beets
// config it also relocates files onto the path template — but only the items it
// actually changed. An album whose tags were already correct keeps its old
// folder, which is precisely the album left holding a stale `%aunique{}`
// suffix once the duplicate row it was disambiguating against is deleted.
// Observed: after a full update this library still had four `[N]` folders and
// `beet move --pretend` reported "Moving 45 items (433 already in place)".
//
// `beet move` closes that: it re-renders the template for every item and moves
// what no longer matches. Doing this by hand would mean re-implementing the
// template here and keeping the copy in agreement with beets forever, which is
// the drift this module exists to report.
//
// The tag re-read is the one to remember when anything starts editing the
// library: `beet update` takes the file's tags as the truth, so a change written
// only to the beets database is reverted the next time a repair runs. Library
// edits have to reach the files, which is `beet modify` (it writes tags), not a
// direct database write.
//
// Defaults to a pretend run. `beet update --pretend` prints the identical
// change list and touches nothing, so the preview and the apply can never
// disagree about what is going to happen.
export async function repairLibrary({ pretend = true } = {}, paths) {
  // An absent library directory is indistinguishable, to beets, from every file
  // having been deleted: it would drop the entire database in one pass. The
  // preview shows that, but the preview is one click from the apply, so refuse
  // outright rather than relying on someone reading a 700-line change list.
  if (!pretend) {
    const { libraryDir } = paths || (await beetsPaths());
    if (!fs.existsSync(libraryDir)) {
      throw new Error(
        `The beets library directory '${libraryDir}' does not exist. Refusing to repair: ` +
          'every tracked file would look deleted and the whole database would be dropped.'
      );
    }
  }

  const flag = pretend ? ['--pretend'] : [];
  const sections = [];

  // Order matters: update first, so that the rows whose files are gone are out
  // of the database before move re-renders the path template. Running move
  // first would relocate files to a name that update is about to change.
  for (const command of ['update', 'move']) {
    const args = [command, ...flag];
    const { code, stdout, stderr } = await runProcess(config.beetBin, args);
    if (code !== 0) {
      throw new Error(`'${config.beetBin} ${args.join(' ')}' failed (exit ${code}): ${stderr.trim()}`);
    }
    // beets does not agree with itself about which stream to use: `update`
    // writes its change list to stdout and logs the same lines to stderr, while
    // `move` reports only through the logger, so its stdout is empty. Reading
    // stdout alone silently dropped everything `move` had to say — both the
    // preview text and the moved count. Preferring stdout and falling back to
    // stderr covers both without printing the update list twice.
    // ponytail: a split across both streams in one command would lose the
    // smaller half. Neither of these two does that today.
    const text = stripAnsi(stdout).trim() || stripAnsi(stderr).trim();
    sections.push({ command, text });
  }

  const byCommand = Object.fromEntries(sections.map((s) => [s.command, s.text]));
  return {
    ok: true,
    pretend,
    // ponytail: both counts are scraped from beets' human-readable output, which
    // is not a stable interface. The full text ships alongside them, so a beets
    // format change surfaces as a wrong number next to visibly right output
    // rather than as a silent zero. Move to a parsable `--format` if it misleads.
    deleted: (byCommand.update.match(/^ *deleted$/gm) || []).length,
    moved: Number(byCommand.move.match(/^Moving (\d+) items?/m)?.[1] ?? 0),
    output: sections
      .filter((s) => s.text)
      .map((s) => `$ beet ${s.command}${pretend ? ' --pretend' : ''}\n${s.text}`)
      .join('\n\n')
  };
}

// Reconcile the beets database against the filesystem, in both directions:
// rows whose file is gone, and audio files sitting in the library that beets
// has never seen. Read-only — repairing is `repairLibrary`, above.
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
