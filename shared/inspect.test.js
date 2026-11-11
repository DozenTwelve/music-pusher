import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumBase, diagnoseAlbum } from './inspect.js';

test('albumBase strips trailing bracket markers so variants match', () => {
  const base = 'The Scholars';
  assert.equal(albumBase('The Scholars [Explicit]'), base);
  assert.equal(albumBase('The Scholars'), base);
  assert.equal(albumBase('The Scholars (Deluxe Edition)'), base);
  assert.equal(albumBase('The Scholars (Deluxe) [Explicit]'), base); // multiple trailing groups
  assert.equal(albumBase('The Scholars [Explicit] '), base); // trailing space
});

test('albumBase keeps a mid-name bracket (not a trailing marker)', () => {
  assert.equal(albumBase('Album [Live] Sessions'), 'Album [Live] Sessions');
});

// --- The split verdict, on plain track records -------------------------------

const cp = String.fromCharCode;
const MBID = '11111111-2222-4333-8444-555555555555';
let counter = 0;
const track = (tags = {}) => ({
  file: `${String((counter += 1)).padStart(2, '0')}.flac`,
  readable: true,
  title: 'T',
  artist: 'AA',
  album: 'Album',
  album_artist: 'AA',
  ...tags
});
const diagnose = (...tracks) => diagnoseAlbum('x', tracks, []);

test('splitFields names the ingredient of the identity that differs', () => {
  const causes = (a, b) => {
    const report = diagnose(track(a), track(b));
    return [report.groupCount, report.splitFields];
  };
  assert.deepEqual(causes({}, {}), [1, []]);
  assert.deepEqual(causes({ album: 'A' }, { album: 'B' }), [2, ['album']]);
  assert.deepEqual(causes({ album_artist: 'A' }, { album_artist: 'B' }), [2, ['album_artist']]);
  assert.deepEqual(causes({ release_date: '2020' }, { release_date: '2021' }), [2, ['release_date']]);
  assert.deepEqual(causes({ release_date: '2020' }, {}), [2, ['release_date']]);
  assert.deepEqual(causes({ album_version: 'Deluxe' }, {}), [2, ['album_version']]);
  assert.deepEqual(causes({ musicbrainz_albumid: MBID }, {}), [2, ['musicbrainz_albumid']]);
  assert.deepEqual(
    causes({ album: 'A', release_date: '2020' }, { album: 'B', album_version: 'Deluxe' }),
    [2, ['album', 'release_date', 'album_version']]
  );
  // The recording date is never a cause.
  assert.deepEqual(causes({ date: '2020' }, { date: '2021' }), [1, []]);
});

test('what the comparison ignores is not a split, and is still offered for unifying', () => {
  for (const [field, a, b] of [
    ['album', 'Don' + cp(0x2019) + 't Stop', "don't stop"],
    ['album_artist', 'The Band', 'THE BAND'],
    ['album', 'A ' + cp(0x2013) + ' B', 'A - B']
  ]) {
    const report = diagnose(track({ [field]: a }), track({ [field]: a }), track({ [field]: b }));
    assert.equal(report.groupCount, 1, `${a} / ${b}`);
    assert.deepEqual(report.splitFields, []);
    // Two spellings are on file, and the majority one is proposed as written —
    // not the lowercased form the comparison uses.
    assert.equal(report.fields[field].consistent, false);
    assert.deepEqual(report.fields[field].distinct, [{ value: a, count: 2 }, { value: b, count: 1 }]);
    assert.equal(report.fields[field].proposed, a);
  }
});

test('spacing, encoding and marker differences still split, with their proposals', () => {
  const nbsp = diagnose(track({ album: 'Test Album' }), track({ album: `Test${cp(0xa0)}Album` }));
  assert.equal(nbsp.groupCount, 2);
  assert.deepEqual(nbsp.splitFields, ['album']);
  assert.equal(nbsp.fields.album.whitespaceOnly, true);
  assert.equal(nbsp.fields.album.proposed, 'Test Album');

  const nfd = diagnose(track({ album: `Caf${cp(0xe9)}` }), track({ album: `Cafe${cp(0x0301)}` }));
  assert.equal(nfd.groupCount, 2);
  assert.equal(nfd.fields.album.whitespaceOnly, true);
  assert.equal(nfd.fields.album.proposed, `Caf${cp(0xe9)}`);

  const trailing = diagnose(track({ album_artist: 'AA' }), track({ album_artist: 'AA ' }));
  assert.equal(trailing.groupCount, 2);
  assert.deepEqual(trailing.splitFields, ['album_artist']);
  assert.equal(trailing.fields.album_artist.whitespaceOnly, true);
  assert.equal(trailing.fields.album_artist.proposed, 'AA');

  const marker = diagnose(track({ album: 'The Scholars' }), track({ album: 'The Scholars' }), track({ album: 'The Scholars [Explicit]' }));
  assert.equal(marker.groupCount, 2);
  assert.deepEqual(marker.splitFields, ['album']);
  assert.equal(marker.fields.album.variantOnly, true);
  assert.equal(marker.fields.album.proposed, 'The Scholars [Explicit]');
});

