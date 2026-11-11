import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  albumIdentity,
  albumArtist,
  firstReleaseDate,
  foldForIdentity,
  isUuid,
  normalizeReleaseDate
} from './identity.js';
import { GROUND_TRUTH } from './navidrome.groundtruth.js';

const cp = String.fromCharCode;
const NBSP = cp(0x00a0);
const MBID = '11111111-2222-4333-8444-555555555555';

function checkTable(fn, table) {
  for (const [input, expected] of table) {
    assert.deepStrictEqual(fn(input), expected, `${fn.name}(${JSON.stringify(input)})`);
  }
}

// A track record as a reader hands it over, with only what the case is about.
const record = ({ album_artist, artist, artists, ...rest }) => ({
  album_artist_values: album_artist ? [album_artist].flat() : [],
  album_artists_values: [],
  artist_values: artist ? [artist].flat() : [],
  artists_values: artists ? [artists].flat() : [],
  ...rest
});
const albumCount = (tracks) => new Set(tracks.map((track) => albumIdentity(record(track)).key)).size;

// The ground-truth albums (navidrome.groundtruth.js) as the track records their
// tags amount to. Note what is absent: a FLAC or MP3 `date` is the recording
// date and never reaches the record's `release_date`; an m4a `date` is the ©day
// atom and does.
const aa = (album) => ({ album, album_artist: 'AA', artist: 'AA' });
const RECORDS = {
  T01: [{ ...aa('T01'), release_date: '2020-01-01' }, { ...aa('T01'), release_date: '2021-02-02' }],
  T02: [{ ...aa('T02'), release_date: '2020-01-01' }, { ...aa('T02'), release_date: '2020-01-01' }],
  T03: [{ ...aa('T03'), date: '2020-01-01' }, { ...aa('T03'), date: '2021-02-02' }],
  T04: [{ ...aa('T04'), release_date: '2020' }, { ...aa('T04'), release_date: '2021' }],
  T05: [{ ...aa('T05'), date: '2020-01-01' }, { ...aa('T05'), date: '2021-02-02' }],
  T06: [{ album: 'T06', artist: 'Solo06' }, { album: 'T06', artist: 'Solo06 feat. Guest06' }],
  T07: [{ album: 'T07', artist: 'Alpha07' }, { album: 'T07', artist: 'Beta07' }],
  T08: [
    { album: 'T08', artist: 'Alpha08', compilation: '1' },
    { album: 'T08', artist: 'Beta08', compilation: '1' }
  ],
  T09: [
    { album: 'T09 Case Differs', album_artist: 'AA', artist: 'AA' },
    { album: 't09 case differs', album_artist: 'aa', artist: 'AA' }
  ],
  T10: [aa('T10 nbsp'), aa(`T10${NBSP}nbsp`)],
  T11: [aa('T11'), aa('T11')],
  T12: [{ ...aa('T12'), musicbrainz_albumid: MBID }, aa('T12')],
  T13: [
    { album: 'T13 same mbid', album_artist: 'AA', artist: 'AA', musicbrainz_albumid: MBID },
    { album: 'T13 other name entirely', album_artist: 'ZZ', artist: 'ZZ', musicbrainz_albumid: MBID }
  ],
  T14: [{ album: 'T14', album_artist: 'Solo14', artist: 'Solo14' }, { album: 'T14', artist: 'Solo14' }],
  T15: [{ album: 'T15', album_artist: 'Band15', artist: 'Singer15' }, { album: 'T15', artist: 'Singer15' }],
  T16: [{ ...aa('T16'), release_date: '2020' }, { ...aa('T16'), release_date: '2020-05-01' }],
  T17: [aa("T17 Don't"), aa(`T17 Don${cp(0x2019)}t`)],
  T18: [{ ...aa('T18'), album_version: 'Deluxe' }, aa('T18')],
  T19: [{ ...aa('T19'), release_date: '2020-01-01' }, { ...aa('T19'), release_date: '2021-02-02' }],
  T20: [aa(`T20 Caf${cp(0xe9)}`), aa(`T20 Cafe${cp(0x0301)}`)],
  T21: [aa('T21 trailing space'), aa('T21 trailing space ')],
  T22: [{ album_artist: 'AA', artist: 'AA' }, { album_artist: 'AA', artist: 'AA' }]
};

