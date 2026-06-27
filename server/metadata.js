import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { AUDIO_EXTENSIONS } from './upload.js';

// Tags that, when they disagree between tracks, cause a music library to split
// one album into several. `date` is the usual culprit (per-single release dates),
// followed by album / album_artist text drift.
const GROUPING_FIELDS = ['album', 'album_artist', 'date'];
// Fields the UI can unify to a single value across every track.
const UNIFIABLE_FIELDS = ['date', 'album', 'album_artist', 'disc'];
// ffprobe normalizes container-specific atoms to these lowercase tag keys.
const READ_FIELDS = ['album', 'album_artist', 'date', 'disc', 'track', 'genre'];

const MP4_EXTENSIONS = new Set(['.m4a', '.aac', '.alac', '.mp4', '.m4b']);
const VORBIS_EXTENSIONS = new Set(['.flac', '.ogg', '.opus']);
// Prefix for the temp file written during an in-place tag rewrite. A crashed
// rewrite can leave one behind; it must never be mistaken for a real track.
const TEMP_PREFIX = '__fix__';

function runProcess(bin, args) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Album folders are usually flat, but cover-art subfolders and disc subfolders
// happen, so walk the whole tree and keep only audio files.
async function listAudioFiles(albumPath) {
  const found = [];
  const stack = [albumPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      // Skip leftover rewrite temp files so a crashed fix never gets counted
      // as a track (or, worse, imported into the library).
      if (entry.name.startsWith(TEMP_PREFIX)) {
        continue;
      }
      if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(fullPath);
      }
    }
  }

  found.sort((a, b) => a.localeCompare(b));
  return found;
}

async function probeTags(absPath) {
  const { code, stdout } = await runProcess(config.ffprobeBin, [
    '-v',
    'error',
    '-show_entries',
    'format=format_name:format_tags',
    '-of',
    'json',
    absPath
  ]);

  const tags = {};
  if (code === 0) {
    try {
      const parsed = JSON.parse(stdout);
      const rawTags = parsed?.format?.tags || {};
      // Tag keys vary in case across muxers; fold to lowercase.
      for (const [key, value] of Object.entries(rawTags)) {
        tags[key.toLowerCase()] = value;
      }
      tags.__format_name = parsed?.format?.format_name || '';
    } catch {
      // leave tags empty on parse failure
    }
  }
  return tags;
}

// "1/8" or "1" -> { num: 1, total: 8|null }
function parseNumberPair(value) {
  if (value == null) {
    return { num: null, total: null };
  }
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
  if (!match) {
    return { num: null, total: null };
  }
  return {
    num: Number.parseInt(match[1], 10),
    total: match[2] ? Number.parseInt(match[2], 10) : null
  };
}

