// The fix plan of the public album cleaner (web/): what to offer to change in an
// album, and — given the user's choices — which tags to set or remove on which
// file. Pure logic over a diagnosis; applying it to bytes is the caller's job.
// It answers in codes and values, never in sentences.
//
// Input, besides the report of inspect.js `diagnoseAlbum`: the track records the
// report was made from, each with
//   properties   every tag the file carries, under its TagLib name in capitals
//                (ALBUMARTIST, MUSICBRAINZ_ALBUMID, …), as an array of values.
// TagLib's names are the unit of writing, so the plan is stated in them:
// `set: { NAME: value }` — a string, an array (written as separate values,
// never joined), or null to remove the tag.
//
// A fix is proposed exactly when switching it on would write something, so an
// album that has been through its own plan proposes nothing the second time.

import { albumArtist, foldForIdentity, normalizeReleaseDate, VARIOUS_ARTISTS } from './identity.js';
import { albumBase } from './inspect.js';
import { basename, extname } from './paths.js';
import { normalizeDate, parseNumberPair, leadingTrackNumber } from './tags.js';
import { analyzeText, suggestFilenameFix } from './text.js';

// In an MP4 the release date lives in DATE (the ©day atom); see identity.js.
const MP4_EXTENSIONS = new Set(['.m4a', '.mp4', '.m4b']);
const isMp4 = (track) => MP4_EXTENSIONS.has(extname(track.file).toLowerCase());

const stored = (track, name) => track.properties?.[name] || [];
// '' for a file at the top, otherwise the folder with its trailing slash.
const dirname = (file) => file.slice(0, file.lastIndexOf('/') + 1);
const stem = (file) => basename(file).slice(0, basename(file).length - extname(file).length).toLowerCase();

// The folder every track sits in or under: where a cover.jpg belongs.
function commonDir(files) {
  let dir = files.length ? dirname(files[0]) : '';
  for (const file of files) {
    while (!file.startsWith(dir)) {
      dir = dirname(dir.slice(0, -1));
    }
  }
  return dir;
}

