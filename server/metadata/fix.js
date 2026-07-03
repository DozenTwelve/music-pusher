import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  listAudioFiles,
  probeTags,
  parseNumberPair,
  leadingTrackNumber,
  runProcess,
  TEMP_PREFIX
} from './probe.js';
import { analyzeText, suggestFilenameFix, TEXT_FIELDS } from './text.js';
import { inspectAlbum } from './inspect.js';
import { withAlbumLock } from './lock.js';

// Fields the UI can unify to a single value across every track.
const UNIFIABLE_FIELDS = ['date', 'album', 'album_artist', 'disc'];

const MP4_EXTENSIONS = new Set(['.m4a', '.aac', '.alac', '.mp4', '.m4b']);
const VORBIS_EXTENSIONS = new Set(['.flac', '.ogg', '.opus']);

// Vorbis comments (FLAC/OGG/Opus) use conventional uppercase keys. ffmpeg's
// generic keys get written verbatim and many players then miss them, so map to
// the standard names for those containers. MP4 and MP3 handle the generic keys
// correctly, so leave them untouched.
const VORBIS_KEY = {
  title: 'TITLE',
  artist: 'ARTIST',
  date: 'DATE',
  album: 'ALBUM',
  album_artist: 'ALBUMARTIST',
  disc: 'DISCNUMBER',
  track: 'TRACKNUMBER'
};

function metadataKeyFor(field, ext) {
  if (VORBIS_EXTENSIONS.has(ext)) {
    return VORBIS_KEY[field] || field;
  }
  return field;
}

async function rewriteTags(absPath, fields) {
  const ext = path.extname(absPath).toLowerCase();
  const dir = path.dirname(absPath);
  const tmpPath = path.join(dir, `${TEMP_PREFIX}${path.basename(absPath)}`);

  const args = ['-v', 'error', '-i', absPath, '-map', '0', '-c', 'copy', '-map_metadata', '0'];
  for (const [field, value] of fields) {
    args.push('-metadata', `${metadataKeyFor(field, ext)}=${value}`);
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

function currentFieldValue(tags, field) {
  if (field === 'album_artist') {
    return tags.album_artist || tags.albumartist || '';
  }
  return tags[field] || '';
}

async function runFix(album, options = {}) {
  const { set = {}, normalizeTracks = false, fixFilenames = false, repairText = false } = options;
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

  const changes = [];
  const errors = [];

  // Disc-aware track normalization and text repair both need the existing tags,
  // so scan every file once up front (also gives each disc's track count).
  const needScan = normalizeTracks || repairText;
  const scan = new Map();
  if (needScan) {
    for (const absPath of files) {
      scan.set(absPath, await probeTags(absPath));
    }
  }

  let trackMeta = null;
  if (normalizeTracks) {
    trackMeta = new Map();
    const discCounts = new Map();
    for (const absPath of files) {
      const tags = scan.get(absPath);
      const discNum = parseNumberPair(tags.disc || tags.disk || tags.discnumber).num ?? 1;
      const num = parseNumberPair(tags.track || tags.tracknumber).num ?? leadingTrackNumber(absPath);
      trackMeta.set(absPath, { discNum, num });
      discCounts.set(discNum, (discCounts.get(discNum) || 0) + 1);
    }
    for (const meta of trackMeta.values()) {
      meta.total = discCounts.get(meta.discNum);
    }
  }

  for (const absPath of files) {
    const fields = [];

    for (const [field, value] of Object.entries(unify)) {
      fields.push([field, value]);
    }

    if (normalizeTracks) {
      const meta = trackMeta.get(absPath);
      if (meta && meta.num != null) {
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

    if (fields.length === 0) {
      continue;
    }

    try {
      await rewriteTags(absPath, fields);
      changes.push({
        file: path.relative(albumPath, absPath),
        applied: fields.map(([k, v]) => `${k}=${v}`)
      });
    } catch (error) {
      errors.push({ file: path.relative(albumPath, absPath), message: error.message });
    }
  }

  const renames = [];
  if (fixFilenames) {
    for (const absPath of files) {
      const dir = path.dirname(absPath);
      const base = path.basename(absPath);
      const suggested = suggestFilenameFix(base);
      if (!suggested) {
        continue;
      }
      const target = path.join(dir, suggested);
      try {
        // Avoid clobbering an existing file.
        await fsp.access(target).then(
          () => {
            throw new Error('target already exists');
          },
          () => {}
        );
        await fsp.rename(absPath, target);
        renames.push({ from: path.relative(albumPath, absPath), to: path.relative(albumPath, target) });
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
    applied: { unify, normalizeTracks, fixFilenames, repairText },
    changes,
    renames,
    errors,
    after: after.ok ? after : null
  };
}
