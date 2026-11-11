import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseAlbum } from './inspect.js';
import { firstReleaseDate, normalizeReleaseDate } from './identity.js';
import { planAlbum, planWrites, chooseCover } from './plan.js';

const cp = String.fromCharCode;
const NBSP = cp(0x00a0);
const MBID_A = '11111111-2222-4333-8444-555555555555';
const MBID_B = 'aaaaaaaa-2222-4333-8444-555555555555';

// A track record as a reader hands it over (web/src/tags.js `readTrack`),
// derived from the tags alone. `tags` is { TAGLIB_NAME: value | [values] }.
function record(file, tags, extra = {}) {
  const properties = Object.fromEntries(Object.entries(tags).map(([name, value]) => [name, [value].flat()]));
  const all = (...names) => names.flatMap((name) => properties[name] || []);
  const tag = (name) => all(name).join(';');
  const mp4 = file.endsWith('.m4a');
  const release = all('TDRL', 'RELEASEDATE');
  return {
    file,
    readable: true,
    sampleRate: 44100,
    bitDepth: 16,
    hasArt: false,
    duration: 2,
    title: tag('TITLE'),
    artist: tag('ARTIST'),
    artists: tag('ARTISTS'),
    album: tag('ALBUM'),
    album_artist: tag('ALBUMARTIST'),
    date: tag('DATE'),
    disc: tag('DISCNUMBER'),
    track: tag('TRACKNUMBER'),
    artist_values: all('ARTIST'),
    artists_values: all('ARTISTS'),
    album_artist_values: all('ALBUMARTIST'),
    album_artists_values: all('ALBUMARTISTS'),
    compilation: all('COMPILATION', 'TCMP')[0] || '',
    musicbrainz_albumid: all('MUSICBRAINZ_ALBUMID')[0] || '',
    album_version: all('ALBUMVERSION', 'MUSICBRAINZ_ALBUMCOMMENT', 'MUSICBRAINZ ALBUM COMMENT')[0] || '',
    release_date: firstReleaseDate([...release, ...(mp4 ? all('DATE') : []), ...all('YEAR')]),
    release_date_follows_date: mp4 && !release.some(normalizeReleaseDate),
    properties,
    ...extra
  };
}
const unreadable = (file) => ({ ...record(file, {}), readable: false, sampleRate: null, bitDepth: null, duration: null });

// A well-tagged album of `count` tracks; `each(n)` adds to or overrides track n.
function album(count, each = () => ({}), ext = 'flac') {
  return Array.from({ length: count }, (_, i) => {
    const { file, extra, ...tags } = each(i + 1);
    return record(file || `Album/0${i + 1} Song.${ext}`, {
      TITLE: `Song ${i + 1}`,
      ARTIST: 'AA',
      ALBUM: 'Album',
      ALBUMARTIST: 'AA',
      TRACKNUMBER: `${i + 1}/${count}`,
      ...tags
    }, { hasArt: true, ...extra });
  });
}

const images = ['Album/cover.jpg'];
function plan(tracks, context = {}, folderImages = images) {
  const report = diagnoseAlbum('Album', tracks, folderImages);
  return { report, ...planAlbum(report, tracks, context) };
}
// file -> the tags to write, with every proposed fix left on.
function writes(tracks, context = {}, folderImages = images) {
  const { report, fixes } = plan(tracks, context, folderImages);
  const { files } = planWrites(report, tracks, fixes, context);
  return Object.fromEntries(files.map((entry) => [entry.file, entry.set]));
}
const offered = (tracks, context, folderImages) =>
  Object.fromEntries(plan(tracks, context, folderImages).fixes.map(({ id, value }) => [id, value]));

// What the files would hold after the plan: the stand-in for writeTrack.
function applied(tracks, { files, addCover }, folderImages) {
  const byFile = new Map(files.map((entry) => [entry.file, entry]));
  const after = tracks.map((track) => {
    const entry = byFile.get(track.file);
    if (!entry || !track.readable) {
      return track;
    }
    const tags = { ...track.properties };
    for (const [name, value] of Object.entries(entry.set)) {
      delete tags[name];
      if (value != null) {
        tags[name] = value;
      }
    }
    return record(entry.rename || track.file, tags, { hasArt: track.hasArt || entry.cover });
  });
  return { tracks: after, folderImages: addCover ? [...folderImages, addCover] : folderImages };
}

