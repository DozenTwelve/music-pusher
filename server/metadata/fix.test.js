import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// fix.js resolves config.rawDir at module load, so point it at a scratch dir
// before importing it (see inspect.album.test.js).
const rawDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fix-test-'));
process.env.RAW_DIR = rawDir;
const { inspectAlbum } = await import('./inspect.js');
const { fixAlbum } = await import('./fix.js');
const { probeTags, runProcess } = await import('./probe.js');
const { config } = await import('../config.js');

// One second of a sine wave with exactly the tags given. `codec` picks the
// container's encoder; `tagArgs` go in as written, so `-metadata ALBUMARTIST=…`
// lands in a FLAC as the uppercase Vorbis comment taggers write
// (`metaflac --export-tags-to=-` shows ALBUMARTIST, TRACKNUMBER, TRACKTOTAL).
function writeTrack(file, tagArgs = [], codec = []) {
  return runProcess(config.ffmpegBin, [
    '-v', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
    ...codec,
    ...tagArgs,
    file
  ]);
}

const meta = (pairs) => pairs.flatMap((pair) => ['-metadata', pair]);

// A scratch album folder, removed afterwards. Returns null (and skips) when
// ffmpeg is not there to build the fixture.
async function album(t, name) {
  const dir = path.join(rawDir, name);
  await fsp.mkdir(dir, { recursive: true });
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const probe = await writeTrack(path.join(dir, '.probe.flac'));
  await fsp.rm(path.join(dir, '.probe.flac'), { force: true });
  if (probe.code !== 0) {
    t.skip(`ffmpeg unavailable: ${probe.stderr.trim()}`);
    return null;
  }
  return dir;
}

test('a FLAC fix replaces the uppercase Vorbis comments instead of adding a second one', async (t) => {
  const dir = await album(t, 'flac-upper');
  if (!dir) return;
  // The split the album-artist fix exists for: a trailing space on one track.
  await writeTrack(path.join(dir, '01.flac'), meta(['TITLE=One', 'ALBUM=Alb', 'ALBUMARTIST=Art ', 'TRACKNUMBER=1', 'TRACKTOTAL=2', 'DISCNUMBER=1']));
  await writeTrack(path.join(dir, '02.flac'), meta(['TITLE=Two', 'ALBUM=Alb', 'ALBUMARTIST=Art', 'TRACKNUMBER=2', 'TRACKTOTAL=2', 'DISCNUMBER=1']));

  const result = await fixAlbum('flac-upper', {
    set: { album_artist: 'Art', disc: '1', album: 'Alb' },
    normalizeTracks: true
  });
  assert.deepEqual(result.errors, []);

  // ffprobe joins repeated comments with ";", so a second ALBUMARTIST shows up
  // here as "Art ;Art".
  const tags = await probeTags(path.join(dir, '01.flac'));
  assert.equal(tags.album_artist, 'Art');
  assert.equal(tags.track, '1/2');
  assert.equal(tags.disc, '1');
  assert.equal(tags.album, 'Alb');
  assert.equal(result.after.groupCount, 1);
});

