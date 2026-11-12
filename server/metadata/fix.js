import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AUDIO_EXTENSIONS } from '../upload.js';
import { listAudioFiles, probeTags, runProcess, TEMP_PREFIX } from './probe.js';
import { normalizeDate, parseNumberPair, leadingTrackNumber } from '../../shared/tags.js';
import { normalizeReleaseDate } from '../../shared/identity.js';
import { discsOf } from '../../shared/plan.js';
import { analyzeText, suggestFilenameFix, TEXT_FIELDS } from '../../shared/text.js';
import { inspectAlbum } from './inspect.js';
import { withAlbumLock } from './lock.js';

// Fields the UI can unify to a single value across every track.
const UNIFIABLE_FIELDS = ['date', 'album', 'album_artist', 'disc'];

const MP4_EXTENSIONS = new Set(['.m4a', '.aac', '.alac', '.mp4', '.m4b']);
const VORBIS_EXTENSIONS = new Set(['.flac', '.ogg', '.opus']);
// Ogg keeps its Vorbis comments on the audio stream; a FLAC on the container.
const OGG_EXTENSIONS = new Set(['.ogg', '.opus']);

// Vorbis comments (FLAC/OGG/Opus) use conventional uppercase keys. A generic
// key with no Vorbis counterpart in ffmpeg (`title`, `date`, …) would be
// written lowercase, so those are named in uppercase. The three ffmpeg does
// translate — ALBUMARTIST, TRACKNUMBER, DISCNUMBER, which it reads in as
// album_artist, track and disc — must keep their generic names: written as
// ALBUMARTIST, the value goes in next to the one read as album_artist instead
// of replacing it, and the file ends up with both (`ALBUMARTIST=Art ` and
// `ALBUMARTIST=Art`). MP4 and MP3 handle the generic keys correctly, so leave
// them untouched.
const VORBIS_KEY = {
  title: 'TITLE',
  artist: 'ARTIST',
  date: 'DATE',
  album: 'ALBUM'
};

function metadataKeyFor(field, ext) {
  if (VORBIS_EXTENSIONS.has(ext)) {
    return VORBIS_KEY[field] || field;
  }
  return field;
}

// Containers where restoring a missing duration costs nothing but time. A FLAC
// re-encode is bit-exact — verified on the album that prompted this: decoded
// audio md5 identical, file byte-for-byte the same size, embedded art intact.
// A lossy container has no such pass, so it never gets one.
const DURATION_REPAIRABLE = new Set(['.flac']);

// `reencode` re-derives the audio stream instead of copying it. Needed because
// the broken length lives in the FLAC STREAMINFO header, which `-c copy`
// reproduces verbatim: a stream copy leaves total_samples=0 exactly as it found
// it. Only the audio is re-encoded — the attached picture is still copied.
async function rewriteTags(absPath, fields, reencode = false) {
  const ext = path.extname(absPath).toLowerCase();
  const dir = path.dirname(absPath);
  const tmpPath = path.join(dir, `${TEMP_PREFIX}${path.basename(absPath)}`);

  const codecArgs = reencode ? ['-c:a', 'flac', '-c:v', 'copy'] : ['-c', 'copy'];
  const args = ['-v', 'error', '-i', absPath, '-map', '0', ...codecArgs, '-map_metadata', '0'];
  const metadataFlag = OGG_EXTENSIONS.has(ext) ? '-metadata:s:a:0' : '-metadata';
  for (const [field, value] of fields) {
    args.push(metadataFlag, `${metadataKeyFor(field, ext)}=${value}`);
  }
  if (MP4_EXTENSIONS.has(ext)) {
    args.push('-movflags', '+faststart');
  }
  args.push(tmpPath);

  const result = await runProcess(config.ffmpegBin, args);
  if (result.code !== 0) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw new Error(result.stderr.trim() || `ffmpeg exited with code ${result.code}`);
  }
  await fsp.rename(tmpPath, absPath);
}

export async function fixAlbum(album, options = {}) {
  // Shared with cover embeds: both rename temp files over the same tracks, so
  // only one may touch an album at a time.
  return withAlbumLock(album, 'fix_busy', () => runFix(album, options));
}