function table(rows) {
  for (const [name, tracks, expectedFixes, expectedWrites, context = {}, folderImages = images] of rows) {
    assert.deepEqual(offered(tracks, context, folderImages), expectedFixes, `${name}: fixes`);
    assert.deepEqual(writes(tracks, context, folderImages), expectedWrites, `${name}: writes`);
    // The plan is a fixpoint: applied once, there is nothing left to offer.
    const { report, fixes } = plan(tracks, context, folderImages);
    const next = applied(tracks, planWrites(report, tracks, fixes, context), folderImages);
    assert.deepEqual(offered(next.tracks, context, next.folderImages), {}, `${name}: nothing left to fix`);
  }
}

test('a well-tagged album with its cover.jpg needs nothing', () => {
  const result = plan(album(3));
  assert.deepEqual(result.fixes, []);
  assert.deepEqual(result.cannotFix, []);
  assert.deepEqual(result.verdict, { code: 'fine', albums: 1, tracks: 3 });
  assert.deepEqual(planWrites(result.report, album(3), result.fixes), { files: [], addCover: null });
});

test('album and album artist: one value on every track', () => {
  table([
    [
      'the majority name goes on the odd track, and only there',
      album(3, (n) => (n === 3 ? { ALBUM: 'Another Name' } : {})),
      { album: 'Album' },
      { 'Album/03 Song.flac': { ALBUM: 'Album' } }
    ],
    [
      'names apart only by an NBSP unify to the clean spelling',
      album(2, (n) => (n === 2 ? { ALBUM: `Al${NBSP}bum` } : { ALBUM: 'Al bum' })),
      { album: 'Al bum', text: undefined },
      { 'Album/02 Song.flac': { ALBUM: 'Al bum' } }
    ],
    [
      'a marker on some tracks: the spelling most tracks use',
      album(3, (n) => (n === 1 ? { ALBUM: 'Album [Explicit]' } : {})),
      { album: 'Album' },
      { 'Album/01 Song.flac': { ALBUM: 'Album' } }
    ],
    [
      'a marker on most tracks: still the spelling most tracks use',
      album(3, (n) => (n === 1 ? {} : { ALBUM: 'Album [Explicit]' })),
      { album: 'Album [Explicit]' },
      { 'Album/01 Song.flac': { ALBUM: 'Album [Explicit]' } }
    ],
    [
      'a marker on exactly half: the longer name',
      album(2, (n) => (n === 1 ? { ALBUM: 'Album [Explicit]' } : {})),
      { album: 'Album [Explicit]' },
      { 'Album/02 Song.flac': { ALBUM: 'Album [Explicit]' } }
    ],
    [
      'the count is of spellings as the eye reads them: a stray space is the same spelling',
      album(5, (n) => ({ ALBUM: ['Album', 'Album ', 'Album', 'Album (Deluxe)', 'Album (Deluxe)'][n - 1] })),
      { album: 'Album', text: undefined },
      { 'Album/02 Song.flac': { ALBUM: 'Album' }, 'Album/04 Song.flac': { ALBUM: 'Album' }, 'Album/05 Song.flac': { ALBUM: 'Album' } }
    ],
    [
      'no album tag anywhere: the folder name, as a guess',
      album(2, () => ({ ALBUM: [] })),
      { album: 'Folder Name' },
      { 'Album/01 Song.flac': { ALBUM: 'Folder Name' }, 'Album/02 Song.flac': { ALBUM: 'Folder Name' } },
      { nameGuess: 'Folder Name' }
    ],
    [
      'album artist on one track only, another name on the other',
      album(2, (n) => (n === 1 ? { ALBUMARTIST: 'Band' } : { ALBUMARTIST: [], ARTIST: 'Singer' })),
      { album_artist: 'Band' },
      { 'Album/02 Song.flac': { ALBUMARTIST: 'Band' } }
    ],
    [
      'no album artist anywhere and the track artists differ: Various Artists',
      album(3, (n) => ({ ALBUMARTIST: [], ARTIST: ['Alpha', 'Beta', 'Alpha'][n - 1] })),
      { album_artist: 'Various Artists' },
      {
        'Album/01 Song.flac': { ALBUMARTIST: 'Various Artists' },
        'Album/02 Song.flac': { ALBUMARTIST: 'Various Artists' },
        'Album/03 Song.flac': { ALBUMARTIST: 'Various Artists' }
      }
    ],
    [
      'ALBUMARTISTS on one track counts as carrying an album artist: that one is proposed',
      album(2, (n) => (n === 1 ? { ALBUMARTIST: [], ALBUMARTISTS: 'Band', ARTIST: 'Alpha' } : { ALBUMARTIST: [], ARTIST: 'Beta' })),
      { album_artist: 'Band' },
      { 'Album/01 Song.flac': { ALBUMARTIST: 'Band' }, 'Album/02 Song.flac': { ALBUMARTIST: 'Band' } }
    ],
    ['no album artist, but one artist with and without a guest: one album already, nothing to do', album(2, (n) => ({ ALBUMARTIST: [], ARTIST: n === 1 ? 'Solo' : 'Solo feat. Guest' })), {}, {}],
    [
      'several album artists stay several values, never one joined string',
      album(2, (n) => (n === 1 ? { ALBUMARTIST: ['A', 'B'] } : { ALBUMARTIST: [], ARTIST: 'C' })),
      { album_artist: 'A • B' },
      { 'Album/02 Song.flac': { ALBUMARTIST: ['A', 'B'] } }
    ]
  ]);
});

