import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// inspect.js resolves config.rawDir at module load, so point it at a scratch dir
// before importing it. dotenv does not overwrite an already-set variable, so the
// developer's real .env cannot drag this test into the live staging folder.
const rawDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inspect-test-'));
process.env.RAW_DIR = rawDir;
const { inspectAlbum } = await import('./inspect.js');
const { fixAlbum } = await import('./fix.js');
const { runProcess } = await import('./probe.js');
const { config } = await import('../config.js');

// A FLAC whose STREAMINFO says total_samples=0, which is what ffmpeg leaves
// behind when it cannot seek back to the header to fill the count in. Writing
// to a pipe reproduces that exactly — the same shape a stream transcode
// produces, and the reason a whole album can land in the library with no
// playable length on any track.
function writeLengthlessTrack(dir, file) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(dir, file));
    const proc = spawn(
      config.ffmpegBin,
      [
        '-v', 'error', '-y',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
        '-metadata', 'album=Test Album',
        '-metadata', 'album_artist=Test Artist',
        '-metadata', 'title=Lengthless',
        '-metadata', 'artist=Test Artist',
        '-c:a', 'flac',
        '-f', 'flac',
        'pipe:1'
      ],
      { shell: false }
    );
    proc.stdout.pipe(out);
    proc.on('error', () => resolve({ code: -1 }));
    out.on('close', () => resolve({ code: 0 }));
  });
}

// One second of a sine wave, tagged as a normal album track.
function writeTrack(dir, file, args = []) {
  return runProcess(config.ffmpegBin, [
    '-v', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=1:sample_rate=44100',
    '-metadata', 'album=Test Album',
    '-metadata', 'album_artist=Test Artist',
    ...args,
    path.join(dir, file)
  ]);
}

test('an unreadable file is reported, not read as a tag split', async (t) => {
  const album = `__inspect_test_${process.pid}`;
  const dir = path.join(rawDir, album);
  await fsp.mkdir(dir, { recursive: true });

  try {
    const first = await writeTrack(dir, '01.flac');
    if (first.code !== 0) {
      t.skip(`ffmpeg unavailable: ${first.stderr.trim()}`);
      return;
    }
    await writeTrack(dir, '02.flac');
    // A truncated download: correct extension, nothing ffprobe can parse.
    await fsp.writeFile(path.join(dir, '03.flac'), 'not audio');

    const report = await inspectAlbum(album);

    assert.equal(report.ok, true);
    assert.deepEqual(report.unreadable, ['03.flac']);
    // Before the fix the broken file contributed an empty album/album_artist,
    // which read as a second album and hard-blocked the import.
    assert.equal(report.groupCount, 1);
    assert.deepEqual(report.splitFields, []);
    // ...and a null/null bucket, which read as a second audio quality.
    assert.equal(report.mixedQuality, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('genuinely differing album tags still count as a split', async (t) => {
  const album = `__inspect_test_split_${process.pid}`;
  const dir = path.join(rawDir, album);
  await fsp.mkdir(dir, { recursive: true });

  try {
    const first = await writeTrack(dir, '01.flac');
    if (first.code !== 0) {
      t.skip(`ffmpeg unavailable: ${first.stderr.trim()}`);
      return;
    }
    await writeTrack(dir, '02.flac', ['-metadata', 'album=Other Album']);

    const report = await inspectAlbum(album);

    assert.equal(report.groupCount, 2);
    assert.deepEqual(report.splitFields, ['album']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('tracks with no title are reported even though nothing splits', async (t) => {
  const album = `__inspect_test_required_${process.pid}`;
  const dir = path.join(rawDir, album);
  await fsp.mkdir(dir, { recursive: true });

  try {
    // One fully tagged track, one carrying only what the album shares — the
    // `空洞です` shape. `artists` stands in for `artist` on the second file, so a
    // missing `artist` alone is not enough to report.
    const first = await writeTrack(dir, '01.flac', [
      '-metadata', 'title=First',
      '-metadata', 'artist=Test Artist'
    ]);
    if (first.code !== 0) {
      t.skip(`ffmpeg unavailable: ${first.stderr.trim()}`);
      return;
    }
    await writeTrack(dir, '02.flac', ['-metadata', 'artists=Test Artist']);

    const report = await inspectAlbum(album);

    // The album agrees with itself on everything that groups it...
    assert.equal(report.groupCount, 1);
    assert.deepEqual(report.splitFields, []);
    // ...and would still reach the library with a blank name in it.
    assert.deepEqual(report.missingRequired, [{ field: 'title', files: ['02.flac'] }]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a track with no readable length is reported and repaired losslessly', async (t) => {
  const album = `__inspect_test_duration_${process.pid}`;
  const dir = path.join(rawDir, album);
  await fsp.mkdir(dir, { recursive: true });

  try {
    const first = await writeTrack(dir, '01.flac', [
      '-metadata', 'title=First',
      '-metadata', 'artist=Test Artist'
    ]);
    if (first.code !== 0) {
      t.skip(`ffmpeg unavailable: ${first.stderr.trim()}`);
      return;
    }
    await writeLengthlessTrack(dir, '02.flac');

    const before = await inspectAlbum(album);
    assert.deepEqual(before.noDuration, ['02.flac']);
    assert.deepEqual(before.durationRepairable, ['02.flac']);

    // The audio has to survive the re-encode bit for bit — that is the whole
    // basis for defaulting the repair on.
    const decode = (file) =>
      runProcess(config.ffmpegBin, ['-v', 'error', '-i', path.join(dir, file), '-f', 's16le', '-']);
    const audioBefore = (await decode('02.flac')).stdout;

    const result = await fixAlbum(album, { repairDuration: true });
    assert.deepEqual(result.errors, []);

    const after = await inspectAlbum(album);
    assert.deepEqual(after.noDuration, []);
    assert.equal((await decode('02.flac')).stdout, audioBefore);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a bogus release id is refused before beets is ever spawned', async () => {
  const { startImport } = await import('../shell.js');
  const result = await startImport('anything', { releaseId: '; rm -rf /' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad_release_id');
});

test('a differing sample rate is flagged as mixed quality', async (t) => {
  const album = `__inspect_test_quality_${process.pid}`;
  const dir = path.join(rawDir, album);
  await fsp.mkdir(dir, { recursive: true });

  try {
    const first = await writeTrack(dir, '01.flac');
    if (first.code !== 0) {
      t.skip(`ffmpeg unavailable: ${first.stderr.trim()}`);
      return;
    }
    await writeTrack(dir, '02.flac', ['-ar', '96000']);

    const report = await inspectAlbum(album);

    assert.equal(report.mixedQuality, true);
    // Bit depth must survive ffprobe's string-typed bits_per_raw_sample.
    assert.deepEqual(
      report.qualities.map((q) => `${q.sampleRate}/${q.bitDepth}`).sort(),
      ['44100/16', '96000/16']
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
