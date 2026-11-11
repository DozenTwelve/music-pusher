import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';

// Characterization of inspectAlbum(): every scenario below builds a real album
// with ffmpeg and compares the WHOLE report against a recorded one, key for key.
// The existing tests each pin the two or three fields their bug was about; this
// one exists so that moving the diagnosis somewhere else cannot change any
// field nobody happened to be looking at.
//
// inspect.js resolves config.rawDir at module load, so point it at a scratch dir
// before importing it (same trick as inspect.album.test.js).
const rawDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inspect-report-'));
process.env.RAW_DIR = rawDir;
const { inspectAlbum } = await import('./inspect.js');
const { runProcess } = await import('./probe.js');
const { config } = await import('../config.js');

after(() => fsp.rm(rawDir, { recursive: true, force: true }));

const GOLDEN_PATH = url.fileURLToPath(new URL('./inspect.report.golden.json', import.meta.url));
// UPDATE_GOLDEN=1 rewrites the recorded reports from whatever the code does now.
// That is for a deliberate rule change, reviewed as a diff of the JSON — never a
// way to turn a failing run green.
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const golden = UPDATE ? {} : JSON.parse(await fsp.readFile(GOLDEN_PATH, 'utf8'));

const cp = String.fromCharCode;
const NBSP = cp(0x00a0);
const ZERO_WIDTH_SPACE = cp(0x200b);

const SINE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100'];
const ffmpegAvailable = (await runProcess(config.ffmpegBin, ['-version'])).code === 0;

// A real JPEG to embed, kept outside every album folder so it never shows up as
// a loose folder image.
const coverPath = path.join(rawDir, '__cover.jpg');
if (ffmpegAvailable) {
  await runProcess(config.ffmpegBin, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=16x16',
    '-frames:v', '1',
    coverPath
  ]);
}