test('the identity rule makes of every ground-truth album what Navidrome made of it', () => {
  // Every scanned case is stated here, and no other.
  assert.deepEqual(Object.keys(RECORDS), GROUND_TRUTH.map((c) => c.id));
  for (const { id, differs, albums, albumArtist: expectedArtist } of GROUND_TRUTH) {
    assert.equal(albumCount(RECORDS[id]), albums, `${id}: tracks differ in ${differs}`);
    if (expectedArtist) {
      assert.deepEqual(
        RECORDS[id].map((track) => albumIdentity(record(track)).albumArtist),
        [expectedArtist, expectedArtist],
        id
      );
    }
  }
});

test('a track with no album tag is an unknown album, and still one album per artist', () => {
  const [first] = RECORDS.T22.map((track) => albumIdentity(record(track)));
  assert.equal(first.unknownAlbum, true);
  assert.equal(first.parts.album, '');
  assert.equal(albumIdentity(record({ album: 'x' })).unknownAlbum, false);
  // Another artist's untagged tracks are another "[Unknown Album]".
  assert.equal(albumCount([{ artist: 'A' }, { artist: 'B' }]), 2);
});

test('album artist: the first source that has a value', () => {
  const name = (track) => albumArtist(record(track)).name;
  // ALBUMARTIST wins, its values joined; it is never cut at a separator.
  assert.equal(name({ album_artist: 'Band', artist: 'Singer', artists: 'Other', compilation: '1' }), 'Band');
  assert.equal(name({ album_artist: ['A', 'B'] }), 'A • B');
  assert.equal(name({ album_artist: 'A feat. B' }), 'A feat. B');
  // Empty values and repeats are not values.
  assert.equal(name({ album_artist: ['', 'A', 'A', 'B'] }), 'A • B');
  // ALBUMARTISTS next.
  assert.equal(albumArtist({ ...record({ artist: 'Singer' }), album_artists_values: ['X', 'Y'] }).name, 'X • Y');
  // Then the compilation flag, over any artist.
  assert.equal(name({ artist: 'Singer', compilation: '1' }), 'Various Artists');
  for (const flag of ['1', 't', 'T', 'true', 'TRUE', 'True']) {
    assert.equal(name({ artist: 'Singer', compilation: flag }), 'Various Artists', flag);
  }
  for (const flag of ['0', 'f', 'false', 'yes', 'Y', '2', ' 1', '']) {
    assert.equal(name({ artist: 'Singer', compilation: flag }), 'Singer', JSON.stringify(flag));
  }
  // Then the track's first artist.
  assert.equal(name({ artist: 'Singer' }), 'Singer');
  // Then nothing.
  assert.deepEqual(albumArtist(record({})), { name: '[Unknown Artist]', unknown: true });
  assert.equal(albumArtist(record({ artist: 'Singer' })).unknown, false);
});

test('first artist: ARTISTS as it stands, else a lone ARTIST cut at the separators', () => {
  const first = (track) => albumArtist(record(track)).name;
  // Each separator, whatever its letter case, parts trimmed.
  checkTable((artist) => first({ artist }), [
    ['A / B', 'A'],
    ['A feat. B', 'A'],
    ['A feat B', 'A'],
    ['A ft. B', 'A'],
    ['A ft B', 'A'],
    ['A; B', 'A'],
    ['A FEAT. B', 'A'],
    ['A Feat B', 'A'],
    ['A FT. B', 'A'],
    ['A  feat.  B', 'A'],
    ['A feat. B / C; D ft E', 'A'],
    // Not separators: no space around the slash, none after the semicolon, a
    // comma, an ampersand, "featuring", or the word glued to the name.
    ['AC/DC', 'AC/DC'],
    ['A;B', 'A;B'],
    ['A, B', 'A, B'],
    ['A & B', 'A & B'],
    ['A featuring B', 'A featuring B'],
    ['Daft Punk', 'Daft Punk'],
    ['Left feat.B', 'Left feat.B'],
    // A leading separator leaves the part after it.
    [' feat. B', 'B'],
    // Nothing but a separator is no artist at all.
    [' / ', '[Unknown Artist]']
  ]);
  // ARTISTS is taken as it stands, never cut — and it wins over ARTIST.
  assert.equal(first({ artist: 'A feat. B', artists: ['B', 'A'] }), 'B');
  assert.equal(first({ artists: 'Nujabes; Shing02' }), 'Nujabes; Shing02');
  // Several ARTIST values: the first, whole.
  assert.equal(first({ artist: ['A feat. B', 'C'] }), 'A feat. B');
  // The same value twice is one value, so it is cut.
  assert.equal(first({ artist: ['A feat. B', 'A feat. B'] }), 'A');
});