// Disc and track number for every file, counted per disc. The disc is the one
// the web plan picks (shared/plan.js discsOf): the disc tag, else 1 — or each
// folder in name order when no track has a disc tag and the numbering starts
// over in every folder (CD1/01…, CD2/01…). A disc where two files claim the
// same number keeps the numbers it has: writing them would bake the collision
// into the tags. Those files come back as errors.
function numberTracks(files, scan, albumPath, unifiedDisc) {
  const rel = (absPath) => path.relative(albumPath, absPath);
  const records = files.map((absPath) => {
    const tags = scan.get(absPath);
    return {
      file: rel(absPath),
      readable: Boolean(tags.__ok),
      track: tags.track || tags.tracknumber || '',
      disc: unifiedDisc ?? (tags.disc || tags.disk || tags.discnumber || '')
    };
  });
  const { discs: discOf, byFolder } = discsOf(records);
  const discCount = new Set(discOf.values()).size;

  const meta = new Map();
  const discs = new Map();
  for (const [i, absPath] of files.entries()) {
    const discNum = discOf.get(records[i].file);
    const num = parseNumberPair(records[i].track).num ?? leadingTrackNumber(absPath);
    const entry = { discNum, num: discNum == null ? null : num, discTag: byFolder && discNum != null ? `${discNum}/${discCount}` : null };
    meta.set(absPath, entry);
    if (discNum == null) {
      continue;
    }
    if (!discs.has(discNum)) {
      discs.set(discNum, []);
    }
    discs.get(discNum).push([absPath, entry]);
  }

  const errors = [];
  for (const [discNum, onDisc] of discs) {
    let clash = false;
    for (const [absPath, entry] of onDisc) {
      entry.total = onDisc.length;
      const others = onDisc.filter(([other, e]) => other !== absPath && entry.num != null && e.num === entry.num);
      if (others.length > 0) {
        clash = true;
        errors.push({
          file: rel(absPath),
          message: `track ${entry.num} is also ${others.map(([other]) => rel(other)).join(', ')}; track numbers on disc ${discNum} left as they are`
        });
      }
    }
    if (clash) {
      for (const [, entry] of onDisc) {
        entry.num = null;
      }
    }
  }
  return { meta, errors };
}

// ffmpeg cannot write an m4a's freeform atoms back, so a rewrite loses a
// RELEASEDATE (or YEAR) atom and ©day is the release date from then on. Where
// the release date came from one of those atoms, the rewrite would move it to
// whatever ©day says, so a fix that does not set the date is refused unless
// the two agree. A date the user sets is the release date they asked for, and
// where the release date was ©day already, writing ©day is how it is fixed.
function releaseDateLoss(tags, fields) {
  const sources = [tags.releasedate, tags.date, tags.year];
  const from = sources.findIndex((value) => value && normalizeReleaseDate(value));
  if (from === -1 || from === 1 || fields.some(([field]) => field === 'date')) {
    return null;
  }
  const before = normalizeReleaseDate(sources[from]);
  const after = normalizeReleaseDate(tags.date || '');
  if (after === before) {
    return null;
  }
  return (
    `ffmpeg cannot keep this m4a's ${from === 0 ? 'RELEASEDATE' : 'YEAR'} tag, so the rewrite would move ` +
    `its release date ${before} to ${after || 'nothing'} and could split the album; left as it is`
  );
}

// A total kept in a tag of its own (Vorbis TRACKTOTAL, TOTALTRACKS, …) is
// rewritten along with an "n/total" number, so the two cannot disagree.
const TOTAL_TAGS = { track: ['tracktotal', 'totaltracks'], disc: ['disctotal', 'totaldiscs'] };

function totalFields(tags, fields) {
  return fields.flatMap(([field, value]) => {
    const { total } = parseNumberPair(value);
    return total == null
      ? []
      : (TOTAL_TAGS[field] || []).filter((key) => tags[key] != null).map((key) => [key.toUpperCase(), String(total)]);
  });
}

async function exists(target) {
  return fsp.access(target).then(
    () => true,
    () => false
  );
}

function currentFieldValue(tags, field) {
  if (field === 'album_artist') {
    return tags.album_artist || tags.albumartist || '';
  }
  return tags[field] || '';
}