test('album: the guess is marked, and a name the user must supply is asked for', () => {
  const untitled = album(2, () => ({ ALBUM: [] }));
  const guessed = plan(untitled, { nameGuess: 'Folder Name' });
  assert.equal(guessed.fixes[0].guess, true);
  assert.deepEqual(guessed.verdict, { code: 'merged', reasons: ['no_album'], albums: 1, tracks: 2 });

  // Nothing to pre-fill, so nothing to write yet — but the field is offered.
  const blank = plan(untitled);
  assert.deepEqual(blank.fixes.map(({ id, value, guess }) => ({ id, value, guess })), [{ id: 'album', value: '', guess: false }]);
  assert.deepEqual(planWrites(blank.report, untitled, blank.fixes).files, []);

  // The values behind a disagreement come along, to show the user.
  const two = plan(album(3, (n) => (n === 3 ? { ALBUM: 'Other' } : {})));
  assert.deepEqual(two.fixes[0].found, [{ value: 'Album', count: 2 }, { value: 'Other', count: 1 }]);
  // ...with a flag for names that may be different albums, not one misnamed.
  const apart = (names) => plan(album(names.length, (n) => ({ ALBUM: names[n - 1] }))).fixes[0].apart;
  assert.equal(two.fixes[0].apart, true);
  assert.equal(apart(['Album', 'Album [Explicit]']), false);
  assert.equal(apart(['Album', 'Album ']), false);
  assert.equal(apart(['Album', 'ALBUM (Deluxe Edition)']), false);
  assert.equal(apart(['Album', 'Album II']), true);

  // What the user types is what is written, trimmed.
  const edited = two.fixes.map((fix) => ({ ...fix, value: '  Typed  ' }));
  assert.deepEqual(
    planWrites(two.report, album(3, (n) => (n === 3 ? { ALBUM: 'Other' } : {})), edited).files.map((entry) => entry.set),
    [{ ALBUM: 'Typed' }, { ALBUM: 'Typed' }, { ALBUM: 'Typed' }]
  );
});

