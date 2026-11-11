import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GROUND_TRUTH, BY_RULE } from '../../shared/navidrome.groundtruth.js';

// The diagnosis has to count albums the way Navidrome does. Every case below is
// built with ffmpeg and read back through the server's own reader (ffprobe).
//
// inspect.js resolves config.rawDir at module load, so point it at a scratch dir
// before importing it (same trick as inspect.album.test.js).
const rawDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inspect-navidrome-'));
process.env.RAW_DIR = rawDir;
const { inspectAlbum } = await import('./inspect.js');
const { fixAlbum } = await import('./fix.js');
const { runProcess } = await import('./probe.js');
const { config } = await import('../config.js');

after(() => fsp.rm(rawDir, { recursive: true, force: true }));

const SINE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100'];
const ffmpegAvailable = (await runProcess(config.ffmpegBin, ['-version'])).code === 0;
const metaflacAvailable = (await runProcess('metaflac', ['--version'])).code === 0;

async function writeTrack(album, file, tags) {
  const target = path.join(rawDir, album, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const metadata = Object.entries(tags).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
  const result = await runProcess(config.ffmpegBin, ['-v', 'error', '-y', ...SINE, ...metadata, target]);
  assert.equal(result.code, 0, `ffmpeg could not write ${file}: ${result.stderr}`);
}

async function build({ id, files }) {
  for (const [file, tags] of files) {
    await writeTrack(id, file, tags);
  }
}

for (const album of [...GROUND_TRUTH, ...BY_RULE]) {
  const gap = album.knownGaps?.server;
  test(`${album.id}: tracks differ in ${album.differs} — ${album.albums} album${album.albums > 1 ? 's' : ''}${gap ? ' (known gap)' : ''}`, async (t) => {
    if (!ffmpegAvailable) {
      t.skip('ffmpeg unavailable');
      return;
    }
    await build(album);
    const report = await inspectAlbum(album.id);
    assert.equal(report.ok, true);
    if (gap) {
      // What the server reports instead, and why it cannot do better. If this
      // starts failing the gap has closed: drop the marker from the case.
      assert.equal(report.groupCount, gap.groupCount, `expected the known gap: ${gap.why}`);
      assert.notEqual(gap.groupCount, album.albums);
      return;
    }
    assert.equal(report.groupCount, album.albums);
    assert.equal(report.splitFields.length > 0, album.albums > 1, `causes: ${report.splitFields}`);
    if (album.albumArtist) {
      assert.equal(report.fields.album_artist.proposed, album.albumArtist);
    }
  });
}

test('each ground-truth split names the ingredient that differs', async (t) => {
  if (!ffmpegAvailable) {
    t.skip('ffmpeg unavailable');
    return;
  }
  const causes = {};
  for (const album of GROUND_TRUTH.filter((c) => c.albums > 1)) {
    await build(album);
    causes[album.id] = (await inspectAlbum(album.id)).splitFields;
  }
  assert.deepEqual(causes, {
    T01: ['release_date'],
    T04: ['release_date'],
    T07: ['album_artist'],
    T10: ['album'],
    T12: ['musicbrainz_albumid'],
    T15: ['album_artist'],
    T16: ['release_date'],
    T18: ['album_version'],
    T19: ['release_date'],
    T20: ['album'],
    T21: ['album']
  });
});

// The multi-valued gap. A FLAC with two ARTISTS comments comes back from
// ffprobe as "A;B"; the same tag in an MP3 comes back as "A", its first value.
// With no album artist the album artist is derived from that tag, so reading
// the two strings as they come made two albums of one. (ffmpeg cannot write a
// second TXXX value, so the MP3 here carries the one value ffprobe would have
// shown anyway; web/spike.test.js runs the same check on files that really hold
// two values in all three containers.)
test('a mixed-format album with multi-valued ARTISTS and no album artist is one album', async (t) => {
  if (!ffmpegAvailable || !metaflacAvailable) {
    t.skip('ffmpeg or metaflac unavailable');
    return;
  }
  const album = 'multi-valued artists';
  const shared = { album: 'Mixed', artist: 'A feat. B' };
  await writeTrack(album, '01.flac', { ...shared, title: 'One' });
  const flac = path.join(rawDir, album, '01.flac');
  const tagged = await runProcess('metaflac', ['--set-tag=ARTISTS=A', '--set-tag=ARTISTS=B', flac]);
  assert.equal(tagged.code, 0, tagged.stderr);
  await writeTrack(album, '02.mp3', { ...shared, title: 'Two', ARTISTS: 'A' });
  await writeTrack(album, '03.flac', { ...shared, title: 'Three' });

  const report = await inspectAlbum(album);

  // The strings ffprobe hands over still differ...
  assert.deepEqual(report.tracks.map((track) => track.artists), ['A;B', 'A', '']);
  // ...the value lists do not, where it matters: the first value.
  assert.deepEqual(report.tracks.map((track) => track.artists_values), [['A', 'B'], ['A'], []]);
  assert.equal(report.groupCount, 1);
  assert.deepEqual(report.splitFields, []);
  assert.deepEqual(report.fields.album_artist.distinct, [{ value: 'A', count: 3 }]);
});

test('an m4a release-date split is one the Fix form already repairs, and the report says so', async (t) => {
  if (!ffmpegAvailable) {
    t.skip('ffmpeg unavailable');
    return;
  }
  const album = 'm4a day fix';
  await build({ ...GROUND_TRUTH.find((c) => c.id === 'T16'), id: album });

  const before = await inspectAlbum(album);
  assert.equal(before.groupCount, 2);
  assert.deepEqual(before.splitFields, ['release_date']);
  assert.deepEqual(before.fields.release_date.distinct, [
    { value: '2020', count: 1 },
    { value: '2020-05-01', count: 1 }
  ]);
  // In an m4a the release date is the ©day atom, which is the record's `date`:
  // the Date row is inconsistent, carries a proposal, and unifying it is enough.
  assert.equal(before.fields.release_date.followsDate, true);
  assert.equal(before.fields.date.consistent, false);
  assert.equal(before.fields.date.proposed, '2020');

  const result = await fixAlbum(album, { set: { date: before.fields.date.proposed } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.after.groupCount, 1);
  assert.deepEqual(result.after.splitFields, []);
});

test('a FLAC release-date split is not one unifying the date repairs', async (t) => {
  if (!ffmpegAvailable) {
    t.skip('ffmpeg unavailable');
    return;
  }
  const album = 'flac releasedate fix';
  await build({ ...GROUND_TRUTH.find((c) => c.id === 'T19'), id: album });

  const before = await inspectAlbum(album);
  assert.deepEqual(before.splitFields, ['release_date']);
  assert.equal(before.fields.release_date.followsDate, false);

  // DATE is written; RELEASEDATE, which is what splits, is left as it was.
  const result = await fixAlbum(album, { set: { date: '2020-01-01' } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.after.groupCount, 2);
});

test('tracks Navidrome would file with other music are reported', async (t) => {
  if (!ffmpegAvailable) {
    t.skip('ffmpeg unavailable');
    return;
  }
  const album = 'merge warnings';
  await writeTrack(album, '01.flac', { ALBUM: 'Named', ARTIST: 'Someone', TITLE: 'One' });
  await writeTrack(album, '02.flac', { ARTIST: 'Someone', TITLE: 'Two' });
  await writeTrack(album, '03.flac', { ALBUM: 'Named', TITLE: 'Three' });
  await writeTrack(album, '04.flac', { TITLE: 'Four' });
  // A MusicBrainz album id is an identity of its own: no merge either way.
  await writeTrack(album, '05.flac', { TITLE: 'Five', MUSICBRAINZ_ALBUMID: '11111111-2222-4333-8444-555555555555' });

  const report = await inspectAlbum(album);

  assert.deepEqual(report.mergeWarnings, [
    { reason: 'no_album', files: ['02.flac', '04.flac'] },
    { reason: 'unknown_artist', files: ['03.flac', '04.flac'] }
  ]);
  // The clean albums of the ground truth carry no such warning.
  await build(GROUND_TRUTH[1]);
  assert.deepEqual((await inspectAlbum(GROUND_TRUTH[1].id)).mergeWarnings, []);
});
