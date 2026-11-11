// Spike: can TagLib-in-wasm read and rewrite tags and covers well enough to
// replace the server's ffprobe/ffmpeg pass? Fixtures are generated with ffmpeg
// and every claim is checked with something that is not the library under
// test: ffprobe, metaflac, ffmpeg's audio md5, and two small raw parsers below
// (ID3v2 frames, MP4 ilst atoms) for the names ffprobe normalizes away.
//
// Run with `npm test` (adds --conditions=browser so taglib-wasm resolves the
// same entry file a browser bundle gets). Only this harness uses Node built-ins.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initTagLib, readTrack, writeTrack } from './src/tags.js';
import { unzipAlbum, zipAlbum } from './src/zip.js';
import { diagnoseAlbum } from '../shared/inspect.js';
import { GROUND_TRUTH, BY_RULE } from '../shared/navidrome.groundtruth.js';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-spike-'));
after(() => fsp.rm(tmp, { recursive: true, force: true }));

// The server's reader resolves config.rawDir at import, so point it at the
// scratch dir first (same trick as server/metadata/inspect.album.test.js).
process.env.RAW_DIR = path.join(tmp, 'raw');
const { inspectAlbum } = await import('../server/metadata/inspect.js');

// stdin is closed so a tool that wants to ask a question fails instead of
// hanging the run.
function run(bin, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const out = [];
    let stderr = '';
    proc.stdout.on('data', (chunk) => out.push(chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', (error) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message }));
    proc.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
  });
}

