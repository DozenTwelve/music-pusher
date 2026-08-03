import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// inspect.js resolves config.rawDir at module load, so point it at a scratch dir
// before importing it. dotenv does not overwrite an already-set variable, so the
// developer's real .env cannot drag this test into the live staging folder.
const rawDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inspect-test-'));
process.env.RAW_DIR = rawDir;
const { inspectAlbum } = await import('./inspect.js');
const { runProcess } = await import('./probe.js');
const { config } = await import('../config.js');

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