test('release date: the same on every track, in the tag each container keeps it in', () => {
  const m4a = (dates) => album(dates.length, (n) => ({ DATE: dates[n - 1] ?? [] }), 'm4a');
  table([
    [
      'm4a: the ©day atom (DATE)',
      m4a(['2020-01-01', '2020-01-01', '2021-02-02']),
      { release_date: '2020-01-01' },
      { 'Album/03 Song.m4a': { DATE: '2020-01-01' } }
    ],
    [
      'm4a: a year against a full date, one track each: the fuller date',
      m4a(['2020', '2020-05-01']),
      { release_date: '2020-05-01' },
      { 'Album/01 Song.m4a': { DATE: '2020-05-01' } }
    ],
    [
      'a tie between a year, a month and a day: the day',
      m4a(['2020', '2020-05', '2020-05-01']),
      { release_date: '2020-05-01' },
      { 'Album/01 Song.m4a': { DATE: '2020-05-01' }, 'Album/02 Song.m4a': { DATE: '2020-05-01' } }
    ],
    [
      'a clear majority wins, however bare',
      m4a(['2020', '2020', '2020-05-01']),
      { release_date: '2020' },
      { 'Album/03 Song.m4a': { DATE: '2020' } }
    ],
    [
      'm4a: a time of day does not make another date, so the tag is left as it is',
      m4a(['2020-05-01', '2020-05-01T10:00', '2021']),
      { release_date: '2020-05-01' },
      { 'Album/03 Song.m4a': { DATE: '2020-05-01' } }
    ],
    [
      'm4a: a RELEASEDATE outranks ©day, so that is the tag to move',
      album(2, (n) => (n === 1 ? { DATE: '2020' } : { DATE: '1975', RELEASEDATE: '2011' }), 'm4a'),
      { release_date: '2011' },
      { 'Album/01 Song.m4a': { DATE: '2011' } }
    ],
    [
      'flac: YEAR where the tracks use YEAR',
      album(2, (n) => ({ YEAR: n === 1 ? '2020' : '2021' })),
      { release_date: '2020' },
      { 'Album/02 Song.flac': { YEAR: '2020' } }
    ],
    [
      'flac: RELEASEDATE where the tracks use RELEASEDATE, added to a track with none',
      album(3, (n) => (n === 3 ? {} : { RELEASEDATE: '2020-01-01' })),
      { release_date: '2020-01-01' },
      { 'Album/03 Song.flac': { RELEASEDATE: '2020-01-01' } }
    ],
    [
      'flac: a track with only a YEAR keeps its date there',
      album(3, (n) => (n === 3 ? { YEAR: '2019' } : { RELEASEDATE: '2020-01-01' })),
      { release_date: '2020-01-01' },
      { 'Album/03 Song.flac': { YEAR: '2020-01-01' } }
    ],
    [
      'mp3 (ID3v2.3): a raw TDRL becomes the release date frame',
      album(2, (n) => (n === 1 ? { RELEASEDATE: '2020-01-01' } : { TDRL: '2021-02-02' }), 'mp3'),
      { release_date: '2020-01-01' },
      { 'Album/02 Song.mp3': { TDRL: null, RELEASEDATE: '2020-01-01' } }
    ],
    [
      'mixed containers: the FLAC gets the release date the m4a carries in ©day',
      [...album(1, () => ({ DATE: '2020' }), 'm4a'), ...album(1, () => ({ file: 'Album/02 Song.flac', DATE: '2020' }))],
      { release_date: '2020' },
      { 'Album/02 Song.flac': { RELEASEDATE: '2020' } }
    ]
  ]);

  // No track carries a release date: none is added, and DATE alone is no cause.
  assert.deepEqual(offered(album(2, () => ({ DATE: '2020' }))), {});
});

test('recording date: unified where it disagrees, outside MP4', () => {
  table([
    [
      'flac: DATE disagrees (the album would show no date)',
      album(3, (n) => ({ DATE: n === 3 ? '2021.2.2' : '2020-01-01' })),
      { date: '2020-01-01' },
      { 'Album/03 Song.flac': { DATE: '2020-01-01' } }
    ],
    [
      'a track with no DATE is filled in along the way',
      album(3, (n) => ({ DATE: [['2020'], ['2021'], []][n - 1] })),
      { date: '2020' },
      { 'Album/02 Song.flac': { DATE: '2020' }, 'Album/03 Song.flac': { DATE: '2020' } }
    ],
    [
      'a tie: the more complete date',
      album(2, (n) => ({ DATE: n === 1 ? '2020' : '2020-05-01' })),
      { date: '2020-05-01' },
      { 'Album/01 Song.flac': { DATE: '2020-05-01' } }
    ],
    ['one DATE and a track without: not a disagreement', album(2, (n) => (n === 1 ? { DATE: '2020' } : {})), {}, {}]
  ]);

  // A date typed with dots is written the ISO way.
  const tracks = album(2, (n) => ({ DATE: n === 1 ? '2021.2.2' : '2020' }));
  const { report, fixes } = plan(tracks);
  const chosen = fixes.map((fix) => ({ ...fix, value: '2021.2.2' }));
  assert.deepEqual(planWrites(report, tracks, chosen).files, [
    { file: 'Album/01 Song.flac', set: { DATE: '2021-02-02' }, cover: false, rename: null },
    { file: 'Album/02 Song.flac', set: { DATE: '2021-02-02' }, cover: false, rename: null }
  ]);
});

