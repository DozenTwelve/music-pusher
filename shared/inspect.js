// The album diagnosis: what is wrong with a set of tracks, worked out from their
// tags alone. Reading the tags is the caller's job (ffprobe on the server), so
// this module stays free of I/O and runs anywhere extensions.js does.

import { distinctAudioFormats } from './extensions.js';
import { albumIdentity } from './identity.js';
import { basename, extname } from './paths.js';
import { parseNumberPair } from './tags.js';
import { normalizeTagValue, analyzeText, suggestFilenameFix, TEXT_FIELDS } from './text.js';

// What splits an album is Navidrome's album identity (identity.js): the
// MusicBrainz album id when a track has one, otherwise album artist, album,
// album version and release date together. These are the names `splitFields`
// reports a differing ingredient under.
const IDENTITY_PARTS = ['album', 'album_artist', 'release_date', 'album_version', 'musicbrainz_albumid'];
// The two of those whose values the Fix form can unify, and so the two that get
// a proposed value when they differ only by spacing or a trailing marker.
const NAME_FIELDS = ['album', 'album_artist'];
// Summarized per field for the report. `date` is the recording date: it is not
// part of the identity — tracks that disagree on it stay one album, whose date
// then shows blank — so it is shown and unifiable, never a split cause. (In an
// m4a the one ©day atom is both this and the release date.)
const READ_FIELDS = ['album', 'album_artist', 'date', 'disc', 'track', 'genre'];
// Tags every track needs on its own, which is a different question from the
// cross-track agreement READ_FIELDS asks about. An album whose tracks all lack a
// title is perfectly consistent and splits into nothing, so every check above
// passes it — and it still reaches the library as a column of blank names, which
// is what `空洞です` did with eight of its ten tracks.
const REQUIRED_FIELDS = ['title', 'artist'];