test('an Ogg fix rewrites the tags, which live on the audio stream there', async (t) => {
  const dir = await album(t, 'ogg');
  if (!dir) return;
  const ogg = ['-c:a', 'flac', '-f', 'ogg'];
  const streamMeta = (pairs) => pairs.flatMap((pair) => ['-metadata:s:a:0', pair]);
  await writeTrack(path.join(dir, '01.ogg'), streamMeta(['TITLE=One', 'ALBUM=Alb', 'ALBUMARTIST=Art ', 'TRACKNUMBER=1']), ogg);
  await writeTrack(path.join(dir, '02.ogg'), streamMeta(['TITLE=Two', 'ALBUM=Alb', 'ALBUMARTIST=Art', 'TRACKNUMBER=2']), ogg);

  const before = await inspectAlbum('ogg');
  assert.deepEqual(before.tracks.map((tr) => tr.album_artist), ['Art ', 'Art']);
  assert.equal(before.groupCount, 2);

  const result = await fixAlbum('ogg', { set: { album_artist: 'Art' }, normalizeTracks: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.after.tracks.map((tr) => [tr.album_artist, tr.track]), [['Art', '1/2'], ['Art', '2/2']]);
  assert.equal(result.after.groupCount, 1);
});

test('MP3 and M4A fixes replace the album artist and track number in place', async (t) => {
  const dir = await album(t, 'mp3-m4a');
  if (!dir) return;
  await writeTrack(path.join(dir, '01.mp3'), meta(['title=One', 'album=Alb', 'album_artist=Art ', 'track=1']), ['-c:a', 'libmp3lame']);
  await writeTrack(path.join(dir, '02.m4a'), meta(['title=Two', 'album=Alb', 'album_artist=Art ', 'track=2']), ['-c:a', 'aac']);

  const result = await fixAlbum('mp3-m4a', { set: { album_artist: 'Art' }, normalizeTracks: true });
  assert.deepEqual(result.errors, []);
  for (const [file, track] of [['01.mp3', '1/2'], ['02.m4a', '2/2']]) {
    const tags = await probeTags(path.join(dir, file));
    assert.equal(tags.album_artist, 'Art', file);
    assert.equal(tags.track, track, file);
  }
});

test('a FLAC track total kept in its own TRACKTOTAL comment counts', async (t) => {
  const dir = await album(t, 'tracktotal');
  if (!dir) return;
  // How metaflac, beets and most taggers write it: the number and the total in
  // two comments, not "1/3" in one.
  for (const n of [1, 2, 3]) {
    await writeTrack(
      path.join(dir, `0${n}.flac`),
      meta([`TITLE=T${n}`, 'ALBUM=Alb', 'ALBUMARTIST=Art', `TRACKNUMBER=${n}`, 'TRACKTOTAL=3', 'DISCNUMBER=1', 'DISCTOTAL=1'])
    );
  }

  const report = await inspectAlbum('tracktotal');
  assert.deepEqual(report.tracks.map((tr) => [tr.track, tr.disc]), [['1/3', '1/1'], ['2/3', '1/1'], ['3/3', '1/1']]);
  assert.equal(report.track.wrongTotals, 0);
  assert.equal(report.track.needsNormalize, false);
});

test('untagged discs in their own folders are numbered per folder', async (t) => {
  const dir = await album(t, 'two-disc');
  if (!dir) return;
  for (const disc of ['CD1', 'CD2']) {
    await fsp.mkdir(path.join(dir, disc));
    for (const n of [1, 2, 3]) {
      await writeTrack(path.join(dir, disc, `0${n} Song.flac`), meta([`TITLE=${disc}-${n}`, 'ALBUM=Alb', 'ALBUMARTIST=Art']));
    }
  }

  const result = await fixAlbum('two-disc', { normalizeTracks: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.after.tracks.map((tr) => `${tr.file} ${tr.disc} ${tr.track}`),
    [
      'CD1/01 Song.flac 1/2 1/3',
      'CD1/02 Song.flac 1/2 2/3',
      'CD1/03 Song.flac 1/2 3/3',
      'CD2/01 Song.flac 2/2 1/3',
      'CD2/02 Song.flac 2/2 2/3',
      'CD2/03 Song.flac 2/2 3/3'
    ]
  );
  assert.equal(result.after.track.needsNormalize, false);
});

test('numbering that runs on from one folder into the next stays one disc', async (t) => {
  const dir = await album(t, 'runs-on');
  if (!dir) return;
  // CD1/01-02 + CD2/03-04, and a Bonus/ folder carrying on from the root.
  const layout = [['CD1', 1], ['CD1', 2], ['CD2', 3], ['CD2', 4], ['', 1], ['', 2], ['', 3], ['Bonus', 4]];
  const expected = {};
  for (const [i, [folder, n]] of layout.entries()) {
    const set = i < 4 ? 'split' : 'bonus';
    await fsp.mkdir(path.join(dir, set, folder), { recursive: true });
    await writeTrack(path.join(dir, set, folder, `0${n}.flac`), meta([`TITLE=t${n}`, 'ALBUM=Alb', 'ALBUMARTIST=Art', `TRACKNUMBER=${n}`]));
    expected[set] = [...(expected[set] || []), `${n}/4 `];
  }

  for (const set of ['split', 'bonus']) {
    const result = await fixAlbum(path.join('runs-on', set), { normalizeTracks: true });
    assert.deepEqual(result.errors, [], set);
    assert.deepEqual(result.after.tracks.map((tr) => `${tr.track} ${tr.disc}`).sort(), expected[set].sort(), set);
  }
});

test('a separate track or disc total follows the total that is written', async (t) => {
  const dir = await album(t, 'stale-total');
  if (!dir) return;
  for (const n of [1, 2]) {
    await writeTrack(
      path.join(dir, `0${n}.flac`),
      meta([`TITLE=t${n}`, 'ALBUM=Alb', 'ALBUMARTIST=Art', `TRACKNUMBER=${n}`, 'TRACKTOTAL=12', 'TOTALTRACKS=12', 'DISCNUMBER=1', 'DISCTOTAL=3'])
    );
  }

  const result = await fixAlbum('stale-total', { set: { disc: '1/1' }, normalizeTracks: true });
  assert.deepEqual(result.errors, []);
  const tags = await probeTags(path.join(dir, '02.flac'));
  assert.deepEqual(
    [tags.track, tags.tracktotal, tags.totaltracks, tags.disc, tags.disctotal],
    ['2/2', '2', '2', '1/1', '1']
  );
});

test('track numbers that repeat on one disc are reported, never written', async (t) => {
  const dir = await album(t, 'dup-numbers');
  if (!dir) return;
  // Both start with 01, neither has a track tag: renumbering them both as 1/3
  // would bake the collision into the tags.
  await writeTrack(path.join(dir, '01 A.flac'), meta(['TITLE=A', 'ALBUM=Alb', 'ALBUMARTIST=Art']));
  await writeTrack(path.join(dir, '01 B.flac'), meta(['TITLE=B', 'ALBUM=Alb', 'ALBUMARTIST=Art']));
  await writeTrack(path.join(dir, '02 C.flac'), meta(['TITLE=C', 'ALBUM=Alb', 'ALBUMARTIST=Art']));

  const result = await fixAlbum('dup-numbers', { normalizeTracks: true });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.errors.map((e) => e.file), ['01 A.flac', '01 B.flac']);
  assert.match(result.errors[0].message, /track 1 .*01 B\.flac/);
  assert.deepEqual(result.after.tracks.map((tr) => tr.track), ['', '', '']);
});

test('a renamed track takes its lyrics and other same-stem files along', async (t) => {
  const dir = await album(t, 'sidecars');
  if (!dir) return;
  await writeTrack(path.join(dir, '01 Don_t Stop.flac'), meta(['TITLE=Don_t Stop', 'ALBUM=Alb', 'ALBUMARTIST=Art']));
  await fsp.writeFile(path.join(dir, '01 Don_t Stop.lrc'), '[00:00.00]la\n');
  await fsp.writeFile(path.join(dir, '01 Don_t Stop.en.lrc'), '[00:00.00]la\n');
  await fsp.writeFile(path.join(dir, '01 Don_t Stop.jpg'), 'img');
  // Shares the first characters of the stem, not the stem.
  await fsp.writeFile(path.join(dir, '01 Don_t Stopping.txt'), 'other');

  const result = await fixAlbum('sidecars', { fixFilenames: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual((await fsp.readdir(dir)).sort(), [
    "01 Don't Stop.en.lrc",
    "01 Don't Stop.flac",
    "01 Don't Stop.jpg",
    "01 Don't Stop.lrc",
    '01 Don_t Stopping.txt'
  ]);
  assert.deepEqual(result.renames.map((r) => r.to).sort(), [
    "01 Don't Stop.en.lrc",
    "01 Don't Stop.flac",
    "01 Don't Stop.jpg",
    "01 Don't Stop.lrc"
  ]);
});

test('a track next to a .cue keeps its name, so the sheet still finds it', async (t) => {
  const dir = await album(t, 'cue');
  if (!dir) return;
  await writeTrack(path.join(dir, '01 Don_t Stop.flac'), meta(['TITLE=Don_t Stop', 'ALBUM=Alb', 'ALBUMARTIST=Art']));
  await fsp.writeFile(path.join(dir, '01 Don_t Stop.lrc'), '[00:00.00]la\n');
  await fsp.writeFile(path.join(dir, 'Alb.cue'), 'FILE "01 Don_t Stop.flac" WAVE\n  TRACK 01 AUDIO\n');

  const result = await fixAlbum('cue', { fixFilenames: true });
  assert.deepEqual(result.renames, []);
  assert.deepEqual(result.errors.map((e) => e.file), ['01 Don_t Stop.flac']);
  assert.match(result.errors[0].message, /\.cue/);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['01 Don_t Stop.flac', '01 Don_t Stop.lrc', 'Alb.cue']);
});

// ffmpeg cannot write an m4a's freeform atoms back, so a RELEASEDATE there is
// lost on any rewrite and ©day becomes the release date. `use_metadata_tags`
// is the one way ffmpeg can put a RELEASEDATE into an m4a at all; ffprobe reads
// it under the same name as a Picard-written freeform atom, and a plain rewrite
// drops it the same way.
function writeM4a(file, pairs) {
  return writeTrack(file, meta(pairs), ['-c:a', 'aac', '-movflags', 'use_metadata_tags']);
}

test('an m4a fix never moves the release date onto the recording date', async (t) => {
  const dir = await album(t, 'm4a-release');
  if (!dir) return;
  // One album released 2020-05-01, its tracks recorded in two years.
  const base = ['album=Alb', 'album_artist=Art ', 'RELEASEDATE=2020-05-01'];
  await writeM4a(path.join(dir, '01.m4a'), ['title=One', 'date=1998', ...base]);
  await writeM4a(path.join(dir, '02.m4a'), ['title=Two', 'date=1999', ...base]);

  const before = await inspectAlbum('m4a-release');
  assert.deepEqual(before.fields.release_date.distinct.map((d) => d.value), ['2020-05-01']);

  // The album artist fix alone would leave 1998 and 1999 in ©day, the only
  // dates left: two albums where there was one.
  const result = await fixAlbum('m4a-release', { set: { album_artist: 'Art' } });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.errors.map((e) => e.file), ['01.m4a', '02.m4a']);
  assert.match(result.errors[0].message, /release date 2020-05-01/);
  assert.deepEqual(result.after.fields.release_date.distinct.map((d) => d.value), ['2020-05-01']);
});

test('an m4a date the user sets goes in, even over a RELEASEDATE', async (t) => {
  const dir = await album(t, 'm4a-set-date');
  if (!dir) return;
  // Split by RELEASEDATE; setting the date is how the user merges it.
  await writeM4a(path.join(dir, '01.m4a'), ['title=One', 'album=Alb', 'album_artist=Art', 'date=2020', 'RELEASEDATE=2020']);
  await writeM4a(path.join(dir, '02.m4a'), ['title=Two', 'album=Alb', 'album_artist=Art', 'date=2020', 'RELEASEDATE=2021']);
  assert.equal((await inspectAlbum('m4a-set-date')).groupCount, 2);

  const result = await fixAlbum('m4a-set-date', { set: { date: '2020' } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.changes.length, 2);
  assert.equal(result.after.groupCount, 1);
});

test('an m4a whose release date is ©day itself still takes a date fix', async (t) => {
  const dir = await album(t, 'm4a-day');
  if (!dir) return;
  await writeM4a(path.join(dir, '01.m4a'), ['title=One', 'album=Alb', 'album_artist=Art', 'date=2020']);
  await writeM4a(path.join(dir, '02.m4a'), ['title=Two', 'album=Alb', 'album_artist=Art', 'date=2020-05-01']);
  // A RELEASEDATE that agrees with what ©day will say is no loss either.
  await writeM4a(path.join(dir, '03.m4a'), ['title=Three', 'album=Alb', 'album_artist=Art', 'date=2020', 'RELEASEDATE=2020-05-01']);

  const result = await fixAlbum('m4a-day', { set: { date: '2020-05-01' } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.changes.length, 3);
  assert.equal(result.after.groupCount, 1);
  assert.deepEqual(result.after.fields.release_date.distinct.map((d) => d.value), ['2020-05-01']);
});