test('album version: made the same, or removed', () => {
  table([
    [
      'on most tracks: copied to the rest',
      album(3, (n) => (n === 3 ? {} : { ALBUMVERSION: 'Deluxe' })),
      { album_version: 'Deluxe' },
      { 'Album/03 Song.flac': { ALBUMVERSION: 'Deluxe' } }
    ],
    [
      'on one track of three: removed, under whichever tag holds it',
      album(3, (n) => (n === 1 ? { MUSICBRAINZ_ALBUMCOMMENT: 'Remaster' } : {})),
      { album_version: '' },
      { 'Album/01 Song.flac': { MUSICBRAINZ_ALBUMCOMMENT: null } }
    ],
    [
      'two versions: the commoner one',
      album(3, (n) => ({ ALBUMVERSION: n === 1 ? 'Deluxe' : 'Remaster' })),
      { album_version: 'Remaster' },
      { 'Album/01 Song.flac': { ALBUMVERSION: 'Remaster' } }
    ]
  ]);
  assert.deepEqual(plan(album(2, (n) => (n === 1 ? { ALBUMVERSION: 'Deluxe' } : {}))).fixes[0].options, ['Deluxe', '']);
});

test('MusicBrainz album id: copied to the tracks without, or the commonest of several', () => {
  table([
    [
      'one id, on some tracks',
      album(3, (n) => (n === 1 ? { MUSICBRAINZ_ALBUMID: MBID_A } : {})),
      { mbid: MBID_A },
      { 'Album/02 Song.flac': { MUSICBRAINZ_ALBUMID: MBID_A }, 'Album/03 Song.flac': { MUSICBRAINZ_ALBUMID: MBID_A } }
    ],
    [
      'two ids: the commoner one, and an id that is no UUID counts as none',
      album(4, (n) => ({ MUSICBRAINZ_ALBUMID: [MBID_A, MBID_B, MBID_B, 'not-an-id'][n - 1] })),
      { mbid: MBID_B },
      { 'Album/01 Song.flac': { MUSICBRAINZ_ALBUMID: MBID_B }, 'Album/04 Song.flac': { MUSICBRAINZ_ALBUMID: MBID_B } }
    ]
  ]);
  const conflict = plan(album(4, (n) => ({ MUSICBRAINZ_ALBUMID: [MBID_A, MBID_B, MBID_B, []][n - 1] }))).fixes[0];
  assert.deepEqual(conflict, { id: 'mbid', on: true, value: MBID_B, ids: 2, count: 2, total: 4 });
});

test('track numbers: n/total per disc, where missing or the total is wrong', () => {
  const discs = (n) => ({ DISCNUMBER: n <= 2 ? '1' : '2', TRACKNUMBER: String(n <= 2 ? n : n - 2) });
  table([
    [
      'no totals',
      album(2, (n) => ({ TRACKNUMBER: String(n) })),
      { track_numbers: undefined },
      { 'Album/01 Song.flac': { TRACKNUMBER: '1/2' }, 'Album/02 Song.flac': { TRACKNUMBER: '2/2' } }
    ],
    [
      'the total counts the tracks of the disc, not of the album',
      album(5, discs),
      { track_numbers: undefined },
      {
        'Album/01 Song.flac': { TRACKNUMBER: '1/2' },
        'Album/02 Song.flac': { TRACKNUMBER: '2/2' },
        'Album/03 Song.flac': { TRACKNUMBER: '1/3' },
        'Album/04 Song.flac': { TRACKNUMBER: '2/3' },
        'Album/05 Song.flac': { TRACKNUMBER: '3/3' }
      }
    ],
    [
      'no number: the one the file name starts with',
      album(2, (n) => (n === 2 ? { TRACKNUMBER: [] } : {})),
      { track_numbers: undefined },
      { 'Album/02 Song.flac': { TRACKNUMBER: '2/2' } }
    ],
    ['"03/09" already says 3/9: untouched', album(2, (n) => ({ TRACKNUMBER: `0${n}/02` })), {}, {}]
  ]);
});