// Strip trailing bracketed markers ("[Explicit]", "(Deluxe Edition)", …) and
// normalize, yielding the album's base name. Amazon/Lucida singles tag some
// tracks with the marker and some without, so the same album arrives under two
// names and splits — comparing the base tells us they are one album.
export function albumBase(value) {
  let base = normalizeTagValue(String(value ?? ''));
  let previous;
  do {
    previous = base;
    base = base.replace(/\s*[[(][^\][()]*[\])]\s*$/, '').trim();
  } while (base !== previous);
  return base;
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

export function diagnoseAlbum(album, tracks, folderImages) {
  // A file ffprobe cannot read (truncated download, wrong extension on a
  // non-audio file) comes back with no tags at all. Treating that as "every tag
  // is empty" invents a grouping value and an audio quality the file never had,
  // which then surfaces as a phantom split with no fixable cause — and no tag
  // rewrite can repair it, because ffmpeg cannot read the file either. So every
  // tag-derived signal runs on the readable tracks; the broken files are
  // reported separately as the thing they actually are.
  const readable = tracks.filter((t) => t.readable);
  const unreadable = tracks.filter((t) => !t.readable).map((t) => t.file);

  const identities = readable.map(albumIdentity);
  // Tracks with a MusicBrainz album id are grouped by it alone; the other four
  // ingredients only ever separate the tracks that have none.
  const byTags = (id) => !id.parts.musicbrainz_albumid;

  // The album artist shown is the one Navidrome settles on — an explicit tag,
  // else "Various Artists" for a compilation, else the track's first artist —
  // as it would display it, so the proposal stays a name a person can read and
  // search with. A track with nothing to go on counts as missing rather than as
  // a value called "[Unknown Artist]". Every other field shows its raw value.
  const shownValue = (t, i, field) =>
    field === 'album_artist' ? (identities[i].unknownArtist ? '' : identities[i].albumArtist) : t[field];

  const fields = {};
  for (const field of READ_FIELDS) {
    if (field === 'genre' || field === 'track') {
      continue;
    }
    fields[field] = summarizeField(readable.map((t, i) => shownValue(t, i, field)));
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
  for (const field of NAME_FIELDS) {
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

  // Album-name variants (same album with/without a trailing "[Explicit]"-style
  // marker) are one album. Propose the most descriptive form — the longest
  // normalized value keeps the marker — so the merge is correct no matter which
  // variant happens to be the majority.
  const albumInfo = fields.album;
  if (albumInfo && !albumInfo.consistent && albumInfo.missing === 0 && !albumInfo.whitespaceOnly) {
    const bases = new Set(albumInfo.distinct.map((d) => albumBase(d.value)));
    if (bases.size === 1 && [...bases][0] !== '') {
      albumInfo.variantOnly = true;
      albumInfo.proposed = albumInfo.distinct
        .map((d) => d.value)
        .sort((a, b) => normalizeTagValue(b).length - normalizeTagValue(a).length || a.localeCompare(b))[0];
    }
  }

  // The identity's other ingredients, as they are compared: the release date
  // normalized, the id only when it is a valid UUID. Reported so a split on one
  // of them can show the values behind it; nothing here is unifiable yet.
  for (const part of ['release_date', 'album_version', 'musicbrainz_albumid']) {
    fields[part] = summarizeField(identities.map((id) => id.parts[part]));
  }
  // Whether unifying `date` would also unify the release date: true when every
  // track that is grouped by its tags keeps the two in one tag (an m4a's ©day).
  const tagged = readable.filter((t, i) => byTags(identities[i]));
  fields.release_date.followsDate = tagged.length > 0 && tagged.every((t) => Boolean(t.release_date_follows_date));

  // How many albums would Navidrome make of these tracks, and which ingredients
  // of the identity tell them apart. Values that differ only in what the
  // comparison ignores — letter case, curly quotes — leave `fields.album`
  // inconsistent and unifiable but are not a cause, and neither is any
  // difference between tracks that share a MusicBrainz album id.
  const groupKeys = new Set(identities.map((id) => id.key));
  const differs = (ids, part) => new Set(ids.map((id) => id.parts[part])).size > 1;
  const splitFields = IDENTITY_PARTS.filter((part) =>
    differs(part === 'musicbrainz_albumid' ? identities : identities.filter(byTags), part)
  );

  // The opposite risk: tracks Navidrome would file together with music that is
  // not this album. A track with no album tag joins "[Unknown Album]" along with
  // every other untagged track by the same artist, wherever it sits on disk; a
  // track with no artist of any kind lands under "[Unknown Artist]". A
  // MusicBrainz album id spares a track both.
  const filesWhere = (test) =>
    readable.filter((t, i) => byTags(identities[i]) && test(identities[i])).map((t) => t.file);
  const mergeWarnings = [
    { reason: 'no_album', files: filesWhere((id) => id.unknownAlbum) },
    { reason: 'unknown_artist', files: filesWhere((id) => id.unknownArtist) }
  ].filter((entry) => entry.files.length > 0);

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

  // Tracks whose length is unreadable. Repairable, but only by re-encoding, so
  // it is reported apart from the tag problems the Fix step handles with a
  // metadata-only pass — and only for the containers where re-encoding is
  // lossless. Anything else would have to be traded for quality, which this app
  // will not do behind the user's back.
  const noDuration = readable.filter((t) => !t.duration).map((t) => t.file);
  const durationRepairable = noDuration.filter((f) => extname(f).toLowerCase() === '.flac');

  // Per-track presence of the fields a player has nothing to show without.
  // Reported, deliberately not a blocker: beets now autotags, so the usual cure
  // for a missing title is the import itself, and refusing it would leave the
  // album stuck in RAW with the one thing that could fill the gap locked behind
  // the refusal. `artist` counts as present when the multi-valued `artists`
  // carries it.
  const requiredValue = (t, field) => (field === 'artist' ? t.artist || t.artists : t[field]);
  const missingRequired = REQUIRED_FIELDS.map((field) => ({
    field,
    files: readable.filter((t) => !requiredValue(t, field)).map((t) => t.file)
  })).filter((entry) => entry.files.length > 0);

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
    const suggested = suggestFilenameFix(basename(track.file));
    if (suggested) {
      filenameIssues.push({ file: track.file, suggested });
    }
  }

  // Audio formats present, from the shared extension classifier — the same
  // signal every mixed-format check uses. More than one is a warning, not a
  // failure: it does not reliably split the album (4ec2764 downgraded it after
  // mixed-format albums imported fine), and no tag rewrite repairs it either
  // way — the odd files have to be converted or removed.
  const formats = distinctAudioFormats(tracks.map((t) => t.file));
  const mixedFormats = formats.length > 1;

  // Mixed audio quality: identical container/extension but differing sample rate
  // or bit depth (e.g. a 16-bit/44.1kHz single dropped into a 24-bit/96kHz
  // album). Reported at the same warning level as mixed formats, and for the
  // same reason: it may split the album, it is not confirmed to always do so,
  // and no tag edit repairs it — the odd tracks must be re-downloaded at the
  // album's quality or the album resampled to one spec.
  const qualityCounts = new Map();
  for (const t of readable) {
    const key = `${t.sampleRate ?? '?'}/${t.bitDepth ?? '?'}`;
    if (!qualityCounts.has(key)) {
      qualityCounts.set(key, { sampleRate: t.sampleRate, bitDepth: t.bitDepth, count: 0, files: [] });
    }
    const entry = qualityCounts.get(key);
    entry.count += 1;
    entry.files.push(t.file);
  }
  const qualities = [...qualityCounts.values()].sort((a, b) => b.count - a.count);
  const mixedQuality = qualities.length > 1;

  // Cover art: embedded-only detection. Any track without an embedded picture is
  // a gap. Loose image files are surfaced for context but never count as present.
  const withArt = tracks.filter((t) => t.hasArt).length;
  const art = {
    total: trackCount,
    withArt,
    missing: trackCount - withArt,
    hasMissing: withArt < trackCount,
    folderImages
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
    qualities,
    mixedQuality,
    unreadable,
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
    missingRequired,
    mergeWarnings,
    noDuration,
    durationRepairable,
    art,
    textIssues,
    filenameIssues,
    tracks
  };
}