test('a shared MusicBrainz album id overrides every other difference', () => {
  const pinned = diagnose(
    track({ musicbrainz_albumid: MBID, album: 'One', release_date: '2020' }),
    track({ musicbrainz_albumid: MBID, album: 'Other', release_date: '2021', album_version: 'Deluxe' })
  );
  assert.equal(pinned.groupCount, 1);
  assert.deepEqual(pinned.splitFields, []);
  // The names still differ on file and can be unified.
  assert.equal(pinned.fields.album.consistent, false);

  // Tracks without the id are told apart by their tags; a difference among the
  // tracks that have it is not a cause.
  const mixed = diagnose(
    track({ musicbrainz_albumid: MBID, album: 'One' }),
    track({ musicbrainz_albumid: MBID, album: 'Other' }),
    track({ album: 'Album', release_date: '2020' }),
    track({ album: 'Album', release_date: '2021' })
  );
  assert.equal(mixed.groupCount, 3);
  assert.deepEqual(mixed.splitFields, ['release_date', 'musicbrainz_albumid']);

  // An id that is not a UUID is no id.
  const invalid = diagnose(track({ musicbrainz_albumid: 'nope' }), track());
  assert.equal(invalid.groupCount, 1);
  assert.deepEqual(invalid.fields.musicbrainz_albumid.distinct, []);
});

test('the identity ingredients are summarized as they are compared', () => {
  const report = diagnose(
    track({ release_date: '2020-05-01T00:00:00', album_version: 'Deluxe', musicbrainz_albumid: MBID }),
    track({ release_date: '2020-05-01' }),
    track({ release_date: 'unknown' })
  );
  assert.deepEqual(report.fields.release_date.distinct, [{ value: '2020-05-01', count: 2 }]);
  assert.equal(report.fields.release_date.missing, 1);
  assert.deepEqual(report.fields.album_version.distinct, [{ value: 'Deluxe', count: 1 }]);
  assert.deepEqual(report.fields.musicbrainz_albumid.distinct, [{ value: MBID, count: 1 }]);
});

test('followsDate: unifying the date unifies the release date only where one tag holds both', () => {
  const follows = (...tracks) => diagnose(...tracks).fields.release_date.followsDate;
  assert.equal(follows(track({ release_date_follows_date: true }), track({ release_date_follows_date: true })), true);
  assert.equal(follows(track({ release_date_follows_date: true }), track({ release_date_follows_date: false })), false);
  assert.equal(follows(track(), track()), false);
  // A track grouped by its MusicBrainz id has no say.
  assert.equal(follows(track({ release_date_follows_date: true }), track({ musicbrainz_albumid: MBID })), true);
  assert.equal(follows(track({ musicbrainz_albumid: MBID })), false);
});

test('the album artist shown is the one Navidrome settles on, as a readable name', () => {
  const shown = (...tracks) => diagnose(...tracks).fields.album_artist;
  // Derived from the first artist: a guest does not make a second value.
  assert.deepEqual(
    shown(track({ album_artist: '', artist: 'Solo' }), track({ album_artist: '', artist: 'Solo feat. Guest' })).distinct,
    [{ value: 'Solo', count: 2 }]
  );
  // An explicit album artist on one track, equal to the other's artist.
  assert.equal(shown(track({ album_artist: 'Solo', artist: 'Solo' }), track({ album_artist: '', artist: 'Solo' })).consistent, true);
  // The compilation flag.
  assert.equal(
    shown(track({ album_artist: '', artist: 'A', compilation: '1' }), track({ album_artist: '', artist: 'B', compilation: '1' })).proposed,
    'Various Artists'
  );
  // Proposed in its own letter case, and never as "[Unknown Artist]".
  assert.equal(shown(track({ album_artist: 'The BAND' })).proposed, 'The BAND');
  const none = shown(track({ album_artist: '', artist: '' }), track({ album_artist: '', artist: '' }));
  assert.deepEqual([none.proposed, none.missing, none.consistent], ['', 2, true]);
});

test('mergeWarnings: tracks that would be filed with music that is not this album', () => {
  counter = 0;
  const report = diagnose(
    track(),
    track({ album: '' }),
    track({ album_artist: '', artist: '' }),
    track({ album: '', album_artist: '', artist: '' }),
    // A compilation flag is an album artist; a MusicBrainz id is an identity.
    track({ album_artist: '', artist: '', compilation: '1' }),
    track({ album: '', album_artist: '', artist: '', musicbrainz_albumid: MBID }),
    // Unreadable files are reported as unreadable and nothing else.
    { file: '07.flac', readable: false, album: '', artist: '' }
  );
  assert.deepEqual(report.mergeWarnings, [
    { reason: 'no_album', files: ['02.flac', '04.flac'] },
    { reason: 'unknown_artist', files: ['03.flac', '04.flac'] }
  ]);
  assert.deepEqual(diagnose(track(), track()).mergeWarnings, []);
});