test('track numbers: an incomplete disc and a disc with repeated numbers are left alone, and said so', () => {
  // Tracks 1, 2 and 4 of 5: the total is right, the album is short.
  const short = album(3, (n) => ({ TRACKNUMBER: `${[1, 2, 4][n - 1]}/5` }));
  assert.deepEqual(offered(short), {});
  assert.deepEqual(plan(short).cannotFix, [{ code: 'gaps', discs: [{ disc: 1, missing: [3, 5] }], multiDisc: false }]);
  assert.equal(plan(short).verdict.code, 'stuck');

  // ...but a track with no number on it still gets one, under that total.
  const unnumbered = album(3, (n) => ({ file: `Album/0${[1, 2, 4][n - 1]} Song.flac`, TRACKNUMBER: n === 3 ? [] : `${n}/5` }));
  assert.deepEqual(writes(unnumbered), { 'Album/04 Song.flac': { TRACKNUMBER: '4/5' } });

  // Two discs with no disc tag: 1/2 and 2/2 twice over.
  const twoDiscs = album(4, (n) => ({ file: `Album/CD${n <= 2 ? 1 : 2}/0${n} Song.flac`, TRACKNUMBER: `${((n - 1) % 2) + 1}/2` }));
  assert.deepEqual(offered(twoDiscs, {}, ['Album/cover.jpg']), {});
  assert.deepEqual(plan(twoDiscs).cannotFix, [{ code: 'duplicate_numbers', discs: [1], multiDisc: false }]);

  // No number in the tag or the file name: nothing to go on. (The diagnosis
  // also reads the other track's "1/2" as a track 2 that is not here.)
  const nameless = album(2, (n) => (n === 2 ? { file: 'Album/Song.flac', TRACKNUMBER: [] } : {}));
  assert.deepEqual(offered(nameless), {});
  assert.deepEqual(plan(nameless).cannotFix, [
    { code: 'gaps', discs: [{ disc: 1, missing: [2] }], multiDisc: false },
    { code: 'no_track_number', files: ['Album/Song.flac'] }
  ]);
});

test('text: confident repairs only, value by value', () => {
  const broken = `Don${cp(0x19)}t`;
  table([
    [
      'a control byte that was a curly apostrophe',
      album(2, (n) => (n === 1 ? { TITLE: broken } : {})),
      { text: undefined },
      { 'Album/01 Song.flac': { TITLE: 'Don’t' } }
    ],
    [
      'stray spaces and invisible characters',
      album(2, (n) => (n === 1 ? { TITLE: ` Song${cp(0x200b)}  1 `, ARTIST: `A${NBSP}A` } : {})),
      { text: undefined },
      { 'Album/01 Song.flac': { TITLE: 'Song 1', ARTIST: 'A A' } }
    ],
    [
      'a tag with several values keeps them separate',
      album(2, (n) => (n === 1 ? { ARTIST: ['AA', ' BB '] } : {})),
      { text: undefined },
      { 'Album/01 Song.flac': { ARTIST: ['AA', 'BB'] } }
    ]
  ]);
  const { fixes } = plan(album(2, (n) => (n === 1 ? { TITLE: broken, ARTIST: ' AA' } : {})));
  assert.deepEqual(fixes, [{ id: 'text', on: true, count: 2, sample: { from: 'Don·t', to: 'Don’t' } }]);

  // A control byte with no confident reading is left in place and reported.
  const unclear = album(2, (n) => (n === 1 ? { TITLE: `Star${cp(0x06)}` } : {}));
  assert.deepEqual(writes(unclear), {});
  assert.deepEqual(plan(unclear).cannotFix, [{ code: 'unclear_text', files: ['Album/01 Song.flac'] }]);
});

test('file names: repaired, unless the repaired name is taken', () => {
  const tracks = album(2, (n) => (n === 1 ? { file: 'Album/01 Don_t.flac' } : {}));
  const { report, fixes } = plan(tracks);
  assert.deepEqual(fixes, [{ id: 'filenames', on: true, renames: [{ from: 'Album/01 Don_t.flac', to: "Album/01 Don't.flac" }] }]);
  assert.deepEqual(planWrites(report, tracks, fixes).files, [
    { file: 'Album/01 Don_t.flac', set: {}, cover: false, rename: "Album/01 Don't.flac" }
  ]);
  assert.deepEqual(planWrites(report, tracks, fixes, { paths: ['Album/01 Don_t.flac', "Album/01 Don't.flac"] }).files, []);
  assert.deepEqual(offered(tracks, { paths: ['Album/01 Don_t.flac', "Album/01 Don't.flac"] }), {});
});

