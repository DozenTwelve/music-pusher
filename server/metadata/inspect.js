import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ART_EXTENSIONS } from '../upload.js';
import { distinctAudioFormats } from '../../shared/extensions.js';
import { listAudioFiles, probeTags, parseNumberPair } from './probe.js';
import { normalizeTagValue, analyzeText, suggestFilenameFix, TEXT_FIELDS } from './text.js';

// Walk the album tree and collect loose image files (cover.jpg, folder.png, ...).
// These are reported for context but do not count as "has art" — detection is
// embedded-only, so a folder image sitting next to art-less tracks is still a gap.
async function listFolderImages(albumPath) {
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
      if (entry.isFile() && ART_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.relative(albumPath, fullPath));
      }
    }
  }

  found.sort((a, b) => a.localeCompare(b));
  return found;
}

// Tags that, when they disagree between tracks, cause a music library to split
// one album into several. `date` is the usual culprit (per-single release dates),
// followed by album / album_artist text drift.
const GROUPING_FIELDS = ['album', 'album_artist', 'date'];
// ffprobe normalizes container-specific atoms to these lowercase tag keys.
const READ_FIELDS = ['album', 'album_artist', 'date', 'disc', 'track', 'genre'];

// The album-artist a player actually groups by. An explicit album_artist wins;
// with none, the player derives one from each track's artist participants — the
// multi-valued `artists` tag (feat. guests included), else the single `artist`.
// When that derived anchor differs across tracks the album fragments, even
// though `album` and `date` all agree, so grouping must compare THIS, not the
// raw album_artist (which reads uniformly "" and hides the split). Precedence is
// per track: a partially-set album_artist mixes with derived values and still
// flags, which is correct — partial album_artist is itself a split cause.
function albumArtistAnchor(track) {
  return track.album_artist || track.artists || track.artist;
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
      hasArt: Boolean(tags.__has_art),
      title: tags.title || '',
      artist: tags.artist || '',
      artists: tags.artists || '',
      album: tags.album || '',
      album_artist: tags.album_artist || tags.albumartist || '',
      date: tags.date || tags.year || '',
      disc: tags.disc || tags.disk || tags.discnumber || '',
      track: tags.track || tags.tracknumber || ''
    });
  }

  // Grouping compares the effective anchor for album_artist; every other field
  // compares its raw value.
  const groupValue = (t, field) => (field === 'album_artist' ? albumArtistAnchor(t) : t[field]);

  const fields = {};
  for (const field of READ_FIELDS) {
    if (field === 'genre' || field === 'track') {
      continue;
    }
    fields[field] = summarizeField(tracks.map((t) => groupValue(t, field)));
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
    tracks.map((t) => GROUPING_FIELDS.map((f) => groupValue(t, f) || '∅').join(' ¦ '))
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

  // Audio formats present, from the shared extension classifier — the same
  // signal every mixed-format check uses. More than one is a failure: mixed
  // formats cause Navidrome to split the album, and there is no in-place fix
  // (the odd files must be converted or removed).
  const formats = distinctAudioFormats(tracks.map((t) => t.file));
  const mixedFormats = formats.length > 1;

  // Cover art: embedded-only detection. Any track without an embedded picture is
  // a gap. Loose image files are surfaced for context but never count as present.
  const withArt = tracks.filter((t) => t.hasArt).length;
  const art = {
    total: trackCount,
    withArt,
    missing: trackCount - withArt,
    hasMissing: withArt < trackCount,
    folderImages: await listFolderImages(albumPath)
  };

  return {
    ok: true,
    album,
    trackCount,
    groupCount: groupKeys.size,
    splitFields,
    fields,
    formats,
    mixedFormats,
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
    art,
    textIssues,
    filenameIssues,
    tracks
  };
}