// One second of a sine wave carrying exactly the tags it is handed — no
// defaults, so each scenario shows everything its tracks have.
async function writeTrack(albumDir, file, tags = {}, { rate, art = false } = {}) {
  const target = path.join(albumDir, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const args = ['-v', 'error', '-y', ...SINE];
  if (art) {
    args.push('-i', coverPath, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  }
  if (rate) {
    args.push('-ar', String(rate));
  }
  for (const [key, value] of Object.entries(tags)) {
    args.push('-metadata', `${key}=${value}`);
  }
  args.push(target);
  const result = await runProcess(config.ffmpegBin, args);
  assert.equal(result.code, 0, `ffmpeg could not write ${file}: ${result.stderr}`);
}

// A FLAC whose STREAMINFO says total_samples=0 — ffmpeg writing to a pipe it
// cannot seek back in. Same shape as inspect.album.test.js builds.
async function writeLengthlessTrack(albumDir, file, tags = {}) {
  const target = path.join(albumDir, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  return new Promise((resolve) => {
    const out = fs.createWriteStream(target);
    const args = ['-v', 'error', '-y', ...SINE];
    for (const [key, value] of Object.entries(tags)) {
      args.push('-metadata', `${key}=${value}`);
    }
    args.push('-c:a', 'flac', '-f', 'flac', 'pipe:1');
    const proc = spawn(config.ffmpegBin, args, { shell: false });
    proc.stdout.pipe(out);
    out.on('close', resolve);
  });
}

const shared = { album: 'Test Album', album_artist: 'Test Artist', artist: 'Test Artist' };

const SCENARIOS = {
  // Nothing to report: full tags, numbered n/N, one disc, art in every track.
  clean: async (dir) => {
    const titles = ['First', 'Second', 'Third'];
    for (const [i, title] of titles.entries()) {
      await writeTrack(
        dir,
        `0${i + 1} ${title}.flac`,
        { ...shared, title, date: '2024-03-01', track: `${i + 1}/3`, disc: '1/1' },
        { art: true }
      );
    }
  },

  // Two tracks under one album artist, one under another: two albums.
  'split by album_artist': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One', album_artist: 'Artist A' });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two', album_artist: 'Artist A' });
    await writeTrack(dir, '03.flac', { ...shared, title: 'Three', album_artist: 'Artist B' });
  },

  // No album_artist anywhere, so the anchor is derived per track: `artists`
  // where present, else `artist`. A featured guest moves it.
  'split by derived artist anchor': async (dir) => {
    await writeTrack(dir, '01.flac', { album: 'Test Album', title: 'One', artist: 'Main' });
    await writeTrack(dir, '02.flac', { album: 'Test Album', title: 'Two', artist: 'Main' });
    await writeTrack(dir, '03.flac', {
      album: 'Test Album',
      title: 'Three',
      artist: 'Main',
      artists: 'Main; Guest'
    });
  },

  // The Amazon/Lucida shape: one album, with and without a trailing marker,
  // and the marked form in the minority.
  'album name variants': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One', album: 'The Scholars' });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two', album: 'The Scholars' });
    await writeTrack(dir, '03.flac', { ...shared, title: 'Three', album: 'The Scholars [Explicit]' });
  },

  // Values that differ only by NBSP and doubled spaces.
  'whitespace-only drift': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One' });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two', album: `Test${NBSP}Album` });
    await writeTrack(dir, '03.flac', { ...shared, title: 'Three', album_artist: 'Test  Artist' });
  },

  // Two discs in subfolders. Disc 1 declares three tracks and holds two (a
  // trailing gap and wrong totals); disc 2 skips number 2.
  'multi-disc with a gap and wrong totals': async (dir) => {
    await writeTrack(dir, 'CD1/01 One.flac', { ...shared, title: 'One', track: '1/3', disc: '1/2' });
    await writeTrack(dir, 'CD1/02 Two.flac', { ...shared, title: 'Two', track: '2/3', disc: '1/2' });
    await writeTrack(dir, 'CD2/01 Three.flac', { ...shared, title: 'Three', track: '1/2', disc: '2/2' });
    await writeTrack(dir, 'CD2/03 Four.flac', { ...shared, title: 'Four', track: '3/2', disc: '2/2' });
  },

  // Two discs whose totals count the whole album (4 on every track). A total
  // like that cannot show a missing last track, so none is reported — only
  // that the totals are not per disc.
  'multi-disc with album-wide totals': async (dir) => {
    await writeTrack(dir, 'CD1/01 One.flac', { ...shared, title: 'One', track: '1/4', disc: '1' });
    await writeTrack(dir, 'CD1/02 Two.flac', { ...shared, title: 'Two', track: '2/4', disc: '1' });
    await writeTrack(dir, 'CD2/01 Three.flac', { ...shared, title: 'Three', track: '1/4', disc: '2' });
    await writeTrack(dir, 'CD2/02 Four.flac', { ...shared, title: 'Four', track: '2/4', disc: '2' });
  },

  // Disc numbers on only some tracks: not a multi-disc set, so the differing
  // values are an inconsistency, and the untagged track is counted on disc 1.
  'disc numbers on only some tracks': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One', track: '1', disc: '1' });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two', track: '1', disc: '2' });
    await writeTrack(dir, '03.flac', { ...shared, title: 'Three', track: '2' });
  },

  // Release dates that disagree, and one track with none: reported, and not a
  // split, because date is not a grouping key. The two dates tie, so the
  // proposal falls to the one that sorts first.
  'differing dates do not split': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One', date: '2024-03-01' });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two', date: '2023-11-10' });
    await writeTrack(dir, '03.flac', { ...shared, title: 'Three' });
  },

  // album and album_artist on only some tracks. A missing album is a group of
  // its own; a missing album_artist falls back to the track's artist, which
  // matches the others on 03 and does not on 04.
  'album and album_artist on only some tracks': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One' });
    await writeTrack(dir, '02.flac', { album_artist: 'Test Artist', artist: 'Test Artist', title: 'Two' });
    await writeTrack(dir, '03.flac', { album: 'Test Album', artist: 'Test Artist', title: 'Three' });
    await writeTrack(dir, '04.flac', { album: 'Test Album', artist: 'Guest', title: 'Four' });
  },

  // `artists` stands in for a missing `artist`; nothing stands in for a title.
  'missing title and artist': async (dir) => {
    const album = { album: 'Test Album', album_artist: 'Test Artist' };
    await writeTrack(dir, '01.flac', { ...album, title: 'One', artist: 'Test Artist' });
    await writeTrack(dir, '02.flac', { ...album, artist: 'Test Artist' });
    await writeTrack(dir, '03.flac', { ...album, title: 'Three', artists: 'Test Artist' });
    await writeTrack(dir, '04.flac', { ...album });
  },

  // A code point truncated to its low byte (U+2019 -> 0x19, repairable; U+2606
  // -> 0x06, not), a zero-width space, and a downloader's "Don_t" filename —
  // once at the top and once in a subfolder that is damaged the same way, where
  // only the file's own name is to be corrected.
  'control characters and filename damage': async (dir) => {
    await writeTrack(dir, 'I_m Bonus/04 It_s Late.flac', { ...shared, title: 'Late' });
    await writeTrack(dir, '01 Don_t Stop.flac', { ...shared, title: `Don${cp(0x19)}t Stop` });
    await writeTrack(dir, '02 Star.flac', { ...shared, title: `Star ${cp(0x06)}` });
    await writeTrack(dir, '03 Plain.flac', { ...shared, title: 'Plain', artist: `Test${ZERO_WIDTH_SPACE} Artist` });
  },

  // Two containers, and two sample rates inside the one container. The odd
  // rate comes first on disk and is still listed after the majority.
  'mixed formats and mixed sample rate': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One' }, { rate: 48000 });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two' });
    await writeTrack(dir, '03.wav', { ...shared, title: 'Three' });
  },

  // Embedded-only detection: the loose images are listed, and still one track
  // counts as missing art.
  'art missing with loose folder images': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One' }, { art: true });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two' });
    await fsp.writeFile(path.join(dir, 'cover.jpg'), 'loose image');
    await fsp.mkdir(path.join(dir, 'scans'));
    await fsp.writeFile(path.join(dir, 'scans', 'Back.PNG'), 'loose image');
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'not an image');
  },

  // A truncated download: the right extension, nothing ffprobe can parse.
  'unreadable file': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One' });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two' });
    await fsp.writeFile(path.join(dir, '03.flac'), 'not audio');
  },

  // Length missing from the header: reported, and repairable where the file is
  // named .flac — the folder's dot is not an extension. The same bytes under
  // another audio extension are reported and not offered for repair.
  'track with no readable length': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One' });
    await writeLengthlessTrack(dir, 'Vol. 1/02.flac', { ...shared, title: 'Two' });
    await writeLengthlessTrack(dir, '03.ogg', { ...shared, title: 'Three' });
  },

  // Numbered n/N with no disc tag at all: the tracks count as disc 1, so the
  // totals are right and nothing needs normalizing.
  'numbered tracks without a disc tag': async (dir) => {
    await writeTrack(dir, '01.flac', { ...shared, title: 'One', track: '1/2' });
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two', track: '2/2' });
  },

  // Numbers that run on without a break but do not begin at 1: track 1 is
  // missing, and the disc is not contiguous.
  'numbering that starts at 2': async (dir) => {
    await writeTrack(dir, '02.flac', { ...shared, title: 'Two', track: '2/3' });
    await writeTrack(dir, '03.flac', { ...shared, title: 'Three', track: '3/3' });
  },

  // The early return: a folder with no audio in it at all.
  'no audio files': async (dir) => {
    await fsp.writeFile(path.join(dir, 'cover.jpg'), 'loose image');
  }
};

for (const [name, build] of Object.entries(SCENARIOS)) {
  test(`inspectAlbum full report: ${name}`, async (t) => {
    if (!ffmpegAvailable) {
      t.skip('ffmpeg unavailable');
      return;
    }
    await fsp.mkdir(path.join(rawDir, name), { recursive: true });
    await build(path.join(rawDir, name));

    const report = await inspectAlbum(name);

    if (UPDATE) {
      golden[name] = report;
      return;
    }
    assert.ok(golden[name], `no recorded report for "${name}"`);
    assert.deepStrictEqual(report, golden[name]);
  });
}

if (UPDATE) {
  // Everything outside printable ASCII is written as a \u escape, so an NBSP or
  // a zero-width space in a recorded tag is visible in the file and in a diff.
  const escape = (json) =>
    json.replace(/[^\x20-\x7e\n]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  after(() => fsp.writeFile(GOLDEN_PATH, `${escape(JSON.stringify(golden, null, 2))}\n`));
}