test('cover: where it comes from', () => {
  const bare = album(2, () => ({ extra: { hasArt: false } }));
  const second = album(2, (n) => ({ extra: { hasArt: n === 2 } }));
  const choose = (tracks, folderImages, context) => chooseCover(diagnoseAlbum('Album', tracks, folderImages), tracks, context);
  for (const [name, tracks, folderImages, expected, context] of [
    ['an image named for the job, before any other', bare, ['Album/back.jpg', 'Album/Folder.JPG'], { kind: 'file', path: 'Album/Folder.JPG' }],
    ['cover before folder', bare, ['Album/folder.jpg', 'Album/scans/cover.png'], { kind: 'file', path: 'Album/scans/cover.png' }],
    ['nearest the top first', bare, ['Album/CD1/cover.jpg', 'Album/cover.jpg'], { kind: 'file', path: 'Album/cover.jpg' }],
    ['a named image before an embedded picture', second, ['Album/front.jpg'], { kind: 'file', path: 'Album/front.jpg' }],
    ['an embedded picture before an unnamed image', second, ['Album/back.jpg'], { kind: 'embedded', file: 'Album/02 Song.flac' }],
    ['any image, as a guess, when there is nothing else', bare, ['Album/scan.png'], { kind: 'file', path: 'Album/scan.png', guess: true }],
    ['nothing', bare, [], null],
    ['the image the user gave, over everything', second, ['Album/cover.jpg'], { kind: 'user' }, { hasUserCover: true }]
  ]) {
    assert.deepEqual(choose(tracks, folderImages, context), expected, name);
  }
});

test('cover: embedded in every track when some lack it, and a cover.jpg at the album root', () => {
  const covers = (tracks, folderImages, context) => {
    const { report, fixes } = plan(tracks, context, folderImages);
    const { files, addCover } = planWrites(report, tracks, fixes, context);
    return { fixes: fixes.map((fix) => fix.id), embed: files.filter((entry) => entry.cover).map((entry) => entry.file), addCover };
  };
  const bare = album(2, () => ({ extra: { hasArt: false } }));
  const second = album(2, (n) => ({ extra: { hasArt: n === 2 } }));
  const twoDiscs = album(2, (n) => ({ file: `Box/CD${n}/01 Song.flac`, TRACKNUMBER: '1/1', DISCNUMBER: String(n) }));

  assert.deepEqual(covers(bare, ['Album/cover.jpg']), {
    fixes: ['cover_embed'],
    embed: ['Album/01 Song.flac', 'Album/02 Song.flac'],
    addCover: null
  });
  // From another track's picture: into the tracks without it, and a file too.
  assert.deepEqual(covers(second, []), { fixes: ['cover_embed', 'cover_file'], embed: ['Album/01 Song.flac'], addCover: 'Album/cover.jpg' });
  // Every track has its picture: only the file is missing.
  assert.deepEqual(covers(album(2), []), { fixes: ['cover_file'], embed: [], addCover: 'Album/cover.jpg' });
  assert.deepEqual(covers(album(2), ['Album/folder.jpg']), { fixes: ['cover_file'], embed: [], addCover: 'Album/cover.jpg' });
  assert.deepEqual(covers(album(2), ['Album/Cover.PNG']), { fixes: [], embed: [], addCover: null });
  // Discs in their own folders: the album root is the folder above them.
  assert.deepEqual(covers(twoDiscs, ['Box/CD1/cover.jpg']), { fixes: ['cover_file'], embed: [], addCover: 'Box/cover.jpg' });
  assert.deepEqual(covers(album(1, () => ({ file: '01 Song.flac' })), []), { fixes: ['cover_file'], embed: [], addCover: 'cover.jpg' });

  // No cover anywhere: nothing to offer, and it is said. An image from the user
  // changes that.
  assert.deepEqual(covers(bare, []), { fixes: [], embed: [], addCover: null });
  assert.deepEqual(plan(bare, {}, []).cannotFix, [{ code: 'no_cover', files: ['Album/01 Song.flac', 'Album/02 Song.flac'] }]);
  assert.deepEqual(plan(bare, {}, []).verdict, { code: 'no_cover', missing: 2, albums: 1, tracks: 2 });
  assert.deepEqual(covers(bare, [], { hasUserCover: true }), {
    fixes: ['cover_embed', 'cover_file'],
    embed: ['Album/01 Song.flac', 'Album/02 Song.flac'],
    addCover: 'Album/cover.jpg'
  });

  // And the fixpoint, through the stand-in writer.
  const { report, fixes } = plan(second, {}, []);
  const next = applied(second, planWrites(report, second, fixes), []);
  assert.deepEqual(plan(next.tracks, {}, next.folderImages).fixes, []);
});