// [{ value, count }], most frequent first; empty values are not counted.
function tally(values) {
  const counts = new Map();
  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

// Record the write only when the file does not already say exactly this.
function put(set, track, name, value) {
  const wanted = value == null ? [] : [value].flat();
  const current = stored(track, name);
  delete set[name];
  if (current.length !== wanted.length || current.some((v, i) => v !== wanted[i])) {
    set[name] = value;
  }
}

// --- Text ---------------------------------------------------------------------

const TEXT_TAGS = ['TITLE', 'ARTIST', 'ALBUM', 'ALBUMARTIST'];

// The confident repair of text.js, or the value as it is.
function clean(value) {
  const issue = analyzeText(value);
  return issue && issue.confident && issue.suggested ? issue.suggested : value;
}

// Value by value, so a tag with several values keeps them apart.
function repairText(track, set) {
  let repaired = 0;
  for (const name of TEXT_TAGS) {
    const values = stored(track, name);
    const next = values.map(clean);
    const changed = next.filter((value, i) => value !== values[i]).length;
    if (changed) {
      set[name] = next.length === 1 ? next[0] : next;
      repaired += changed;
    }
  }
  return repaired;
}

// --- Track numbers --------------------------------------------------------------

const numberOf = (track) => parseNumberPair(track.track).num ?? leadingTrackNumber(track.file);
const byPath = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// The disc of each track, as file -> disc, and whether the discs come from the
// folders. A track's disc is its disc tag (none is disc 1), but when no track
// has one and the tracks sit in folders whose numbering starts over
// (CD1/01…, CD2/01…), each folder is a disc, in path order. Numbering that runs
// on from one folder into the next is one disc. An unreadable file is on the
// disc of the tracks beside it, and on none when no track is.
export function discsOf(tracks) {
  const readable = tracks.filter((track) => track.readable);
  const folders = [...new Set(tracks.map((track) => dirname(track.file)))].sort(byPath);
  let last = 0;
  const runsOn = folders.every((folder) => {
    const numbers = readable.filter((track) => dirname(track.file) === folder).map(numberOf).filter((num) => num != null);
    const ok = numbers.length > 0 && Math.min(...numbers) > last;
    last = Math.max(...numbers);
    return ok;
  });
  const byFolder = folders.length > 1 && !runsOn && !readable.some((track) => parseNumberPair(track.disc).num != null);
  const discs = new Map(
    readable.map((track) => [track.file, byFolder ? folders.indexOf(dirname(track.file)) + 1 : (parseNumberPair(track.disc).num ?? 1)])
  );
  for (const track of tracks.filter((candidate) => !candidate.readable)) {
    const beside = readable.find((other) => dirname(other.file) === dirname(track.file));
    if (beside) {
      discs.set(track.file, discs.get(beside.file));
    }
  }
  return { discs, byFolder };
}

// "n/total" per disc, for the tracks whose number is missing or whose total is
// not the disc's track count — and DISCNUMBER on every track when the discs
// come from the folders. Two kinds of disc keep their numbers, because their
// totals are not what is wrong with them:
//   - one with tracks missing: its total counts the tracks that are not here,
//     and rewriting it to the file count would erase the one trace of them (a
//     track with no number still gets one, under that total);
//   - one where two tracks share a number, from a tag or a file name: nothing
//     says which is which, and numbering both would write the clash in.
// -> { writes: file -> set, unnumbered, duplicated, gaps, discs }: `gaps` as
// the diagnosis reports them, or found per folder; `discs` the folder count
// when the discs are the folders, else 0.
function trackNumbers(report, tracks) {
  const { discs: discOf, byFolder } = discsOf(tracks);
  const discs = new Map();
  for (const track of tracks.filter((candidate) => discOf.has(candidate.file))) {
    const disc = discOf.get(track.file);
    discs.set(disc, [...(discs.get(disc) || []), track]);
  }
  const gaps = byFolder ? [] : report.trackGaps;
  const writes = new Map();
  const write = (file, name, value) => writes.set(file, { ...writes.get(file), [name]: value });
  const unnumbered = [];
  const duplicated = [];

  for (const [disc, members] of [...discs].sort((a, b) => a[0] - b[0])) {
    const readable = members.filter((track) => track.readable);
    if (byFolder) {
      readable.forEach((track) => write(track.file, 'DISCNUMBER', String(disc)));
    }
    const numbers = readable.map(numberOf).filter((num) => num != null);
    if (new Set(numbers).size < numbers.length) {
      duplicated.push(disc);
      continue;
    }
    if (byFolder) {
      const missing = Array.from({ length: Math.max(0, ...numbers) }, (_, i) => i + 1).filter((num) => !numbers.includes(num));
      if (missing.length > 0) {
        gaps.push({ disc, missing });
      }
    }
    const incomplete = gaps.some((gap) => gap.disc === disc);
    const pairs = members.map((track) => parseNumberPair(track.track));
    const totals = [...new Set(pairs.map((pair) => pair.total).filter((total) => total != null))];
    members.forEach((track, i) => {
      if (!track.readable) {
        return;
      }
      const num = numberOf(track);
      if (num == null) {
        unnumbered.push(track.file);
        return;
      }
      if (incomplete) {
        if (pairs[i].num == null) {
          write(track.file, 'TRACKNUMBER', totals.length === 1 ? `${num}/${totals[0]}` : String(num));
        }
        return;
      }
      if (pairs[i].num !== num || pairs[i].total !== members.length) {
        write(track.file, 'TRACKNUMBER', `${num}/${members.length}`);
      }
    });
  }
  return { writes, unnumbered, duplicated, gaps, discs: byFolder ? discs.size : 0 };
}

// --- Release date ---------------------------------------------------------------

// The tag a track's release date is read from, in the reader's own order of
// preference (TDRL is how an ID3v2.3 file shows the frame).
function releaseCarrier(track) {
  const names = ['TDRL', 'RELEASEDATE', ...(isMp4(track) ? ['DATE'] : []), 'YEAR'];
  return names.find((name) => stored(track, name).some((value) => value && normalizeReleaseDate(value))) || null;
}

// Every track ends up with `value` as its release date, each in the tag it
// already keeps one in. A track with none gets DATE in an MP4, and elsewhere
// whichever of RELEASEDATE / YEAR the other tracks use.
function unifyReleaseDate(readable, value, setOf) {
  const carriers = readable.filter((track) => !isMp4(track)).map(releaseCarrier);
  const added = !carriers.includes('TDRL') && !carriers.includes('RELEASEDATE') && carriers.includes('YEAR') ? 'YEAR' : 'RELEASEDATE';
  for (const track of readable) {
    if (normalizeReleaseDate(track.release_date || '') === value) {
      continue;
    }
    const set = setOf(track);
    const carrier = releaseCarrier(track) || (isMp4(track) ? 'DATE' : added);
    if (carrier === 'TDRL') {
      set.TDRL = null;
      set.RELEASEDATE = value;
    } else {
      set[carrier] = value;
    }
  }
}

// The recording dates of the tracks whose DATE is not their release date.
const recordingDates = (readable) => tally(readable.filter((track) => !isMp4(track)).map((track) => track.date));

// --- Album version ----------------------------------------------------------------

const VERSION_TAGS = ['ALBUMVERSION', 'MUSICBRAINZ_ALBUMCOMMENT', 'MUSICBRAINZ ALBUM COMMENT'];

// --- Cover ------------------------------------------------------------------------

// The file names Navidrome takes for the album's cover, best first.
const COVER_NAMES = ['cover', 'folder', 'front', 'album'];

// Where the album's cover comes from, or null when there is none anywhere:
//   { kind: 'user' }              an image the user supplied
//   { kind: 'file', path }        a loose image; `guess` when only its being the
//                                 one image around suggests it is the cover
//   { kind: 'embedded', file }    the picture inside that track
export function chooseCover(report, tracks, context = {}) {
  if (context.hasUserCover) {
    return { kind: 'user' };
  }
  const depth = (file) => file.split('/').length;
  const images = [...report.art.folderImages].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const named = COVER_NAMES.flatMap((name) => images.filter((image) => stem(image) === name))[0];
  if (named) {
    return { kind: 'file', path: named };
  }
  const withArt = tracks.find((track) => track.readable && track.hasFrontCover);
  if (withArt) {
    return { kind: 'embedded', file: withArt.file };
  }
  return images[0] ? { kind: 'file', path: images[0], guess: true } : null;
}

// --- The writes -------------------------------------------------------------------

// What to do to each file, for the fixes that are switched on.
//   fixes     [{ id, on, value? }] — the proposals of planAlbum, as the user
//             left them
//   context   { paths?, hasUserCover? } — every path in the album, so a rename
//             cannot land on a file that is already there
// Returns
//   files     [{ file, set, cover, rename }] for the files with something to do:
//             tags to write, `cover` to embed the album's cover, `rename` the
//             new path
//   addCover  the path of the cover.jpg to add, or null
export function planWrites(report, tracks, fixes, context = {}) {
  const chosen = (id) => fixes.find((fix) => fix.id === id && fix.on);
  const typed = (id) => String(chosen(id)?.value ?? '').trim();
  const readable = tracks.filter((track) => track.readable);
  const files = new Map(tracks.map((track) => [track.file, { file: track.file, set: {}, cover: false, rename: null }]));
  const setOf = (track) => files.get(track.file).set;

  if (chosen('text')) {
    readable.forEach((track) => repairText(track, setOf(track)));
  }
  if (chosen('track_numbers')) {
    for (const [file, set] of trackNumbers(report, tracks).writes) {
      Object.assign(files.get(file).set, set);
    }
  }
  if (typed('date')) {
    const value = normalizeDate(typed('date')) ?? typed('date');
    for (const track of readable.filter((t) => !isMp4(t) && t.date !== value)) {
      setOf(track).DATE = value;
    }
  }
  if (typed('release_date')) {
    unifyReleaseDate(readable, typed('release_date'), setOf);
  }
  if (chosen('album_version')) {
    const value = typed('album_version');
    for (const track of readable.filter((t) => (t.album_version || '') !== value)) {
      if (value) {
        setOf(track).ALBUMVERSION = value;
      } else {
        VERSION_TAGS.filter((name) => stored(track, name).length).forEach((name) => (setOf(track)[name] = null));
      }
    }
  }
  if (typed('mbid')) {
    for (const track of readable.filter((t) => t.musicbrainz_albumid !== typed('mbid'))) {
      setOf(track).MUSICBRAINZ_ALBUMID = typed('mbid');
    }
  }
  // An explicit name wins over the text repair of the same tag.
  if (typed('album_artist')) {
    const value = typed('album_artist');
    // Several album artists are shown joined; written back, they stay several.
    const several = readable
      .map((track) => ({ track, list: [...new Set((track.album_artist_values || []).filter(Boolean))] }))
      .find(({ track, list }) => list.length > 1 && albumArtist(track).name === value);
    readable.forEach((track) => put(setOf(track), track, 'ALBUMARTIST', several ? several.list : value));
  }
  if (typed('album')) {
    readable.forEach((track) => put(setOf(track), track, 'ALBUM', typed('album')));
  }

  if (chosen('filenames')) {
    const paths = context.paths || tracks.map((track) => track.file);
    const taken = new Set(paths);
    // A cue sheet names the audio files it plays, so its folder keeps its names.
    const cued = new Set(paths.filter((path) => extname(path).toLowerCase() === '.cue').map(dirname));
    for (const { file, suggested } of report.filenameIssues.filter((issue) => !cued.has(dirname(issue.file)))) {
      // The other files of the track's name go with it: the lyrics above all,
      // which Navidrome finds by that name.
      const name = basename(file).slice(0, basename(file).length - extname(file).length);
      const renamed = suggested.slice(0, suggested.length - extname(suggested).length);
      const moves = [file, ...paths.filter((path) => !files.has(path) && dirname(path) === dirname(file) && basename(path).startsWith(`${name}.`))].map(
        (path) => [path, dirname(file) + renamed + basename(path).slice(name.length)]
      );
      if (moves.every(([, target]) => !taken.has(target))) {
        for (const [path, target] of moves) {
          taken.add(target);
          files.set(path, { ...(files.get(path) || { file: path, set: {}, cover: false }), rename: target });
        }
      }
    }
  }

  const cover = chooseCover(report, tracks, context);
  // Into the tracks without one; a track's other pictures stay where they are.
  if (cover && chosen('cover_embed')) {
    for (const track of readable) {
      files.get(track.file).cover = !track.hasFrontCover;
    }
  }
  const root = commonDir(tracks.map((track) => track.file));
  const hasRootCover = report.art.folderImages.some((image) => dirname(image) === root && stem(image) === 'cover');

  return {
    files: [...files.values()].filter((entry) => Object.keys(entry.set).length > 0 || entry.cover || entry.rename),
    addCover: cover && chosen('cover_file') && !hasRootCover ? `${root}cover.jpg` : null
  };
}

// --- The proposal -----------------------------------------------------------------

// The values tied for most common, from a tally that is sorted most common first.
const leaders = (distinct) => distinct.filter((entry) => entry.count === distinct[0].count).map((entry) => entry.value);

// Of the dates tied for most common, the most complete: a full date over a
// year and month over a year. A clear majority wins whatever its form.
function likeliestDate(distinct) {
  const completeness = (value) => (normalizeDate(value) ?? '').length;
  return leaders(distinct).sort((a, b) => completeness(b) - completeness(a))[0];
}

// One album whose name carries a trailing marker ("[Explicit]") on some tracks
// only: the spelling most tracks use, and on an exact tie the longer one.
function commonestName(distinct) {
  const spellings = tally(distinct.flatMap((entry) => Array(entry.count).fill(clean(entry.value))));
  return leaders(spellings).sort((a, b) => b.length - a.length)[0];
}

// What the album looks like to Navidrome, what can be fixed, and what cannot.
//   context   { nameGuess?, paths?, hasUserCover? } — `nameGuess` is the folder
//             or archive name, offered as the album name when no track has one
// Returns
//   verdict     { code, albums, tracks, … } — the one thing to say first:
//                 unreadable  no track could be read
//                 split       `albums` albums, told apart by `causes`
//                 merged      would be filed with other music, for `reasons`
//                 no_cover    `missing` tracks carry no picture
//                 tidy        one album, with things to fix
//                 stuck       one album, with only things that cannot be fixed
//                 fine        nothing to do
//   fixes       [{ id, on: true, … }] in the order to show them; `value` is
//               the pre-filled choice, `options` the values to choose from
//   cannotFix   [{ code, … }]
//   cover       chooseCover's answer
export function planAlbum(report, tracks, context = {}) {
  const readable = tracks.filter((track) => track.readable);
  const cover = chooseCover(report, tracks, context);
  const fixes = [];
  // A fix earns its place by having something to write.
  const offer = (fix, always = false) => {
    const { files, addCover } = planWrites(report, tracks, [{ ...fix, on: true }], context);
    if (always || files.length > 0 || addCover) {
      fixes.push({ ...fix, on: true });
    }
    return files;
  };
  const found = (field) => (field.distinct.length > 1 ? field.distinct : []);

  const album = report.fields.album;
  if (readable.length > 0 && (!album.consistent || album.distinct.length === 0)) {
    const guess = album.distinct.length === 0 ? clean(context.nameGuess || '') : '';
    // `apart`: the names differ by more than spacing, letter case or a trailing
    // marker, so these may be different albums rather than one album misnamed.
    const apart = new Set(album.distinct.map((entry) => foldForIdentity(albumBase(entry.value)))).size > 1;
    const proposed = album.variantOnly ? commonestName(album.distinct) : clean(album.proposed);
    // Shown even with nothing to pre-fill: the name has to come from the user.
    offer({ id: 'album', value: proposed || guess, guess: Boolean(guess), apart, found: found(album), missing: album.missing }, true);
  }
  const artist = report.fields.album_artist;
  if (readable.length > 0 && (!artist.consistent || artist.distinct.length === 0)) {
    // No track names an album artist and the track artists differ: a
    // compilation, more likely than an album by whichever artist sorts first.
    const tagged = readable.some((track) => [...(track.album_artist_values || []), ...(track.album_artists_values || [])].some(Boolean));
    const value = !tagged && artist.distinct.length > 1 ? VARIOUS_ARTISTS : clean(artist.proposed);
    offer({ id: 'album_artist', value, found: found(artist), missing: artist.missing }, true);
  }
  const release = report.fields.release_date;
  if (!release.consistent) {
    offer({ id: 'release_date', value: likeliestDate(release.distinct), options: release.distinct.map((entry) => entry.value) });
  }
  const dates = recordingDates(readable);
  if (dates.length > 1) {
    offer({ id: 'date', value: likeliestDate(dates), options: dates.map((entry) => entry.value) });
  }
  const version = report.fields.album_version;
  if (!version.consistent) {
    // Kept when at least as many tracks carry it as carry none.
    const value = version.distinct[0].count >= version.missing ? version.proposed : '';
    offer({ id: 'album_version', value, options: [...version.distinct.map((entry) => entry.value), ''] });
  }
  const mbid = report.fields.musicbrainz_albumid;
  if (!mbid.consistent) {
    offer({
      id: 'mbid',
      value: mbid.proposed,
      ids: mbid.distinct.length,
      count: mbid.distinct[0].count,
      total: readable.length
    });
  }
  const numbers = trackNumbers(report, tracks);
  if (numbers.writes.size > 0) {
    offer({ id: 'track_numbers', count: numbers.writes.size, ...(numbers.discs && { discs: numbers.discs }) });
  }
  const repairs = readable.map((track) => ({ track, set: {} })).map((entry) => ({ ...entry, count: repairText(entry.track, entry.set) }));
  const repaired = repairs.reduce((sum, entry) => sum + entry.count, 0);
  if (repaired > 0) {
    const { track, set } = repairs.find((entry) => entry.count > 0);
    const name = Object.keys(set)[0];
    const index = [set[name]].flat().findIndex((value, i) => value !== stored(track, name)[i]);
    offer({
      id: 'text',
      count: repaired,
      // One repair to show: the damage made visible, and what it becomes.
      sample: { from: analyzeText(stored(track, name)[index]).display, to: [set[name]].flat()[index] }
    });
  }
  if (report.filenameIssues.length > 0) {
    const renames = offer({ id: 'filenames' }).map((entry) => ({ from: entry.file, to: entry.rename }));
    if (renames.length > 0) {
      fixes.at(-1).renames = renames;
    }
  }
  const noArt = readable.filter((track) => !track.hasFrontCover).length;
  if (cover && noArt > 0) {
    offer({ id: 'cover_embed', missing: noArt, total: readable.length });
  }
  if (cover) {
    const { addCover } = planWrites(report, tracks, [{ id: 'cover_file', on: true }], context);
    if (addCover) {
      fixes.push({ id: 'cover_file', on: true, path: addCover });
    }
  }

  const unclear = [...new Set(report.textIssues.filter((issue) => !issue.confident).map((issue) => issue.file))];
  const missing = (field) => report.missingRequired.find((entry) => entry.field === field)?.files || [];
  const cannotFix = [
    { code: 'unreadable', files: report.unreadable },
    { code: 'gaps', discs: numbers.gaps, multiDisc: report.multiDisc || numbers.discs > 0 },
    { code: 'duplicate_numbers', discs: numbers.duplicated, multiDisc: report.multiDisc || numbers.discs > 0 },
    { code: 'no_track_number', files: numbers.unnumbered },
    { code: 'mixed_formats', formats: report.mixedFormats ? report.formats : [] },
    { code: 'mixed_quality', qualities: report.mixedQuality ? report.qualities.map(({ files, ...quality }) => quality) : [] },
    { code: 'no_duration', files: report.noDuration },
    { code: 'unclear_text', files: unclear },
    { code: 'no_title', files: missing('title') },
    { code: 'no_artist', files: missing('artist') },
    { code: 'no_cover', files: cover ? [] : readable.map((track) => track.file) }
  ].filter((entry) => Object.values(entry).some((value) => Array.isArray(value) && value.length > 0));

  const size = { albums: report.groupCount, tracks: readable.length };
  let verdict;
  if (readable.length === 0) {
    verdict = { code: 'unreadable', ...size };
  } else if (report.groupCount > 1) {
    verdict = { code: 'split', causes: report.splitFields, ...size };
  } else if (report.mergeWarnings.length > 0) {
    verdict = { code: 'merged', reasons: report.mergeWarnings.map((warning) => warning.reason), ...size };
  } else if (noArt > 0) {
    verdict = { code: 'no_cover', missing: noArt, ...size };
  } else {
    verdict = { code: fixes.length > 0 ? 'tidy' : cannotFix.length > 0 ? 'stuck' : 'fine', ...size };
  }

  return { verdict, fixes, cannotFix, cover };
}