async function runFix(album, options = {}) {
  const {
    set = {},
    normalizeTracks = false,
    fixFilenames = false,
    repairText = false,
    repairDuration = false
  } = options;
  const albumPath = path.join(config.rawDir, album);
  const files = await listAudioFiles(albumPath);

  if (files.length === 0) {
    return { ok: false, code: 'no_audio_files', message: 'No audio files found in album folder.' };
  }

  // Validate requested unification values.
  const unify = {};
  for (const field of UNIFIABLE_FIELDS) {
    const value = set[field];
    if (typeof value === 'string' && value.trim() !== '') {
      unify[field] = value.trim();
    }
  }
  if (unify.date != null) {
    const iso = normalizeDate(unify.date);
    if (iso == null) {
      return {
        ok: false,
        code: 'bad_date',
        message: `Date “${unify.date}” is not a date beets can read. Use 2026, 2026-05 or 2026-05-29.`
      };
    }
    unify.date = iso;
  }

  const changes = [];
  const errors = [];

  // Disc-aware track normalization and text repair both need the existing tags,
  // so scan every file once up front (also gives each disc's track count).
  const needScan = normalizeTracks || repairText || repairDuration;
  const scan = new Map();
  if (needScan) {
    for (const absPath of files) {
      scan.set(absPath, await probeTags(absPath));
    }
  }

  let trackMeta = null;
  if (normalizeTracks) {
    const numbered = numberTracks(files, scan, albumPath, unify.disc);
    trackMeta = numbered.meta;
    errors.push(...numbered.errors);
  }

  for (const absPath of files) {
    const fields = [];

    for (const [field, value] of Object.entries(unify)) {
      fields.push([field, value]);
    }

    if (normalizeTracks) {
      const meta = trackMeta.get(absPath);
      if (meta.discTag) {
        fields.push(['disc', meta.discTag]);
      }
      if (meta.num != null) {
        fields.push(['track', `${meta.num}/${meta.total}`]);
      }
    }

    if (repairText) {
      const tags = scan.get(absPath);
      for (const field of TEXT_FIELDS) {
        if (unify[field] != null) {
          continue; // an explicit unify value wins over text repair
        }
        const current = currentFieldValue(tags, field);
        const issue = analyzeText(current);
        // Only auto-apply confident reconstructions; ambiguous corruption is
        // reported by inspect for manual handling.
        if (issue && issue.confident && issue.suggested && issue.suggested !== current) {
          fields.push([field, issue.suggested]);
        }
      }
    }

    // A file can need the re-encode with no tag change of its own, so this is
    // checked alongside `fields` rather than after the early-continue below.
    const reencode =
      repairDuration &&
      DURATION_REPAIRABLE.has(path.extname(absPath).toLowerCase()) &&
      !scan.get(absPath).__duration;

    if (fields.length === 0 && !reencode) {
      continue;
    }

    if (fields.length > 0) {
      const tags = scan.get(absPath) ?? (await probeTags(absPath));
      const loss = MP4_EXTENSIONS.has(path.extname(absPath).toLowerCase()) && releaseDateLoss(tags, fields);
      if (loss) {
        errors.push({ file: path.relative(albumPath, absPath), message: loss });
        continue;
      }
      fields.push(...totalFields(tags, fields));
    }

    try {
      await rewriteTags(absPath, fields, reencode);
      changes.push({
        file: path.relative(albumPath, absPath),
        applied: [...fields.map(([k, v]) => `${k}=${v}`), ...(reencode ? ['duration restored'] : [])]
      });
    } catch (error) {
      errors.push({ file: path.relative(albumPath, absPath), message: error.message });
    }
  }

  // A track's lyrics (.lrc) and anything else named after it (`01 x.jpg`,
  // `01 x.en.lrc`) move with it, or the player loses them. A .cue sheet names
  // the files it plays, in whatever encoding its ripper used, so a track with
  // one in its folder keeps its name rather than have the sheet rewritten.
  const renames = [];
  if (fixFilenames) {
    for (const absPath of files) {
      const dir = path.dirname(absPath);
      const base = path.basename(absPath);
      const suggested = suggestFilenameFix(base);
      if (!suggested) {
        continue;
      }
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      const newStem = suggested.slice(0, suggested.length - ext.length);
      try {
        const siblings = await fsp.readdir(dir);
        if (siblings.some((name) => path.extname(name).toLowerCase() === '.cue')) {
          throw new Error('a .cue sheet in its folder may name it');
        }
        const moves = [
          [base, suggested],
          ...siblings
            .filter(
              (name) =>
                name.startsWith(`${stem}.`) &&
                name !== base &&
                !AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())
            )
            .map((name) => [name, newStem + name.slice(stem.length)])
        ];
        // Avoid clobbering an existing file.
        for (const [, to] of moves) {
          if (await exists(path.join(dir, to))) {
            throw new Error(`${to} already exists`);
          }
        }
        for (const [from, to] of moves) {
          await fsp.rename(path.join(dir, from), path.join(dir, to));
          renames.push({
            from: path.relative(albumPath, path.join(dir, from)),
            to: path.relative(albumPath, path.join(dir, to))
          });
        }
      } catch (error) {
        errors.push({ file: path.relative(albumPath, absPath), message: `rename failed: ${error.message}` });
      }
    }
  }

  // Re-run diagnosis so the UI can confirm the album collapsed into one group.
  const after = await inspectAlbum(album);

  return {
    ok: errors.length === 0,
    album,
    applied: { unify, normalizeTracks, fixFilenames, repairText, repairDuration },
    changes,
    renames,
    errors,
    after: after.ok ? after : null
  };
}
