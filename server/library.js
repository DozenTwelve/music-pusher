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
import { withAlbumLock } from './metadata/lock.js';
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

function unKey(key) {
  return Buffer.from(key, 'latin1');
}

// path.dirname/basename on the raw bytes. Decoding to a string first would
// normalize the very names this module keeps as Buffers to avoid normalizing.
function dirnameBuffer(buffer) {
  const cut = buffer.lastIndexOf(0x2f);
  return cut <= 0 ? Buffer.from('/') : buffer.subarray(0, cut);
}

function basenameBuffer(buffer) {
  return buffer.subarray(buffer.lastIndexOf(0x2f) + 1);
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

// Every album beets holds, with the two counts that say whether the import that
// created it actually corrected anything. Until now the app could only see what
// was staged in RAW, so a library album was invisible to it — which is why 48 of
// the 50 albums in the deployment's library carry no release id and nothing in
// the app could say so.
//
// `dir` is the folder its files live in, or null when they are spread across
// several. Restaging moves one folder, so a null is what makes an album
// ineligible for it, and the caller shows that rather than offering a button
// that would refuse.
export async function listLibraryAlbums(paths) {
  const resolved = paths || (await beetsPaths());
  const db = await openLibraryDb(resolved);

  let rows;
  try {
    rows = db
      .prepare(
        `select a.id, a.album, a.albumartist, i.path, i.title, i.mb_albumid
           from albums a join items i on i.album_id = a.id
          order by a.id`
      )
      .all();
  } finally {
    db.close();
  }

  const byId = new Map();
  for (const row of rows) {
    let entry = byId.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        album: row.album || '',
        albumartist: row.albumartist || '',
        tracks: 0,
        untitled: 0,
        matched: false,
        dirs: new Set()
      };
      byId.set(row.id, entry);
    }
    entry.tracks += 1;
    if ((row.title || '').trim() === '') {
      entry.untitled += 1;
    }
    if ((row.mb_albumid || '') !== '') {
      entry.matched = true;
    }
    entry.dirs.add(pathKey(dirnameBuffer(toPathBuffer(row.path))));
  }

  return [...byId.values()].map(({ dirs, ...rest }) => ({
    ...rest,
    dir: dirs.size === 1 ? unKey([...dirs][0]).toString('utf8') : null
  }));
}

// Move an album out of the library and back into RAW, so the ordinary
// analyze → fix → pick a release → import path can be run over it again.
//
// This is the one step that was missing. Everything else the app does already
// operates on RAW, so correcting an album that had already been imported meant
// doing it by hand over SSH — `beet remove` without `-d`, move the folder,
// import again with the release named. With the files back in RAW, nothing else
// has to change: inspect, fix, the release picker and the import all work on
// them unchanged.
//
// Ordered so that no failure can lose audio. The rows go first and without
// `-d`, so the files survive every outcome: if the move then fails they are left
// in the library directory with no rows, which is exactly the orphan case
// checkLibraryHealth already reports. Moving first would instead leave rows
// pointing at files that had moved out from under them.
export async function restageAlbum(albumId, paths) {
  const resolved = paths || (await beetsPaths());
  const db = await openLibraryDb(resolved);

  let meta;
  let rows;
  try {
    meta = db.prepare('select id, album, albumartist from albums where id = ?').get(albumId);
    rows = db.prepare('select id, path from items where album_id = ? order by id').all(albumId);
  } finally {
    db.close();
  }

  if (!meta) {
    return { ok: false, code: 'no_such_album', message: `No album with id ${albumId} in the beets library.` };
  }
  if (rows.length === 0) {
    return { ok: false, code: 'no_tracks', message: `Album '${meta.album}' has no tracks to restage.` };
  }

  const files = rows.map((row) => toPathBuffer(row.path));
  const dirs = new Set(files.map((buffer) => pathKey(dirnameBuffer(buffer))));
  if (dirs.size !== 1) {
    return {
      ok: false,
      code: 'scattered',
      message:
        `'${meta.album}' has files in ${dirs.size} directories. Restaging moves a single folder, ` +
        'so this one needs sorting out by hand first.'
    };
  }

  const sourceDir = unKey([...dirs][0]);
  const wanted = new Set(files.map((buffer) => pathKey(basenameBuffer(buffer))));

  // Moving the folder takes everything in it, so refuse if it holds audio this
  // album does not own. The path template gives every album its own folder, but
  // that is a config this app does not control, and the cost of being wrong is
  // dragging a second album out of the library behind the user's back.
  let entries;
  try {
    entries = await fsp.readdir(sourceDir, { withFileTypes: true, encoding: 'buffer' });
  } catch (error) {
    return {
      ok: false,
      code: 'unreadable',
      message: `Could not read '${sourceDir.toString('utf8')}': ${error.message}`
    };
  }
  const foreign = entries.filter(
    (entry) =>
      entry.isFile() &&
      AUDIO_EXTENSIONS.has(path.extname(entry.name.toString('utf8')).toLowerCase()) &&
      !wanted.has(pathKey(entry.name))
  );
  if (foreign.length > 0) {
    return {
      ok: false,
      code: 'shared_folder',
      message:
        `'${sourceDir.toString('utf8')}' also holds ${foreign.length} audio file(s) belonging to ` +
        'another album. Restaging would move those too, so it is refused.'
    };
  }

  const folderName = path.basename(sourceDir.toString('utf8'));
  const destination = path.join(config.rawDir, folderName);
  if (fs.existsSync(destination)) {
    return {
      ok: false,
      code: 'raw_exists',
      message: `RAW already has a folder named '${folderName}'. Import or remove it first.`
    };
  }

  return withAlbumLock(folderName, 'restage_busy', async () => {
    // `id:1 , id:2 , …` — a comma is beets' OR between query terms. Without
    // `-d` this drops the rows and leaves every file where it is.
    const args = ['remove', '-f'];
    rows.forEach((row, index) => {
      if (index > 0) {
        args.push(',');
      }
      args.push(`id:${row.id}`);
    });
    const { code, stderr } = await runProcess(config.beetBin, args);
    if (code !== 0) {
      return {
        ok: false,
        code: 'remove_failed',
        message: `'beet remove' failed (exit ${code}): ${stderr.trim()}`
      };
    }

    await fsp.mkdir(config.rawDir, { recursive: true });
    try {
      await fsp.rename(sourceDir, destination);
    } catch (error) {
      // ponytail: rename only, so RAW and the library must share a filesystem.
      // They do in every layout this app documents; a copy+delete fallback can
      // come the day one of them is a separate mount.
      return {
        ok: false,
        code: 'move_failed',
        message:
          `Rows for '${meta.album}' were removed but the files could not be moved: ${error.message}. ` +
          'They are still in the library folder, and /library/health will report them as orphans.'
      };
    }

    // The artist folder is left behind empty when that was its last album.
    await fsp.rmdir(dirnameBuffer(sourceDir)).catch(() => {});

    return {
      ok: true,
      album: folderName,
      albumTitle: meta.album,
      albumartist: meta.albumartist || '',
      tracks: rows.length,
      from: sourceDir.toString('utf8'),
      to: destination
    };
  });
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