async function ffmpeg(...args) {
  const result = await run('ffmpeg', ['-v', 'error', '-y', ...args]);
  assert.equal(result.code, 0, `ffmpeg ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

const SINE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100'];
const ORIGINAL = {
  title: 'One',
  artist: 'A',
  album: 'Old Album',
  album_artist: 'Old Artist',
  date: '2020',
  track: '1/3',
  disc: '1/1',
  genre: 'Pop',
  comment: 'keep me'
};
const metadataArgs = (tags) => Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);

// Each container the spike has to cover, with the encoder args that make it and
// the bit depth ffprobe reports for it (none for a lossy codec).
const FLAC = { name: 'flac', ext: 'flac', args: [], bitDepth: 16 };
const MP3 = { name: 'mp3 (ID3v2.4)', ext: 'mp3', args: [], bitDepth: null };
const MP3_V23 = { name: 'mp3 (ID3v2.3)', ext: 'mp3', args: ['-id3v2_version', '3'], bitDepth: null };
const M4A = { name: 'm4a (AAC)', ext: 'm4a', args: [], bitDepth: null };
// moov before mdat: a tag rewrite has to shift every chunk offset.
const M4A_FASTSTART = { name: 'm4a (AAC, faststart)', ext: 'm4a', args: ['-movflags', '+faststart'], bitDepth: null };
const M4A_ALAC = { name: 'm4a (ALAC)', ext: 'm4a', args: ['-c:a', 'alac'], bitDepth: 16 };
const CONTAINERS = [FLAC, MP3, MP3_V23, M4A, M4A_FASTSTART, M4A_ALAC];

const cover = path.join(tmp, 'cover.jpg');
const cover2 = path.join(tmp, 'cover2.jpg');
await ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', cover);
await ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', cover2);

let counter = 0;
async function fixture({ ext, args }, { art = false, tags = ORIGINAL } = {}) {
  const target = path.join(tmp, `fixture-${(counter += 1)}.${ext}`);
  const artArgs = art
    ? ['-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic']
    : [];
  await ffmpeg(...SINE, ...artArgs, ...args, ...metadataArgs(tags), target);
  return target;
}

// ffmpeg writing to a pipe cannot seek back to fill in STREAMINFO, so
// total_samples stays 0 (server/metadata/inspect.album.test.js).
async function lengthlessFlac(target) {
  const bytes = await ffmpeg(...SINE, ...metadataArgs({ title: 'Lengthless', artist: 'A' }), '-c:a', 'flac', '-f', 'flac', 'pipe:1');
  await fsp.writeFile(target, bytes);
  return target;
}

const bytesOf = async (file) => new Uint8Array(await fsp.readFile(file));
const audioMd5 = async (file) => (await ffmpeg('-i', file, '-map', '0:a', '-f', 'md5', '-')).toString().trim();

// What the server sees: format tags (keys folded to lowercase), duration, and
// how many attached pictures.
async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:format_tags:stream=codec_type:stream_disposition=attached_pic',
    '-of', 'json',
    file
  ]);
  const parsed = JSON.parse(stdout.toString() || '{}');
  const tags = {};
  for (const [key, value] of Object.entries(parsed.format?.tags || {})) {
    tags[key.toLowerCase()] = value;
  }
  const pictures = (parsed.streams || []).filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1);
  return { tags, duration: Number(parsed.format?.duration) || null, pictures: pictures.length };
}

const embeddedPicture = (file) => ffmpeg('-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'image2pipe', '-');

// --- Raw views: what is in the file under the container's own names --------

const group = (pairs) => {
  const out = {};
  for (const [key, value] of pairs) {
    (out[key] ||= []).push(value);
  }
  return out;
};

// Vorbis comments, one entry per comment, so a repeated key stays repeated.
async function vorbisComments(file) {
  const { code, stdout, stderr } = await run('metaflac', ['--export-tags-to=-', file]);
  assert.equal(code, 0, `metaflac: ${stderr}`);
  return stdout.toString().trim().split('\n');
}
const rawFlac = async (file) =>
  group((await vorbisComments(file)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

// ID3v2.3 / 2.4 text frames: { TDRC: [...], 'TXXX:<description>': [...] }.
async function rawMp3(file) {
  const bytes = await bytesOf(file);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 3)), 'ID3');
  const version = bytes[3];
  assert.equal(bytes[5] & 0x40, 0, 'extended header not handled');
  const synchsafe = (at) => (bytes[at] << 21) | (bytes[at + 1] << 14) | (bytes[at + 2] << 7) | bytes[at + 3];
  const plain = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  const end = 10 + synchsafe(6);
  const pairs = [];
  for (let at = 10; at + 10 <= end; ) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) {
      break; // padding
    }
    const size = version === 4 ? synchsafe(at + 4) : plain(at + 4);
    const body = bytes.subarray(at + 10, at + 10 + size);
    at += 10 + size;
    if (!id.startsWith('T')) {
      pairs.push([id, body.length]);
      continue;
    }
    const encoding = ['latin1', 'utf-16', 'utf-16be', 'utf-8'][body[0]];
    const strings = new TextDecoder(encoding).decode(body.subarray(1)).replace(/\0+$/, '').split('\0');
    if (id === 'TXXX') {
      const [description, ...values] = strings;
      values.forEach((value) => pairs.push([`TXXX:${description}`, value]));
    } else {
      strings.forEach((value) => pairs.push([id, value]));
    }
  }
  return group(pairs);
}

// MP4 moov/udta/meta/ilst items: { '©day': [...], cpil: [[1]],
// '----:com.apple.iTunes:<name>': [...] }. Text values as strings, anything
// else as its bytes.
async function rawM4a(file) {
  const bytes = await bytesOf(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  const utf8 = (from, to) => new TextDecoder().decode(bytes.subarray(from, to));
  const boxes = (start, end) => {
    const out = [];
    for (let at = start; at + 8 <= end; ) {
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1) {
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      out.push({ type: latin1(at + 4, at + 8), start: at + header, end: at + size });
      at += size;
    }
    return out;
  };
  const child = (parent, type, skip = 0) => boxes(parent.start + skip, parent.end).find((box) => box.type === type);
  const meta = child(child(child({ start: 0, end: bytes.length }, 'moov'), 'udta'), 'meta');
  const ilst = child(meta, 'ilst', 4); // meta is a full box: version + flags first
  const pairs = [];
  for (const item of boxes(ilst.start, ilst.end)) {
    const parts = boxes(item.start, item.end);
    const part = (type) => parts.find((box) => box.type === type);
    const key =
      item.type === '----'
        ? `----:${utf8(part('mean').start + 4, part('mean').end)}:${utf8(part('name').start + 4, part('name').end)}`
        : item.type;
    for (const data of parts.filter((box) => box.type === 'data')) {
      const isText = (view.getUint32(data.start) & 0xffffff) === 1;
      pairs.push([key, isText ? utf8(data.start + 8, data.end) : [...bytes.subarray(data.start + 8, data.end)]]);
    }
  }
  return group(pairs);
}

const RAW = { flac: rawFlac, mp3: rawMp3, m4a: rawM4a };
const raw = (file) => RAW[path.extname(file).slice(1)](file);
const pick = (object, keys) => Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]));

const taglib = await initTagLib(
  await fsp.readFile(new URL('./node_modules/taglib-wasm/dist/taglib-web.wasm', import.meta.url))
);

// Rewrite `source` into a sibling file and hold the result to "do no damage":
// input bytes untouched, audio bit-identical, duration unchanged.
async function rewrite(source, options) {
  const input = await bytesOf(source);
  const pristine = input.slice();
  const output = await writeTrack(taglib, path.basename(source), input, options);
  assert.deepEqual(input, pristine, 'the input bytes were modified');
  const target = source.replace(/(\.\w+)$/, `.${(counter += 1)}$1`);
  await fsp.writeFile(target, output);
  assert.equal(await audioMd5(target), await audioMd5(source), 'audio changed');
  assert.equal((await probe(target)).duration, (await probe(source)).duration, 'duration changed');
  return target;
}
const read = async (file) => readTrack(taglib, path.basename(file), await bytesOf(file));

// TagLib property name -> the key ffprobe shows it under.
const NEW_TAGS = {
  TITLE: 'New Title',
  ARTIST: 'A feat. B',
  ALBUM: 'New Album',
  ALBUMARTIST: 'New Artist',
  DATE: '2021-05-29',
  TRACKNUMBER: '2/9',
  DISCNUMBER: '1/2'
};
const FFPROBE_KEY = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ALBUMARTIST: 'album_artist',
  DATE: 'date',
  TRACKNUMBER: 'track',
  DISCNUMBER: 'disc'
};

for (const container of CONTAINERS) {
  test(`${container.name}: read`, async () => {
    const plain = await fixture(container);
    const withArt = await fixture(container, { art: true });

    const { properties, ...track } = await readTrack(taglib, 'x/01.' + container.ext, await bytesOf(plain));
    assert.equal(track.duration.toFixed(0), '2');
    assert.deepEqual(
      { ...track, formatName: null, duration: null },
      {
        file: 'x/01.' + container.ext,
        readable: true,
        formatName: null,
        sampleRate: 44100,
        bitDepth: container.bitDepth,
        hasArt: false,
        duration: null,
        title: 'One',
        artist: 'A',
        artists: '',
        album: 'Old Album',
        album_artist: 'Old Artist',
        date: '2020',
        disc: '1/1',
        track: '1/3',
        artist_values: ['A'],
        artists_values: [],
        album_artist_values: ['Old Artist'],
        album_artists_values: [],
        compilation: '',
        musicbrainz_albumid: '',
        album_version: '',
        // ffmpeg's `date` is the ©day atom in an m4a, and only there is it the
        // release date; in FLAC (DATE) and MP3 (TDRC) it is the recording date.
        release_date: container.ext === 'm4a' ? '2020' : '',
        release_date_follows_date: container.ext === 'm4a'
      }
    );
    assert.deepEqual(properties.GENRE, ['Pop']);
    assert.equal((await read(withArt)).hasArt, true);
  });

  test(`${container.name}: write tags, ARTISTS and a cover without touching the audio`, async () => {
    for (const art of [false, true]) {
      const source = await fixture(container, { art });
      const options = { set: { ...NEW_TAGS, ARTISTS: ['A', 'B'] }, cover: await bytesOf(cover2) };
      const target = await rewrite(source, options);
      const before = await probe(source);
      const after = await probe(target);

      // The tags not written survive.
      assert.equal(after.tags.genre, 'Pop');
      assert.equal(after.tags.comment, 'keep me');
      assert.equal(after.tags.encoder, before.tags.encoder);

      // Players (ffprobe here) read every written field.
      for (const [name, value] of Object.entries(NEW_TAGS)) {
        assert.equal(after.tags[FFPROBE_KEY[name]], value, name);
      }

      // Exactly one picture, and it is the new cover byte for byte — whether
      // or not one was there before.
      assert.equal(before.pictures, art ? 1 : 0);
      assert.equal(after.pictures, 1);
      assert.deepEqual(new Uint8Array(await embeddedPicture(target)), await bytesOf(cover2));

      // Both artists come back as separate values through our own reader.
      const reread = await read(target);
      assert.deepEqual(reread.properties.ARTISTS, ['A', 'B']);
      assert.equal(reread.artists, 'A;B');
      assert.equal(reread.hasArt, true);

      // Rewriting our own output must not drift: same tags, and no value
      // picked up a second copy.
      const again = await rewrite(await rewrite(target, options), options);
      assert.deepEqual((await probe(again)).tags, after.tags);
      for (const [name, values] of Object.entries((await read(again)).properties)) {
        assert.equal(new Set(values).size, values.length, `${name} repeats a value: ${values}`);
      }
    }
  });
}

test('flac: conventional uppercase keys, ARTISTS as two separate comments', async () => {
  const target = await rewrite(await fixture(FLAC), { set: { ...NEW_TAGS, ARTISTS: ['A', 'B'] } });

  // metaflac, not ffprobe: ffprobe joins repeated comments and hides the
  // difference between two values and one joined value.
  const comments = await vorbisComments(target);
  assert.deepEqual(
    comments.filter((line) => !line.startsWith('ENCODER=')).sort(),
    [
      'ALBUM=New Album',
      'ALBUMARTIST=New Artist',
      'ARTIST=A feat. B',
      'ARTISTS=A',
      'ARTISTS=B',
      'DATE=2021-05-29',
      'DESCRIPTION=keep me', // ffmpeg stores `comment` under this key
      'DISCNUMBER=1/2',
      'GENRE=Pop',
      'TITLE=New Title',
      'TRACKNUMBER=2/9'
    ]
  );
  assert.equal((await probe(target)).tags.artists, 'A;B');
});

test('garbage and truncated files are unreadable, not tracks with empty tags', async () => {
  const flac = await bytesOf(await fixture(FLAC));
  const m4a = await bytesOf(await fixture(M4A));
  const cases = {
    'garbage.flac': new TextEncoder().encode('not audio'),
    'garbage.mp3': new TextEncoder().encode('not audio'),
    'garbage.m4a': new TextEncoder().encode('not audio'),
    'empty.flac': new Uint8Array(0),
    'cut-in-header.flac': flac.slice(0, 3000),
    'cut.m4a': m4a.slice(0, 12000) // moov sits at the end, so it is gone
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const track = await readTrack(taglib, name, bytes);
    assert.equal(track.readable, false, name);
    assert.equal(track.sampleRate, null, name);
  }
});

// A known limit, shared with the server: a file cut off after its header is
// intact still reads as a whole track of full length, in ffprobe and in TagLib.
test('a file cut mid-audio is not detected, by either reader', async () => {
  const whole = await fixture(FLAC);
  const cut = path.join(tmp, 'cut-mid-audio.flac');
  await fsp.writeFile(cut, (await bytesOf(whole)).slice(0, 20000));
  const track = await read(cut);
  assert.equal(track.readable, true);
  assert.equal(track.duration, 2);
  assert.equal((await probe(cut)).duration, 2);
});

test('a FLAC with total_samples=0 reads as a track with no duration', async () => {
  const file = await lengthlessFlac(path.join(tmp, 'lengthless.flac'));
  const track = await read(file);
  assert.equal(track.readable, true);
  assert.equal(track.duration, null);
  assert.equal(track.title, 'Lengthless');

  // A tag write neither repairs nor worsens it, and the audio is untouched.
  const target = await rewrite(file, { set: { ALBUM: 'X' } });
  assert.equal((await probe(target)).duration, null);
});

// --- Album identity tags (what Navidrome groups an album by) ---------------

const MBID = '11111111-2222-3333-4444-555555555555';
const IDENTITY = {
  MUSICBRAINZ_ALBUMID: MBID,
  DATE: '2021-05-29',
  RELEASEDATE: '2021-06-01',
  YEAR: '2019',
  ALBUMVERSION: 'Deluxe',
  COMPILATION: '1',
  ALBUMARTISTS: ['X', 'Y']
};
// Where each of those lands in the file, under the container's own names.
const IDENTITY_RAW = {
  flac: {
    MUSICBRAINZ_ALBUMID: [MBID],
    DATE: ['2021-05-29'],
    RELEASEDATE: ['2021-06-01'],
    YEAR: ['2019'],
    ALBUMVERSION: ['Deluxe'],
    COMPILATION: ['1'],
    ALBUMARTISTS: ['X', 'Y'] // two comments, never one joined value
  },
  mp3: {
    'TXXX:MusicBrainz Album Id': [MBID], // Picard's spelling, letter for letter
    TDRC: ['2021-05-29'],
    TDRL: ['2021-06-01'],
    'TXXX:YEAR': ['2019'],
    'TXXX:ALBUMVERSION': ['Deluxe'],
    TCMP: ['1'],
    'TXXX:ALBUMARTISTS': ['X', 'Y']
  },
  m4a: {
    '----:com.apple.iTunes:MusicBrainz Album Id': [MBID],
    '©day': ['2021-05-29'],
    '----:com.apple.iTunes:RELEASEDATE': ['2021-06-01'],
    '----:com.apple.iTunes:YEAR': ['2019'],
    '----:com.apple.iTunes:ALBUMVERSION': ['Deluxe'],
    cpil: [[1]],
    '----:com.apple.iTunes:ALBUMARTISTS': ['X', 'Y']
  }
};

for (const container of [FLAC, MP3, MP3_V23, M4A, M4A_FASTSTART]) {
  test(`${container.name}: identity tags are written where the container keeps them, and removed outright`, async () => {
    const expected = IDENTITY_RAW[container.ext];
    const source = await fixture(container);

    const written = await rewrite(source, { set: IDENTITY });
    assert.deepEqual(pick(await raw(written), Object.keys(expected)), expected);
    const reread = (await read(written)).properties;
    for (const [name, value] of Object.entries(IDENTITY)) {
      assert.deepEqual(reread[name], [value].flat(), name);
    }

    // Removal takes the entry out of the file — not an empty value left behind.
    const removed = await rewrite(written, { set: Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, null])) });
    const rawAfter = await raw(removed);
    const leftovers = Object.keys(rawAfter).filter((key) =>
      Object.keys(expected).some((gone) => gone.toLowerCase() === key.toLowerCase())
    );
    assert.deepEqual(leftovers, []);
    const propertiesAfter = (await read(removed)).properties;
    assert.deepEqual(pick(propertiesAfter, Object.keys(IDENTITY)), {});
    // ...and nothing else went with it.
    assert.deepEqual(propertiesAfter.TITLE, ['One']);
    assert.deepEqual(propertiesAfter.GENRE, ['Pop']);
    assert.equal((await probe(removed)).tags.comment, 'keep me');
  });
}

test('flac: DATE, RELEASEDATE and YEAR written by another tool read as three separate tags', async () => {
  const file = await fixture(FLAC);
  const set = ['MUSICBRAINZ_ALBUMID=' + MBID, 'RELEASEDATE=2021-06-01', 'YEAR=2019', 'ALBUMVERSION=Deluxe', 'COMPILATION=1', 'ALBUMARTISTS=X', 'ALBUMARTISTS=Y'];
  assert.equal((await run('metaflac', [...set.map((tag) => `--set-tag=${tag}`), file])).code, 0);

  const { properties, date } = await read(file);
  assert.equal(date, '2020'); // the record's `date` is DATE alone
  assert.deepEqual(
    pick(properties, ['DATE', 'RELEASEDATE', 'YEAR', 'ALBUMVERSION', 'COMPILATION', 'ALBUMARTISTS', 'MUSICBRAINZ_ALBUMID']),
    {
      DATE: ['2020'],
      RELEASEDATE: ['2021-06-01'],
      YEAR: ['2019'],
      ALBUMVERSION: ['Deluxe'],
      COMPILATION: ['1'],
      ALBUMARTISTS: ['X', 'Y'],
      MUSICBRAINZ_ALBUMID: [MBID]
    }
  );

  // Removing two of the three dates leaves the third exactly as it was.
  const target = await rewrite(file, { set: { RELEASEDATE: null, YEAR: null, ALBUMVERSION: null } });
  const comments = await rawFlac(target);
  assert.deepEqual(pick(comments, ['DATE', 'RELEASEDATE', 'YEAR', 'ALBUMVERSION']), { DATE: ['2020'] });
});

test('mp3: Picard-style frames written by another tool are read, and survive a rewrite', async () => {
  const file = await fixture(MP3, {
    tags: { ...ORIGINAL, 'MusicBrainz Album Id': MBID, TDRL: '2021-06-01' }
  });
  assert.deepEqual(pick(await rawMp3(file), ['TXXX:MusicBrainz Album Id', 'TDRL', 'TDRC']), {
    'TXXX:MusicBrainz Album Id': [MBID],
    TDRL: ['2021-06-01'],
    TDRC: ['2020']
  });
  const { properties } = await read(file);
  assert.deepEqual(pick(properties, ['MUSICBRAINZ_ALBUMID', 'RELEASEDATE', 'DATE']), {
    MUSICBRAINZ_ALBUMID: [MBID],
    RELEASEDATE: ['2021-06-01'],
    DATE: ['2020']
  });

  // An unrelated write keeps the frame and its spelling; changing the id
  // replaces it, still in Picard's spelling, and leaves exactly one.
  const untouched = await rawMp3(await rewrite(file, { set: { TITLE: 'Other' } }));
  assert.deepEqual(untouched['TXXX:MusicBrainz Album Id'], [MBID]);
  const changed = await rawMp3(await rewrite(file, { set: { MUSICBRAINZ_ALBUMID: 'another-id' } }));
  assert.deepEqual(
    Object.entries(changed).filter(([key]) => /musicbrainz album id/i.test(key)),
    [['TXXX:MusicBrainz Album Id', ['another-id']]]
  );
});

// The record fields the album identity is computed from (shared/identity.js).
const identityOf = ({ artist_values, artists_values, album_artist_values, album_artists_values, compilation, musicbrainz_albumid, album_version, release_date, release_date_follows_date }) =>
  ({ artist_values, artists_values, album_artist_values, album_artists_values, compilation, musicbrainz_albumid, album_version, release_date, release_date_follows_date });

for (const container of [FLAC, MP3, MP3_V23, M4A]) {
  test(`${container.name}: the identity fields of the record, read from where the container keeps them`, async () => {
    const written = await rewrite(await fixture(container), { set: { ...IDENTITY, ARTISTS: ['A', 'B'] } });
    assert.deepEqual(identityOf(await read(written)), {
      artist_values: ['A'],
      artists_values: ['A', 'B'],
      album_artist_values: ['Old Artist'],
      album_artists_values: ['X', 'Y'],
      compilation: '1',
      musicbrainz_albumid: MBID,
      album_version: 'Deluxe',
      // RELEASEDATE outranks ©day and YEAR, so unifying `date` would not move it.
      release_date: '2021-06-01',
      release_date_follows_date: false
    });

    // Without RELEASEDATE: ©day in an m4a, YEAR elsewhere — never DATE or TDRC.
    const noRelease = await read(await rewrite(written, { set: { RELEASEDATE: null } }));
    assert.equal(noRelease.release_date, container.ext === 'm4a' ? '2021-05-29' : '2019');
    assert.equal(noRelease.release_date_follows_date, container.ext === 'm4a');
    const noYear = await read(await rewrite(written, { set: { RELEASEDATE: null, YEAR: null } }));
    assert.equal(noYear.release_date, container.ext === 'm4a' ? '2021-05-29' : '');
    assert.equal(noYear.date, '2021-05-29');

    // MUSICBRAINZ_ALBUMCOMMENT stands in for a missing ALBUMVERSION.
    const comment = await read(await rewrite(written, { set: { ALBUMVERSION: null, MUSICBRAINZ_ALBUMCOMMENT: 'Remaster' } }));
    assert.equal(comment.album_version, 'Remaster');
  });
}

test('mp3: the compilation flag as ffmpeg writes it to each ID3 version', async () => {
  // ID3v2.3 gets a TCMP frame; ID3v2.4 gets TXXX:TCMP, which TagLib has no
  // name for and Navidrome still reads as the flag.
  for (const container of [MP3, MP3_V23]) {
    const file = await fixture(container, { tags: { ...ORIGINAL, compilation: '1' } });
    assert.equal((await read(file)).compilation, '1', container.name);
  }
  assert.deepEqual(pick(await rawMp3(await fixture(MP3, { tags: { ...ORIGINAL, compilation: '1' } })), ['TCMP', 'TXXX:TCMP']), { 'TXXX:TCMP': ['1'] });
});

test('m4a: tracks with different ©day values are rewritten to one', async () => {
  const first = await fixture(M4A, { tags: { ...ORIGINAL, date: '2020-01-02', compilation: '1' } });
  const second = await fixture(M4A_FASTSTART, { tags: { ...ORIGINAL, date: '2019' } });
  // Raw atoms as ffmpeg wrote them, and what the reader makes of them.
  assert.deepEqual(pick(await rawM4a(first), ['©day', 'cpil']), { '©day': ['2020-01-02'], cpil: [[1]] });
  assert.deepEqual((await rawM4a(second))['©day'], ['2019']);
  assert.deepEqual(pick((await read(first)).properties, ['DATE', 'COMPILATION']), { DATE: ['2020-01-02'], COMPILATION: ['1'] });
  assert.deepEqual((await read(second)).properties.DATE, ['2019']);

  for (const source of [first, second]) {
    const target = await rewrite(source, { set: { DATE: '2021-05-29' } });
    assert.deepEqual((await rawM4a(target))['©day'], ['2021-05-29']);
    assert.equal((await probe(target)).tags.date, '2021-05-29');
  }
  // Clearing the flag removes the atom.
  assert.equal('cpil' in (await rawM4a(await rewrite(first, { set: { COMPILATION: null } }))), false);
});

// --- Zip in, zip out --------------------------------------------------------

test('zip in, zip out: stored, and the rewritten tracks survive the round trip', async () => {
  const sources = {
    'Album/01.flac': await bytesOf(await fixture(FLAC)),
    'Album/02.mp3': await bytesOf(await fixture(MP3)),
    'Album/CD2/01 ö 空洞.m4a': await bytesOf(await fixture(M4A)),
    'Album/cover.jpg': await bytesOf(cover)
  };
  // A deflated zip made by the system `zip`, the way a user's archive arrives.
  const stage = path.join(tmp, 'zip-in');
  for (const [name, bytes] of Object.entries(sources)) {
    await fsp.mkdir(path.dirname(path.join(stage, name)), { recursive: true });
    await fsp.writeFile(path.join(stage, name), bytes);
  }
  const zipIn = path.join(tmp, 'in.zip');
  assert.equal((await run('zip', ['-qr', zipIn, 'Album'], { cwd: stage })).code, 0);

  const entries = unzipAlbum(await bytesOf(zipIn));
  assert.deepEqual(entries.map((e) => e.path), Object.keys(sources).sort((a, b) => a.localeCompare(b)));

  const rewritten = [];
  for (const { path: name, bytes } of entries) {
    const isAudio = /\.(flac|mp3|m4a)$/.test(name);
    rewritten.push({ path: name, bytes: isAudio ? await writeTrack(taglib, name, bytes, { set: NEW_TAGS }) : bytes });
  }
  const zipOut = path.join(tmp, 'out.zip');
  await fsp.writeFile(zipOut, zipAlbum(rewritten));

  // Extract with the system unzip (not the library that wrote it) and check.
  const outDir = path.join(tmp, 'zip-out');
  const unzip = await run('unzip', ['-qn', zipOut, '-d', outDir]);
  assert.equal(unzip.code, 0, unzip.stderr);
  for (const name of Object.keys(sources)) {
    const extracted = path.join(outDir, name);
    if (name.endsWith('.jpg')) {
      assert.deepEqual(await bytesOf(extracted), sources[name]);
      continue;
    }
    assert.equal((await probe(extracted)).tags.album, 'New Album', name);
    assert.equal(await audioMd5(extracted), await audioMd5(path.join(stage, name)), name);
  }
  // "Stored" for every entry: `unzip -v` prints the method per file.
  const listing = (await run('unzip', ['-v', zipOut])).stdout.toString();
  assert.equal((listing.match(/ Stored /g) || []).length, Object.keys(sources).length, listing);
  assert.equal(/Defl/.test(listing), false);
});

// --- Agreement with the server ----------------------------------------------

function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out[prefix] = Array.isArray(value) ? '[]' : '{}';
    }
    for (const key of keys) {
      flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out[prefix] = value;
  }
  return out;
}

// Every way the two reports are known to differ, and why. Anything that does
// not match one of these fails the test.
const KNOWN_DIFFERENCES = [
  {
    why: 'formatName: ffprobe names the demuxer ("flac", "mov,mp4,m4a,3gp,3g2,mj2"), TagLib the container ("FLAC", "MP4"); for garbage ffprobe still guesses from the extension, TagLib reports nothing. No rule reads it.',
    match: (key) => /^tracks\.\d+\.formatName$/.test(key)
  },
  {
    why: 'duration (MP3, AAC): TagLib counts the encoder delay and padding frames, ffprobe trims them. Tens of milliseconds; the rules only ask whether a duration exists.',
    match: (key, server, browser) => /^tracks\.\d+\.duration$/.test(key) && Math.abs(server - browser) < 0.05
  },
  {
    why: 'artists, the joined string (MP3, MP4): ffprobe returns only the first value of a multi-valued tag; TagLib returns all of them. FLAC agrees, because there ffprobe joins repeats with ";". No rule groups by this string any more.',
    match: (key, server, browser) => /^tracks\.\d+\.artists$/.test(key) && server === 'A' && browser === 'A;B'
  },
  {
    why: 'artists_values / album_artists_values past the first value (MP3, MP4): the same ffprobe limit, in the lists the album identity reads. The identity takes the FIRST ARTISTS value, which both readers have, so the album count agrees; ALBUMARTISTS is read whole, so an album whose only album artist tag is a multi-valued ALBUMARTISTS in an MP3 or MP4 is where the server would still differ.',
    match: (key, server, browser) =>
      /^tracks\.\d+\.(artists_values|album_artists_values)\.[1-9]\d*$/.test(key) && server === undefined && typeof browser === 'string'
  },
  {
    why: 'date and release_date (MP3 with a TDRL frame): ffprobe reports TDRC and TDRL under the one key `date`, so the server shows the release date as the recording date and has no release date; TagLib keeps the two apart. A consequence: the tallies of distinct recording dates and release dates in the album differ by that one track.',
    match: (key, server, browser) =>
      (/^tracks\.\d+\.date$/.test(key) && server === '2021-06-01' && browser === '2021-05-29') ||
      (/^tracks\.\d+\.release_date$/.test(key) && server === '2019' && browser === '2021-06-01') ||
      /^fields\.(date|release_date)\.distinct\.\d+\.(value|count)$/.test(key)
  }
];

test('diagnoseAlbum: the server reader and the browser reader agree, bar a known list', async () => {
  const album = 'Agreement';
  const dir = path.join(process.env.RAW_DIR, album);
  await fsp.mkdir(dir, { recursive: true });
  const place = (source, name) => fsp.copyFile(source, path.join(dir, name));

  // One of everything the readers could disagree on.
  const multi = { set: { ARTISTS: ['A', 'B'] } };
  const withArtists = async (container, name, options) =>
    fsp.writeFile(path.join(dir, name), await writeTrack(taglib, name, await bytesOf(await fixture(container, options)), multi));
  await place(await fixture(FLAC, { art: true }), '01.flac');
  await withArtists(FLAC, '02.flac');
  await place(await fixture(MP3), '03.mp3');
  await withArtists(MP3, '04.mp3');
  await place(await fixture(MP3_V23), '05.mp3');
  await place(await fixture(M4A), '06.m4a');
  await withArtists(M4A, '07.m4a');
  await place(await fixture(M4A_ALAC, { art: true }), '08.m4a');
  await place(await fixture({ ext: 'flac', args: ['-ar', '96000', '-sample_fmt', 's32'] }), '09.flac');
  await lengthlessFlac(path.join(dir, '10.flac'));
  await fsp.writeFile(path.join(dir, '11.flac'), 'not audio');
  await fsp.writeFile(path.join(dir, '12.m4a'), (await bytesOf(path.join(dir, '06.m4a'))).slice(0, 12000));
  // No album_artist, two ARTISTS values: the grouping anchor is `artists`.
  const bare = { tags: { title: 'Bare', album: 'Old Album', track: '13' } };
  await withArtists(FLAC, '13.flac', bare);
  await withArtists(MP3, '14.mp3', bare);
  await withArtists(M4A, '15.m4a', bare);
  // Every identity tag at once, written where each container keeps it.
  const identity = { set: { ...IDENTITY, ARTISTS: ['A', 'B'] } };
  for (const [container, name] of [[FLAC, '16.flac'], [MP3, '17.mp3'], [M4A, '18.m4a']]) {
    await fsp.writeFile(path.join(dir, name), await writeTrack(taglib, name, await bytesOf(await fixture(container)), identity));
  }
  await place(cover, 'cover.jpg');

  const server = await inspectAlbum(album);
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.jpg')).sort((a, b) => a.localeCompare(b));
  const tracks = [];
  for (const file of files) {
    // `properties` is extra to the record the server builds; leave it out so
    // the diff shows only where the shared fields disagree.
    const { properties, ...track } = await readTrack(taglib, file, await bytesOf(path.join(dir, file)));
    tracks.push(track);
  }
  const browser = diagnoseAlbum(album, tracks, server.art.folderImages);

  const a = flatten(server);
  const b = flatten(browser);
  const counts = KNOWN_DIFFERENCES.map(() => 0);
  const unexplained = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[key] === b[key]) {
      continue;
    }
    const known = KNOWN_DIFFERENCES.findIndex((entry) => entry.match(key, a[key], b[key]));
    if (known < 0) {
      unexplained[key] = { server: a[key], browser: b[key] };
    } else {
      counts[known] += 1;
    }
    if (process.env.SHOW_DIFF) {
      console.log(`${key}: server=${JSON.stringify(a[key])} browser=${JSON.stringify(b[key])}`);
    }
  }
  assert.deepEqual(unexplained, {});
  // Each known difference really occurs — the list is not allowed to rot.
  assert.deepEqual(counts.map((n) => n > 0), KNOWN_DIFFERENCES.map(() => true));
  // The parts the rules act on agree outright.
  for (const key of ['unreadable', 'noDuration', 'durationRepairable', 'qualities', 'mixedQuality', 'formats', 'art', 'track', 'trackGaps', 'missingRequired', 'mergeWarnings', 'discs', 'splitFields', 'groupCount']) {
    assert.deepEqual(browser[key], server[key], key);
  }
  // The false split this album used to show on the server: 13, 14 and 15 carry
  // the same two ARTISTS values and no album artist, and ffprobe hands them
  // over as "A;B" (FLAC) and "A" (MP3, MP4). Both readers now make one album
  // artist of them.
  const byFile = Object.fromEntries(server.tracks.map((track) => [track.file, track]));
  assert.deepEqual(['13.flac', '14.mp3', '15.m4a'].map((file) => byFile[file].artists), ['A;B', 'A', 'A']);
  assert.deepEqual(['13.flac', '14.mp3', '15.m4a'].map((file) => byFile[file].artists_values[0]), ['A', 'A', 'A']);
  // (The fourth "A" is 10.flac, whose only artist tag is ARTIST=A.)
  assert.deepEqual(server.fields.album_artist.distinct, [{ value: 'Old Artist', count: 12 }, { value: 'A', count: 4 }]);
  assert.deepEqual(browser.fields.album_artist, server.fields.album_artist);
});

// --- Navidrome's album count, through this reader ----------------------------

for (const album of [...GROUND_TRUTH, ...BY_RULE]) {
  test(`${album.id}: tracks differ in ${album.differs} — ${album.albums} album${album.albums > 1 ? 's' : ''}`, async () => {
    const tracks = [];
    for (const [file, tags] of album.files) {
      const target = path.join(tmp, 'navidrome', album.id, file);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await ffmpeg(...SINE, ...metadataArgs(tags), target);
      tracks.push(await readTrack(taglib, file, await bytesOf(target)));
    }
    const report = diagnoseAlbum(album.id, tracks, []);
    // No case is a known gap for this reader; the server's are in knownGaps.
    assert.equal(album.knownGaps?.browser, undefined);
    assert.equal(report.groupCount, album.albums);
    assert.equal(report.splitFields.length > 0, album.albums > 1, `causes: ${report.splitFields}`);
    if (album.albumArtist) {
      assert.equal(report.fields.album_artist.proposed, album.albumArtist);
    }
  });
}