test('a hand-built record without value lists falls back to the single strings', () => {
  assert.equal(albumArtist({ album_artist: 'Band', artist: 'Singer' }).name, 'Band');
  assert.equal(albumArtist({ artist: 'Singer feat. Guest' }).name, 'Singer');
  assert.equal(albumArtist({ artist: 'Singer', artists: 'Other' }).name, 'Other');
  assert.equal(albumIdentity({}).albumArtist, '[Unknown Artist]');
});

test('normalizeReleaseDate table', () => {
  checkTable(normalizeReleaseDate, [
    ['2020', '2020'],
    ['2020-05', '2020-05'],
    ['2020-05-01', '2020-05-01'],
    // Longer than a date: the first ten characters.
    ['2020-05-01T10:00:00Z', '2020-05-01'],
    ['2020-05-01 extra', '2020-05-01'],
    // Not a real YYYY-MM-DD or YYYY-MM: the year alone.
    ['2020-5-1', '2020'],
    ['2020/05/01', '2020'],
    ['2020.05.01', '2020'],
    ['2020-13-01', '2020'],
    ['2020-00', '2020'],
    ['2020-02-30', '2020'],
    ['2021-02-29', '2021'],
    ['2020-02-29', '2020-02-29'],
    ['1900-02-29', '1900'],
    ['2000-02-29', '2000-02-29'],
    ['2020-05-', '2020'],
    ['2020-05 remaster', '2020'],
    ['20200501', '2020'],
    // The year is the first run of four digits that starts with 1 or 2.
    ['May 2020', '2020'],
    ['01/05/1999', '1999'],
    ['0999 then 2001', '2001'],
    ['12020', '1202'],
    // No such year, or too short to hold one.
    ['3020', ''],
    ['0000', ''],
    ['abcd', ''],
    ['202', ''],
    ['', '']
  ]);
});

test('firstReleaseDate takes the first tag that holds a year', () => {
  assert.equal(firstReleaseDate(['2021-06-01', '2020', '2019']), '2021-06-01');
  assert.equal(firstReleaseDate(['', undefined, '2019']), '2019');
  // A value with no year in it is passed over, not kept as a blank.
  assert.equal(firstReleaseDate(['unknown', '2019']), '2019');
  assert.equal(firstReleaseDate(['unknown', '']), '');
  assert.equal(firstReleaseDate([]), '');
});

test('isUuid table', () => {
  checkTable(isUuid, [
    [MBID, true],
    [MBID.toUpperCase(), true],
    ['00000000-0000-0000-0000-000000000000', true],
    [`urn:uuid:${MBID}`, true],
    [`{${MBID}}`, true],
    [MBID.replaceAll('-', ''), true],
    ['', false],
    ['not-a-uuid', false],
    [MBID.slice(0, -1), false],
    [`${MBID}5`, false],
    [MBID.replace('1', 'g'), false],
    [` ${MBID}`, false],
    [MBID.replaceAll('-', ' '), false],
    [`https://musicbrainz.org/release/${MBID}`, false]
  ]);
});

test('MusicBrainz album id: alone it is the identity; invalid, it is absent', () => {
  // Same id: one album, whatever else differs.
  assert.equal(albumCount(RECORDS.T13), 1);
  // Different ids split what is otherwise identical.
  assert.equal(
    albumCount([
      { ...aa('X'), musicbrainz_albumid: MBID },
      { ...aa('X'), musicbrainz_albumid: MBID.replace('1', '2') }
    ]),
    2
  );
  // An invalid id on one track changes nothing: both fall back to the tags.
  assert.equal(albumCount([{ ...aa('X'), musicbrainz_albumid: 'not-a-uuid' }, aa('X')]), 1);
  assert.equal(albumIdentity(record({ ...aa('X'), musicbrainz_albumid: 'not-a-uuid' })).parts.musicbrainz_albumid, '');
  // Compared as stored: another letter case is another album.
  assert.equal(
    albumCount([
      { ...aa('X'), musicbrainz_albumid: 'aaaaaaaa-2222-4333-8444-555555555555' },
      { ...aa('X'), musicbrainz_albumid: 'AAAAAAAA-2222-4333-8444-555555555555' }
    ]),
    2
  );
});