function leadingTrackNumber(fileName) {
  const match = path.basename(fileName).match(/^\s*(\d{1,3})\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}

// Per field, summarize the distinct values and pick the mode (most frequent
// non-empty value) as the proposed unified value.
function summarizeField(values) {
  const counts = new Map();
  let missing = 0;

  for (const raw of values) {
    const value = raw == null ? '' : String(raw);
    if (value === '') {
      missing += 1;
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  const distinct = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  // Consistent = no split risk: one shared value, or the field is uniformly
  // absent (all-empty groups together, so it is not a split cause).
  const consistent = distinct.length === 0 || (distinct.length === 1 && missing === 0);
  const proposed = distinct.length > 0 ? distinct[0].value : '';

  return { distinct, missing, consistent, proposed };
}

// Apostrophe-style filename damage from downloaders, e.g. "Don_t", "It_s",
// "I_m", "you_re". Restrict to known contraction/possessive suffixes so we do
// not touch legitimate underscores.
const APOSTROPHE_PATTERN = /([A-Za-z])_(t|s|m|re|ve|ll|d)\b/g;

function suggestFilenameFix(fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const fixedBase = base.replace(APOSTROPHE_PATTERN, "$1'$2");
  if (fixedBase === base) {
    return null;
  }
  return `${fixedBase}${ext}`;
}

// Control bytes (excluding tab/newline/CR) show up in tags when a downloader
// truncated a Unicode code point to its low byte (e.g. U+2019 ’ -> 0x19). The
// matcher and reconstruction table are written with \u escapes so this source
// file stays free of raw control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const INVISIBLE_RE = /[\u200b-\u200d\ufeff]/g; // zero-width space/joiners + BOM
const NBSP_RE = /\u00a0/g;
// Only the typographic-punctuation family has a confident single-codepoint
// reconstruction. Anything else (U+2606 ☆ -> 0x06, U+221E ∞ -> 0x1E, ...) is
// ambiguous and left for manual review.
const CONTROL_FIX = {
  0x13: '–', // en dash –
  0x14: '—', // em dash —
  0x18: '‘', // left single quote ‘
  0x19: '’', // right single quote / apostrophe ’
  0x1c: '“', // left double quote “
  0x1d: '”' // right double quote ”
};
const TEXT_FIELDS = ['title', 'artist', 'album', 'album_artist'];

// Collapse the spacing/encoding noise that silently splits albums: NBSP,
// zero-width chars, NFC drift, and stray/edge whitespace.
function normalizeTagValue(value) {
  return value
    .normalize('NFC')
    .replace(NBSP_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Return a hygiene report for a tag value, or null when it is clean.
function analyzeText(value) {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  CONTROL_RE.lastIndex = 0;
  const hasControl = CONTROL_RE.test(value);
  const hasInvisible = /[\u200b-\u200d\ufeff\u00a0]/.test(value);
  const hasSpacing = value !== value.trim() || /\s{2,}/.test(value);
  const hasNfc = value !== value.normalize('NFC');

  if (!hasControl && !hasInvisible && !hasSpacing && !hasNfc) {
    return null;
  }

  let confident = true;
  const repaired = value.replace(CONTROL_RE, (ch) => {
    const fix = CONTROL_FIX[ch.charCodeAt(0)];
    if (fix) {
      return fix;
    }
    confident = false;
    return ch; // leave the unknown control char in place
  });

  CONTROL_RE.lastIndex = 0;
  return {
    kind: hasControl ? 'control' : 'whitespace',
    display: value.replace(CONTROL_RE, '·'), // visible placeholder ·
    suggested: normalizeTagValue(repaired),
    confident
  };
}

export async function inspectAlbum(album) {
  const albumPath = path.join(config.rawDir, album);
  const files = await listAudioFiles(albumPath);

  if (files.length === 0) {
    return { ok: false, code: 'no_audio_files', message: 'No audio files found in album folder.' };
  }

  const tracks = [];
  for (const absPath of files) {
    const tags = await probeTags(absPath);
    tracks.push({
      file: path.relative(albumPath, absPath),
      formatName: tags.__format_name || '',
      title: tags.title || '',
      artist: tags.artist || '',
      album: tags.album || '',
      album_artist: tags.album_artist || tags.albumartist || '',
      date: tags.date || tags.year || '',
      disc: tags.disc || tags.disk || tags.discnumber || '',
      track: tags.track || tags.tracknumber || ''
    });
  }

  const fields = {};
  for (const field of READ_FIELDS) {
    if (field === 'genre' || field === 'track') {
      continue;
    }
    fields[field] = summarizeField(tracks.map((t) => t[field]));
  }

  // Disc structure. A genuine multi-disc set legitimately carries >1 disc
  // value, so it must not be treated as a tag inconsistency to "unify".
  const trackCount = tracks.length;
  const discNums = tracks.map((t) => parseNumberPair(t.disc).num);
  const distinctDiscs = [...new Set(discNums.filter((n) => n != null))].sort((a, b) => a - b);
  const missingDisc = discNums.filter((n) => n == null).length;
  const multiDisc = distinctDiscs.length >= 2 && missingDisc === 0;

  // Per-disc track totals (single-disc albums collapse to one group of N).
  const trackPairs = tracks.map((t) => parseNumberPair(t.track));
  const discTrackCounts = new Map();
  discNums.forEach((n) => {
    const key = n ?? 1;
    discTrackCounts.set(key, (discTrackCounts.get(key) || 0) + 1);
  });

  const discList = distinctDiscs.length ? distinctDiscs : [1];
  const numsOnDisc = (d) =>
    tracks
      .map((t, i) => ((discNums[i] ?? 1) === d ? trackPairs[i].num : null))
      .filter((n) => n != null)
      .sort((a, b) => a - b);

  const discs = discList.map((d) => {
    const nums = numsOnDisc(d);
    const contiguous =
      nums.length > 0 && nums[0] === 1 && nums.every((n, k) => k === 0 || n === nums[k - 1] + 1);
    return { disc: d, trackCount: discTrackCounts.get(d) || 0, contiguous };
  });

  if (multiDisc) {
    // Expected to vary — surface the structure, not a "problem".
    fields.disc = { ...fields.disc, consistent: true, proposed: '', multiDisc: true };
  }

  // Some "inconsistencies" are pure spacing/encoding drift: the values become
  // identical after normalization. Flag those and propose the clean form.
  for (const field of GROUPING_FIELDS) {
    const info = fields[field];
    if (info.consistent || info.missing > 0) {
      continue;
    }
    const norms = new Set(info.distinct.map((d) => normalizeTagValue(d.value)));
    if (norms.size === 1) {
      info.whitespaceOnly = true;
      info.proposed = [...norms][0];
    }
  }

  // How many albums would a player create? Distinct combos of grouping fields.
  const groupKeys = new Set(
    tracks.map((t) => GROUPING_FIELDS.map((f) => t[f] || '∅').join(' ¦ '))
  );
  const splitFields = GROUPING_FIELDS.filter((f) => !fields[f].consistent);

  // Track-number health is per disc: numbers present and totals matching the
  // count of their own disc (e.g. 4/10 on disc 1, 8/9 on disc 2).
  const missingTrackNumbers = trackPairs.filter((p) => p.num == null).length;
  const wrongTrackTotals = trackPairs.filter((p, i) => {
    const expectedTotal = discTrackCounts.get(discNums[i] ?? 1);
    return p.total !== expectedTotal;
  }).length;

  // Missing-track detection: gaps in each disc's numbering, plus trailing
  // tracks when a reliable per-disc total is known. The cumulative-total case
  // (same total on every disc, equal to the file count) is not trustworthy for
  // a trailing check, so skip it there.
  const trackGaps = [];
  for (const d of discList) {
    const nums = numsOnDisc(d);
    if (nums.length === 0) {
      continue;
    }
    const present = new Set(nums);
    const maxNum = nums[nums.length - 1];
    const missing = [];
    for (let n = 1; n <= maxNum; n += 1) {
      if (!present.has(n)) {
        missing.push(n);
      }
    }
    const totals = tracks
      .map((t, i) => ((discNums[i] ?? 1) === d ? trackPairs[i].total : null))
      .filter((x) => x != null);
    const declared = totals.length > 0 && totals.every((x) => x === totals[0]) ? totals[0] : null;
    const cumulativeLooking = multiDisc && declared === trackCount;
    if (declared != null && !cumulativeLooking && declared > maxNum) {
      for (let n = maxNum + 1; n <= declared; n += 1) {
        missing.push(n);
      }
    }
    if (missing.length > 0) {
      trackGaps.push({ disc: d, missing });
    }
  }

  // Tag text hygiene: control-char corruption and invisible/whitespace noise.
  const textIssues = [];
  for (const track of tracks) {
    for (const field of TEXT_FIELDS) {
      const issue = analyzeText(track[field]);
      if (issue) {
        textIssues.push({ file: track.file, field, ...issue });
      }
    }
  }

  const filenameIssues = [];
  for (const track of tracks) {
    const suggested = suggestFilenameFix(path.basename(track.file));
    if (suggested) {
      filenameIssues.push({ file: track.file, suggested });
    }
  }

  // Formats present (lossless vs lossy) — informational; mixed sources are a
  // common reason tag drift creeps in, even though format itself rarely splits.
  const formats = [...new Set(tracks.map((t) => t.formatName).filter(Boolean))];

  return {
    ok: true,
    album,
    trackCount,
    groupCount: groupKeys.size,
    splitFields,
    fields,
    formats,
    multiDisc,
    discs,
    track: {
      count: trackCount,
      missingNumbers: missingTrackNumbers,
      wrongTotals: wrongTrackTotals,
      needsNormalize: missingTrackNumbers > 0 || wrongTrackTotals > 0
    },
    trackGaps,
    incomplete: trackGaps.length > 0,
    textIssues,
    filenameIssues,
    tracks
  };
}

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

// Albums with a fix in progress. Concurrent rewrites of the same album would
// race on the shared temp file, so reject overlapping requests.
const fixesInFlight = new Set();

export async function fixAlbum(album, options = {}) {
  if (fixesInFlight.has(album)) {
    return { ok: false, code: 'fix_busy', message: `A fix is already running for album '${album}'.` };
  }

  fixesInFlight.add(album);
  try {
    return await runFix(album, options);
  } finally {
    fixesInFlight.delete(album);
  }
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
