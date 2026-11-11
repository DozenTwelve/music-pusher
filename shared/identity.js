// Which album Navidrome files a track under. Navidrome is what finally reads
// the files, so its rule — not beets' album + album artist — decides whether an
// album arrives split, or merged into something else. This is the default rule
// (the `PID.Album` setting left alone), written from its documented behaviour
// and checked against a Navidrome 0.63.2 scan of the albums in
// navidrome.groundtruth.js. Dependency-free, like the rest of shared/.
//
// The identity is the first of these that has a value:
//   1. MUSICBRAINZ_ALBUMID, when it is a valid UUID;
//   2. album artist + album + album version + release date, together.
// The folder is no part of it.
//
// A track record feeds it through these fields (the readers fill them):
//   album                  the album name
//   album_artist_values    every ALBUMARTIST value
//   album_artists_values   every ALBUMARTISTS value
//   artist_values          every ARTIST value
//   artists_values         every ARTISTS value
//   compilation            the compilation flag as stored ("1")
//   musicbrainz_albumid    as stored; validity is judged here
//   album_version          ALBUMVERSION, else MUSICBRAINZ_ALBUMCOMMENT
//   release_date           as stored; normalized here
// A record without the value lists (a hand-built one) falls back to the single
// `album_artist` / `artist` / `artists` strings.

export const UNKNOWN_ARTIST = '[Unknown Artist]';
export const VARIOUS_ARTISTS = 'Various Artists';

// Several ALBUMARTIST values make one album artist, joined like this.
const ARTIST_JOINER = ' • ';

// A lone ARTIST value is cut at these, whatever their letter case. Never
// applied to ARTISTS, to ALBUMARTIST, or to an ARTIST tag with several values.
const ARTIST_SEPARATORS = / \/ | feat\. | feat | ft\. | ft |; /i;

// Typographic quotes and dashes compare equal to their ASCII form.
const SINGLE_QUOTES = /[‘’‛′]/g;
const DOUBLE_QUOTES = /[＂〃ˮײ᳓″‶˶ʺ“”˝‟]/g;
const DASHES = /[‐–—−―]/g;

// How album and album artist are compared: letter case and the characters
// above are ignored, and nothing else is. An NBSP, a trailing space, or the
// same letters in NFC and NFD all make a different album.
// ponytail: JS lowercasing, which differs from Navidrome's on a handful of
// letters (a word-final Greek sigma, the Turkish dotted capital I). Two tracks
// would have to differ in case on exactly those to be misjudged; a per-code-
// point simple-case table is the upgrade if that ever shows up.
export function foldForIdentity(value) {
  return value.toLowerCase().replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(DASHES, '-');
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^(?:(?:urn:uuid:)?${UUID}|\\{${UUID}\\}|[0-9a-f]{32})$`, 'i');

// An id that is not a UUID counts as no id at all.
export function isUuid(value) {
  return UUID_RE.test(value);
}

function isCalendarDate(text) {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] == null ? 1 : Number(match[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

// A release date as it is compared: "" when it holds no year; the year alone
// for a four-character value; otherwise its first ten characters when those are
// a real YYYY-MM-DD or YYYY-MM, and the year when they are not. So `2020` and
// `2020-05-01` are different dates, and `2020-05-01T10:00` is `2020-05-01`.
export function normalizeReleaseDate(value) {
  if (value.length < 4) {
    return '';
  }
  const year = /[12]\d{3}/.exec(value)?.[0];
  if (!year) {
    return '';
  }
  if (value.length === 4) {
    return year;
  }
  const cut = value.slice(0, 10);
  return isCalendarDate(cut) ? cut : year;
}

// For the readers: of the tags that can hold a release date, in order of
// preference, the first whose value has a year in it. Returned as stored.
export function firstReleaseDate(values) {
  return values.find((value) => value && normalizeReleaseDate(value)) || '';
}

// The flag is set by "1" or a spelling of true; "yes" and "0" leave it unset.
function isSet(flag) {
  return ['1', 't', 'T', 'true', 'TRUE', 'True'].includes(flag);
}

// Empty values and repeats of a value do not count.
function values(track, list, single) {
  const found = track[list] ?? (track[single] ? [track[single]] : []);
  return [...new Set(found.filter(Boolean))];
}

// The first of a track's artists: the first ARTISTS value when the tag exists;
// otherwise a lone ARTIST value cut at the separators, or the first of several
// taken whole.
function firstArtist(track) {
  const [first] = values(track, 'artists_values', 'artists');
  if (first) {
    return first;
  }
  const artist = values(track, 'artist_values', 'artist');
  if (artist.length !== 1) {
    return artist[0] || '';
  }
  return artist[0].split(ARTIST_SEPARATORS).map((part) => part.trim()).find(Boolean) || '';
}

// The album artist, by the first source that has one. `unknown` marks a track
// with nothing to go on, which lands under "[Unknown Artist]".
export function albumArtist(track) {
  const name =
    values(track, 'album_artist_values', 'album_artist').join(ARTIST_JOINER) ||
    values(track, 'album_artists_values').join(ARTIST_JOINER) ||
    (isSet(track.compilation || '') ? VARIOUS_ARTISTS : firstArtist(track));
  return { name: name || UNKNOWN_ARTIST, unknown: !name };
}

// The identity of the album a track belongs to. Two tracks are one album
// exactly when their `key`s are equal. `parts` holds each ingredient as it is
// compared, so a caller can say which one differs; when the MusicBrainz id is
// set it alone is the identity and the other four are not consulted.
export function albumIdentity(track) {
  const artist = albumArtist(track);
  const id = track.musicbrainz_albumid || '';
  const parts = {
    // Compared as stored: the same id in another letter case is another album.
    musicbrainz_albumid: isUuid(id) ? id : '',
    album_artist: foldForIdentity(artist.name),
    album: foldForIdentity(track.album || ''),
    album_version: track.album_version || '',
    release_date: normalizeReleaseDate(track.release_date || '')
  };
  const key = parts.musicbrainz_albumid
    ? JSON.stringify([parts.musicbrainz_albumid])
    : JSON.stringify([parts.album_artist, parts.album, parts.album_version, parts.release_date]);
  return {
    key,
    parts,
    // What the library shows the album artist as.
    albumArtist: artist.name,
    unknownArtist: artist.unknown,
    // No album tag: shown as "[Unknown Album]".
    unknownAlbum: !track.album
  };
}