test('foldForIdentity: letter case and typographic quotes and dashes, nothing else', () => {
  assert.equal(foldForIdentity('The ALBUM'), 'the album');
  for (const code of [0x2018, 0x2019, 0x201b, 0x2032]) {
    assert.equal(foldForIdentity(`a${cp(code)}b`), "a'b", code.toString(16));
  }
  for (const code of [0xff02, 0x3003, 0x02ee, 0x05f2, 0x1cd3, 0x2033, 0x2036, 0x02f6, 0x02ba, 0x201c, 0x201d, 0x02dd, 0x201f]) {
    assert.equal(foldForIdentity(`a${cp(code)}b`), 'a"b', code.toString(16));
  }
  for (const code of [0x2010, 0x2013, 0x2014, 0x2212, 0x2015]) {
    assert.equal(foldForIdentity(`a${cp(code)}b`), 'a-b', code.toString(16));
  }
  // Left as they are: NBSP, a zero-width space, edge and doubled spaces, a
  // decomposed accent, a backtick, a non-breaking hyphen, a horizontal ellipsis.
  for (const value of [`a${NBSP}b`, `a${cp(0x200b)}b`, ' a ', 'a  b', `e${cp(0x0301)}`, 'a`b', `a${cp(0x2011)}b`, `a${cp(0x2026)}`]) {
    assert.equal(foldForIdentity(value), value, JSON.stringify(value));
  }
});

test('what is compared exactly, and what is folded', () => {
  // Album artist folds like album does.
  assert.equal(
    albumCount([
      { album: 'X', album_artist: `Guns N${cp(0x2019)} Roses` },
      { album: 'X', album_artist: "GUNS N' ROSES" }
    ]),
    1
  );
  assert.equal(albumCount([{ ...aa('A – B') }, { ...aa('A - B') }]), 1);
  assert.equal(albumCount([{ ...aa(`${cp(0x201c)}A${cp(0x201d)}`) }, { ...aa('"A"') }]), 1);
  // Album version is exact: case and spacing count.
  assert.equal(albumCount([{ ...aa('X'), album_version: 'Deluxe' }, { ...aa('X'), album_version: 'deluxe' }]), 2);
  assert.equal(albumCount([{ ...aa('X'), album_version: 'Deluxe' }, { ...aa('X'), album_version: 'Deluxe' }]), 1);
  // Release date is compared after normalizing, so these are one date...
  assert.equal(
    albumCount([
      { ...aa('X'), release_date: '2020-05-01' },
      { ...aa('X'), release_date: '2020-05-01T00:00:00' }
    ]),
    1
  );
  assert.equal(albumCount([{ ...aa('X'), release_date: '2020' }, { ...aa('X'), release_date: '2020/05/01' }]), 1);
  // ...a date with no year in it is no date...
  assert.equal(albumCount([{ ...aa('X'), release_date: 'n/a' }, aa('X')]), 1);
  // ...and a year is not the same date as a day in it.
  assert.equal(albumCount([{ ...aa('X'), release_date: '2020' }, { ...aa('X'), release_date: '2020-01-01' }]), 2);
  // The recording date is not consulted at all.
  assert.equal(albumCount([{ ...aa('X'), date: '1999' }, { ...aa('X'), date: '2020' }]), 1);
});

test('the parts say which ingredient differs', () => {
  const [first, second] = RECORDS.T16.map((track) => albumIdentity(record(track)));
  assert.deepEqual(first.parts, {
    musicbrainz_albumid: '',
    album_artist: 'aa',
    album: 't16',
    album_version: '',
    release_date: '2020'
  });
  assert.deepEqual(
    Object.keys(first.parts).filter((part) => first.parts[part] !== second.parts[part]),
    ['release_date']
  );
});