test('a fix that is switched off writes nothing', () => {
  const tracks = album(3, (n) => ({
    ALBUM: n === 3 ? 'Other' : 'Album',
    TRACKNUMBER: String(n),
    TITLE: ` Song ${n}`,
    extra: { hasArt: n !== 1 }
  }));
  const { report, fixes } = plan(tracks, {}, []);
  assert.deepEqual(fixes.map((fix) => fix.id), ['album', 'track_numbers', 'text', 'cover_embed', 'cover_file']);
  const only = (id) => planWrites(report, tracks, fixes.map((fix) => ({ ...fix, on: fix.id === id })));
  assert.deepEqual(only('none'), { files: [], addCover: null });
  assert.deepEqual(only('album').files.map((entry) => entry.set), [{ ALBUM: 'Album' }]);
  assert.deepEqual(only('track_numbers').files.map((entry) => entry.set.TRACKNUMBER), ['1/3', '2/3', '3/3']);
  assert.deepEqual(only('cover_file'), { files: [], addCover: 'Album/cover.jpg' });
  assert.deepEqual(only('cover_embed').files.map((entry) => [entry.file, entry.cover, entry.set]), [
    ['Album/01 Song.flac', true, {}],
    ['Album/03 Song.flac', true, {}]
  ]);
});

test('an unreadable file is never written, and is named', () => {
  const tracks = [...album(2, (n) => ({ TRACKNUMBER: String(n) })), unreadable('Album/03 Broken.flac')];
  const { report, fixes, cannotFix, verdict } = plan(tracks);
  // It still counts as a track of the album: the totals say 3.
  assert.deepEqual(planWrites(report, tracks, fixes).files.map((entry) => [entry.file, entry.set.TRACKNUMBER]), [
    ['Album/01 Song.flac', '1/3'],
    ['Album/02 Song.flac', '2/3']
  ]);
  assert.deepEqual(cannotFix[0], { code: 'unreadable', files: ['Album/03 Broken.flac'] });
  assert.deepEqual(verdict, { code: 'tidy', albums: 1, tracks: 2 });
  assert.equal(plan([unreadable('Album/01.flac')]).verdict.code, 'unreadable');
});

test('the verdict, and what cannot be fixed here', () => {
  const split = plan(album(2, (n) => ({ ALBUM: n === 1 ? 'One' : 'Two', YEAR: n === 1 ? '2020' : '2021' })));
  assert.deepEqual(split.verdict, { code: 'split', causes: ['album', 'release_date'], albums: 2, tracks: 2 });

  const nobody = plan(album(2, () => ({ ARTIST: [], ALBUMARTIST: [] })));
  assert.deepEqual(nobody.verdict, { code: 'merged', reasons: ['unknown_artist'], albums: 1, tracks: 2 });
  assert.deepEqual(nobody.fixes.map(({ id, value }) => ({ id, value })), [{ id: 'album_artist', value: '' }]);
  assert.deepEqual(nobody.cannotFix, [{ code: 'no_artist', files: ['Album/01 Song.flac', 'Album/02 Song.flac'] }]);

  const mixed = [
    ...album(1),
    record('Album/02 Song.mp3', { TITLE: '', ARTIST: 'AA', ALBUM: 'Album', ALBUMARTIST: 'AA', TRACKNUMBER: '2/2' }, {
      hasArt: true,
      sampleRate: 48000,
      bitDepth: null,
      duration: null
    })
  ];
  mixed[0] = record('Album/01 Song.flac', { ...mixed[0].properties, TRACKNUMBER: '1/2' }, { hasArt: true });
  assert.deepEqual(plan(mixed).cannotFix, [
    { code: 'mixed_formats', formats: ['flac', 'mp3'] },
    {
      code: 'mixed_quality',
      qualities: [
        { sampleRate: 44100, bitDepth: 16, count: 1 },
        { sampleRate: 48000, bitDepth: null, count: 1 }
      ]
    },
    { code: 'no_duration', files: ['Album/02 Song.mp3'] },
    { code: 'no_title', files: ['Album/02 Song.mp3'] }
  ]);
});
