// The cleaner end to end, without a browser: real files in, the pipeline the
// page runs (src/album.js), a zip out — and every claim about that zip checked
// with something that is not the code under test: ffmpeg's audio md5, ffprobe,
// metaflac, the system unzip.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { initTagLib } from './src/tags.js';
import { asAlbum, cleanAlbum, inspect, loadCover, readAlbum, recheck, refusal, LIMITS } from './src/album.js';
import { openZip, zipWriter, ZipError } from './src/zip.js';
import { chooseNameEncoding } from '../shared/zipnames.js';
import { GROUND_TRUTH, BY_RULE } from '../shared/navidrome.groundtruth.js';
import { planWrites } from '../shared/plan.js';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-clean-'));
after(() => fsp.rm(tmp, { recursive: true, force: true }));

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
const SINE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100'];
const metadataArgs = (tags) => Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
const audioMd5 = async (file) => (await ffmpeg('-i', file, '-map', '0:a', '-f', 'md5', '-')).toString().trim();
const bytesOf = async (file) => new Uint8Array(await fsp.readFile(file));

async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format_tags:stream=codec_type:stream_disposition=attached_pic',
    '-of', 'json',
    file
  ]);
  const parsed = JSON.parse(stdout.toString() || '{}');
  const tags = Object.fromEntries(Object.entries(parsed.format?.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const pictures = (parsed.streams || []).filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1);
  return { tags, pictures: pictures.length };
}
const embeddedPicture = async (file) => new Uint8Array(await ffmpeg('-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'image2pipe', '-'));
async function vorbisComments(file) {
  const { code, stdout, stderr } = await run('metaflac', ['--export-tags-to=-', file]);
  assert.equal(code, 0, `metaflac: ${stderr}`);
  return stdout.toString().trim().split('\n');
}

const taglib = await initTagLib(
  await fsp.readFile(new URL('./node_modules/taglib-wasm/dist/taglib-web.wasm', import.meta.url))
);

// Entries over a folder on disk, as the page builds them over dropped files.
async function entriesOf(dir, top = path.basename(dir)) {
  const names = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  const entries = [];
  for (const item of names.filter((candidate) => candidate.isFile())) {
    const file = path.join(item.parentPath, item.name);
    const stat = await fsp.stat(file);
    entries.push({
      path: `${top}/${path.relative(dir, file).split(path.sep).join('/')}`,
      size: stat.size,
      mtime: stat.mtime,
      read: () => bytesOf(file)
    });
  }
  return entries;
}

// The zip written out to disk and extracted with the system unzip.
async function extract(blob, name) {
  const zipFile = path.join(tmp, `${name}.zip`);
  const outDir = path.join(tmp, `${name}-out`);
  await fsp.writeFile(zipFile, new Uint8Array(await blob.arrayBuffer()));
  const unzip = await run('unzip', ['-qn', zipFile, '-d', outDir]);
  assert.equal(unzip.code, 0, unzip.stderr);
  return { zipFile, outDir };
}

// read -> plan (defaults) -> write -> zip -> re-read, the way the page does it.
async function clean(dir, { edit = (fixes) => fixes, cover } = {}) {
  const { name, guess, entries } = asAlbum(await entriesOf(dir), path.basename(dir));
  const album = await readAlbum(taglib, entries);
  const before = inspect(name, album, entries, { nameGuess: guess });
  const fixes = edit(before.fixes);
  const picture = cover ?? (await loadCover(taglib, entries, before.cover))?.data;
  const result = await cleanAlbum(taglib, entries, before, fixes, picture);
  const afterwards = await recheck(taglib, result.blob, name);
  return { name, entries, album, before, fixes, result, after: afterwards };
}

// --- Navidrome's ground truth, cleaned -------------------------------------------

// Tags no fix writes, on every fixture, to see them come through.
const BYSTANDERS = { genre: 'Pop', comment: 'keep me' };

for (const album of [...GROUND_TRUTH, ...BY_RULE]) {
  test(`${album.id}: ${album.differs} — cleaned into one album`, async (t) => {
    const dir = path.join(tmp, album.id);
    for (const [file, tags] of album.files) {
      const target = path.join(dir, file);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await ffmpeg(...SINE, ...metadataArgs({ ...BYSTANDERS, ...tags }), target);
    }
    const { name, before, fixes, result, after: cleaned, album: read } = await clean(dir);

    // The case is here to be repaired only if Navidrome would get it wrong.
    assert.equal(before.report.groupCount, album.albums);
    if (album.albums === 1 && before.report.mergeWarnings.length === 0) {
      t.diagnostic('one album already, no merge warning: nothing to prove');
      return;
    }
    // An album name is required where no track has one; the page offers the
    // folder name, and that default is taken like the others.
    assert.equal(before.fixes.every((fix) => fix.id !== 'album' || fix.value), true);

    assert.deepEqual(result.failed, []);
    assert.equal(cleaned.report.groupCount, 1, `still split on ${cleaned.report.splitFields}`);
    assert.deepEqual(cleaned.report.splitFields, []);
    assert.deepEqual(cleaned.report.mergeWarnings, []);
    assert.equal(cleaned.verdict.albums, 1);
    assert.equal(cleaned.verdict.tracks, album.files.length);
    // Nothing the plan offered is still on offer.
    const offeredBefore = new Set(fixes.map((fix) => fix.id));
    assert.deepEqual(cleaned.fixes.filter((fix) => offeredBefore.has(fix.id)), []);

    const { outDir } = await extract(result.blob, album.id);
    const { files } = planWrites(before.report, read.tracks, fixes, before.context);
    const written = new Map(files.map((entry) => [entry.file, entry.set]));
    for (const [file] of album.files) {
      const source = path.join(dir, file);
      const target = path.join(outDir, name, file);
      assert.equal(await audioMd5(target), await audioMd5(source), `${file}: audio changed`);

      // Every tag the plan did not name is exactly as it was.
      const was = read.tracks.find((track) => track.file === `${name}/${file}`).properties;
      const is = cleaned.album.tracks.find((track) => track.file === `${name}/${file}`).properties;
      const named = new Set(Object.keys(written.get(`${name}/${file}`) || {}));
      for (const tag of new Set([...Object.keys(was), ...Object.keys(is)])) {
        if (!named.has(tag)) {
          assert.deepEqual(is[tag], was[tag], `${file}: ${tag} changed`);
        }
      }
      // ...and ffprobe, which is not TagLib, still reads the bystanders.
      const { tags } = await probe(target);
      assert.equal(tags.genre, 'Pop', `${file}: genre`);
      assert.equal(tags.comment ?? tags.description, 'keep me', `${file}: comment`);
    }
  });
}

test('mp3 (ID3v2.3): tracks split by a TDRL frame are cleaned into one album', async () => {
  const dir = path.join(tmp, 'V23');
  await fsp.mkdir(dir, { recursive: true });
  for (const [n, date] of [[1, '2020-01-01'], [2, '2021-02-02']]) {
    await ffmpeg(...SINE, '-id3v2_version', '3', ...metadataArgs({ album: 'V23', album_artist: 'AA', artist: 'AA', title: `t${n}`, track: n, TDRL: date }), path.join(dir, `${n}.mp3`));
  }
  const { before, after: cleaned } = await clean(dir);
  assert.equal(before.report.groupCount, 2);
  assert.deepEqual(before.report.splitFields, ['release_date']);
  assert.equal(cleaned.report.groupCount, 1);
  assert.deepEqual(cleaned.report.fields.release_date.distinct, [{ value: '2020-01-01', count: 2 }]);
});

// --- One album with everything wrong ------------------------------------------------

test('a whole album: every fix at once, and everything else passed through', async () => {
  const dir = path.join(tmp, 'Mess');
  await fsp.mkdir(path.join(dir, 'scans'), { recursive: true });
  const coverFile = path.join(dir, 'folder.jpg');
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', coverFile);
  const embedded = path.join(tmp, 'embedded.jpg');
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', embedded);
  const common = { ARTIST: 'AA', ALBUMARTIST: 'AA', GENRE: 'Pop', DATE: '2020' };
  const make = (file, tags, extra = []) => ffmpeg(...SINE, ...extra, ...metadataArgs({ ...common, ...tags }), path.join(dir, file));
  const withArt = ['-i', embedded, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic'];
  await make('01 Don_t.flac', { ALBUM: 'Mess', TITLE: 'Don\u0019t', TRACKNUMBER: '1' }, withArt);
  await make('02 Two.flac', { ALBUM: 'Mess ', TITLE: 'Two', TRACKNUMBER: '2', DATE: '2021' });
  await make('03 Three.flac', { ALBUM: 'Mess', TITLE: ' Three', MUSICBRAINZ_ALBUMCOMMENT: 'Remaster' });
  await fsp.writeFile(path.join(dir, '04 Broken.flac'), 'not audio');
  await fsp.writeFile(path.join(dir, 'scans', 'notes.txt'), 'liner notes');
  await fsp.writeFile(path.join(dir, '.DS_Store'), 'junk');

  const { name, before, result, after: cleaned } = await clean(dir);
  assert.deepEqual(before.verdict, { code: 'split', causes: ['album', 'album_version'], albums: 3, tracks: 3 });
  assert.deepEqual(before.fixes.map((fix) => fix.id), ['album', 'date', 'album_version', 'track_numbers', 'text', 'filenames', 'cover_embed', 'cover_file']);
  assert.deepEqual(before.cover, { kind: 'file', path: 'Mess/folder.jpg' });
  assert.deepEqual(before.cannotFix.map((entry) => entry.code), ['unreadable']);

  assert.deepEqual(result.failed, []);
  assert.equal(result.changed, 3);
  // The broken file keeps the album from a clean bill, and that is what is said.
  assert.deepEqual(cleaned.verdict, { code: 'stuck', albums: 1, tracks: 3 });
  assert.deepEqual(cleaned.fixes, []);
  // (The totals count the broken file as the album's fourth track, so the
  // diagnosis, which cannot read a number off it, also misses a track 4.)
  assert.deepEqual(cleaned.cannotFix, [
    { code: 'unreadable', files: ['Mess/04 Broken.flac'] },
    { code: 'gaps', discs: [{ disc: 1, missing: [4] }], multiDisc: false }
  ]);

  const { zipFile, outDir } = await extract(result.blob, 'Mess');
  const out = (file) => path.join(outDir, name, file);
  assert.deepEqual((await fsp.readdir(path.join(outDir, name), { recursive: true })).sort(), [
    "01 Don't.flac",
    '02 Two.flac',
    '03 Three.flac',
    '04 Broken.flac',
    'cover.jpg',
    'folder.jpg',
    'scans',
    'scans/notes.txt'
  ]);
  // Passed through byte for byte: the broken file, the notes, the image; and
  // the new cover.jpg is that image.
  assert.equal(await fsp.readFile(out('04 Broken.flac'), 'utf8'), 'not audio');
  assert.equal(await fsp.readFile(out('scans/notes.txt'), 'utf8'), 'liner notes');
  assert.deepEqual(await bytesOf(out('folder.jpg')), await bytesOf(coverFile));
  assert.deepEqual(await bytesOf(out('cover.jpg')), await bytesOf(coverFile));

  // The tags as metaflac sees them.
  const tagsOf = async (file) => (await vorbisComments(out(file))).filter((line) => !line.startsWith('ENCODER=')).sort();
  assert.deepEqual(await tagsOf("01 Don't.flac"), ['ALBUM=Mess', 'ALBUMARTIST=AA', 'ARTIST=AA', 'DATE=2020', 'GENRE=Pop', 'TITLE=Don’t', 'TRACKNUMBER=1/4']);
  assert.deepEqual(await tagsOf('02 Two.flac'), ['ALBUM=Mess', 'ALBUMARTIST=AA', 'ARTIST=AA', 'DATE=2020', 'GENRE=Pop', 'TITLE=Two', 'TRACKNUMBER=2/4']);
  assert.deepEqual(await tagsOf('03 Three.flac'), ['ALBUM=Mess', 'ALBUMARTIST=AA', 'ARTIST=AA', 'DATE=2020', 'GENRE=Pop', 'TITLE=Three', 'TRACKNUMBER=3/4']);
  // One picture in every track: the cover where there was none, and the
  // track's own where it had one.
  for (const [source, file, picture] of [['01 Don_t.flac', "01 Don't.flac", embedded], ['02 Two.flac', '02 Two.flac', coverFile], ['03 Three.flac', '03 Three.flac', coverFile]]) {
    assert.equal((await probe(out(file))).pictures, 1, file);
    assert.deepEqual(await embeddedPicture(out(file)), await bytesOf(picture), file);
    assert.equal(await audioMd5(out(file)), await audioMd5(path.join(dir, source)), file);
  }
  // Stored, never deflated.
  const listing = (await run('unzip', ['-v', zipFile])).stdout.toString();
  assert.equal(/Defl/.test(listing), false, listing);
  assert.equal((listing.match(/ Stored /g) || []).length, 7, listing);
});

test('the cover comes out of another track when no image lies loose, and switched-off fixes are left alone', async () => {
  const dir = path.join(tmp, 'Embedded');
  await fsp.mkdir(dir, { recursive: true });
  const picture = path.join(tmp, 'green.jpg');
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=green:s=48x48', '-frames:v', '1', picture);
  const tags = (n) => metadataArgs({ album: n === 1 ? 'One' : 'Other', album_artist: 'AA', artist: 'AA', title: `t${n}`, track: `${n}/2` });
  await ffmpeg(...SINE, '-i', picture, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic', ...tags(1), path.join(dir, '1.m4a'));
  await ffmpeg(...SINE, ...tags(2), path.join(dir, '2.m4a'));

  const { name, before, result, after: cleaned } = await clean(dir, {
    edit: (fixes) => fixes.map((fix) => ({ ...fix, on: fix.id !== 'album' }))
  });
  assert.deepEqual(before.cover, { kind: 'embedded', file: 'Embedded/1.m4a' });
  assert.deepEqual(before.fixes.map((fix) => fix.id), ['album', 'cover_embed', 'cover_file']);
  // Only the track without a picture is rewritten.
  assert.equal(result.changed, 1);

  // The album name was left alone, so it is still two albums — and said so.
  assert.deepEqual(cleaned.verdict, { code: 'split', causes: ['album'], albums: 2, tracks: 2 });
  assert.deepEqual(cleaned.fixes.map((fix) => fix.id), ['album']);

  const { outDir } = await extract(result.blob, 'Embedded');
  assert.deepEqual(await bytesOf(path.join(outDir, name, 'cover.jpg')), await bytesOf(picture));
  assert.deepEqual(await embeddedPicture(path.join(outDir, name, '2.m4a')), await bytesOf(picture));
  assert.deepEqual(await bytesOf(path.join(outDir, name, '1.m4a')), await bytesOf(path.join(dir, '1.m4a')));
  assert.equal((await probe(path.join(outDir, name, '2.m4a'))).tags.album, 'Other');
});

test('two discs in two folders, with no number in any tag: numbered per disc, and the lyrics renamed with their track', async () => {
  const dir = path.join(tmp, 'Two');
  const files = ['CD1/01 Song.flac', "CD1/02 Don_t.flac", 'CD1/03 Song.flac', 'CD2/01 Song.flac', 'CD2/02 Song.flac', 'CD2/03 Song.flac'];
  for (const [i, file] of files.entries()) {
    await fsp.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await ffmpeg(...SINE, ...metadataArgs({ ALBUM: 'Two', ARTIST: 'AA', ALBUMARTIST: 'AA', TITLE: `t${i + 1}` }), path.join(dir, file));
  }
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', path.join(dir, 'cover.jpg'));
  await fsp.writeFile(path.join(dir, 'CD1', '02 Don_t.lrc'), '[00:00.00]words');

  const { name, before, result, after: cleaned } = await clean(dir);
  assert.deepEqual(before.fixes.map((fix) => fix.id), ['track_numbers', 'filenames', 'cover_embed']);
  assert.deepEqual(before.cannotFix, []);
  assert.deepEqual(result.failed, []);
  // Checked again, nothing is wrong: no gap, no number twice.
  assert.deepEqual(cleaned.fixes, []);
  assert.deepEqual(cleaned.cannotFix, []);
  assert.deepEqual(cleaned.verdict, { code: 'fine', albums: 1, tracks: 6 });

  const { outDir } = await extract(result.blob, 'Two');
  const out = (file) => path.join(outDir, name, file);
  assert.deepEqual((await fsp.readdir(path.join(outDir, name), { recursive: true })).sort(), [
    'CD1', "CD1/01 Song.flac", "CD1/02 Don't.flac", "CD1/02 Don't.lrc", 'CD1/03 Song.flac',
    'CD2', 'CD2/01 Song.flac', 'CD2/02 Song.flac', 'CD2/03 Song.flac', 'cover.jpg'
  ]);
  assert.equal(await fsp.readFile(out("CD1/02 Don't.lrc"), 'utf8'), '[00:00.00]words');
  const numbers = async (file) => (await vorbisComments(out(file))).filter((line) => /^(TRACK|DISC)NUMBER=/.test(line)).sort();
  for (const [file, disc, track] of [['CD1/01 Song.flac', 1, 1], ["CD1/02 Don't.flac", 1, 2], ['CD2/01 Song.flac', 2, 1], ['CD2/03 Song.flac', 2, 3]]) {
    assert.deepEqual(await numbers(file), [`DISCNUMBER=${disc}`, `TRACKNUMBER=${track}/3`], file);
  }
});

// --- Taking an album in ---------------------------------------------------------------

test('asAlbum: one top folder, junk dropped', () => {
  const entry = (file) => ({ path: file, size: 1 });
  const paths = (album) => album.entries.map((item) => item.path);
  const inFolder = asAlbum(['Al/2.flac', 'Al/1.flac', 'Al/.DS_Store', '__MACOSX/Al/._1.flac', 'Al/._2.flac'].map(entry), 'zip name');
  assert.equal(inFolder.name, 'Al');
  assert.equal(inFolder.guess, 'Al');
  assert.equal(asAlbum(['1.flac'].map(entry), 'zip name').guess, 'zip name');
  // Loose files with nothing to name them by: a folder name, but no guess.
  assert.deepEqual([asAlbum(['1.flac'].map(entry), '').name, asAlbum(['1.flac'].map(entry), '').guess], ['Album', '']);
  assert.deepEqual(paths(inFolder), ['Al/1.flac', 'Al/2.flac']);
  // Loose files, or more than one top folder: wrapped in a folder of their own.
  assert.deepEqual(paths(asAlbum(['1.flac', 'art/cover.jpg'].map(entry), 'zip name')), ['zip name/1.flac', 'zip name/art/cover.jpg']);
  assert.deepEqual(paths(asAlbum(['CD1/1.flac', 'CD2/1.flac'].map(entry), '')), ['Album/CD1/1.flac', 'Album/CD2/1.flac']);
});

test('refusal: no audio, a track over the ceiling, an album over the ceiling', () => {
  const entry = (file, size) => ({ path: file, size });
  assert.equal(refusal([entry('a/1.flac', 1e6), entry('a/cover.jpg', 1e6)]), null);
  assert.deepEqual(refusal([entry('a/cover.jpg', 1), entry('a/1.ogg', 1)]), { code: 'no_audio' });
  assert.deepEqual(refusal([entry('a/1.flac', 1e6), entry('a/2.flac', LIMITS.track + 1)]), {
    code: 'track_too_big',
    name: '2.flac',
    size: LIMITS.track + 1,
    limit: LIMITS.track
  });
  const many = Array.from({ length: 9 }, (_, i) => entry(`a/${i}.flac`, LIMITS.album / 8));
  assert.deepEqual(refusal(many), { code: 'album_too_big', size: (LIMITS.album / 8) * 9, limit: LIMITS.album });
});

// --- Zip names ------------------------------------------------------------------------

// A stored zip with the names exactly as given, bytes and flag — which no zip
// library will write for us, since they all encode the names themselves.
function rawZip(files, { utf8Flag = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(utf8Flag ? 0x800 : 0, 6);
    header.writeUInt32LE(zlib.crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    header.copy(entry, 6, 4, 30); // version needed … name length
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Blob([...local, directory, end]);
}

// TextEncoder only writes UTF-8, so the legacy bytes come from iconv.
async function encoded(text, encoding) {
  const proc = spawn('iconv', ['-f', 'UTF-8', '-t', encoding], { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = [];
  proc.stdout.on('data', (chunk) => out.push(chunk));
  proc.stdin.end(text);
  const code = await new Promise((resolve) => proc.on('close', resolve));
  assert.equal(code, 0, `iconv ${encoding}: ${text}`);
  return Buffer.concat(out);
}

const CHINESE = [
  '周杰伦 - 叶惠美/01 以父之名.flac',
  '周杰伦 - 叶惠美/02 懦夫.flac',
  '周杰伦 - 叶惠美/03 晴天.flac',
  '王菲/红豆.mp3',
  '陈奕迅 - 十年.mp3',
  '邓丽君/月亮代表我的心.flac',
  '五月天 - 后青春期的诗/突然好想你.m4a',
  '张学友 - 吻别.flac',
  '孙燕姿/遇见.flac',
  '林俊杰 - 江南.mp3',
  '万能青年旅店/杀死那个石家庄人.flac',
  '草东没有派对 - 丑奴儿/山海.flac',
  '窦唯 - 黑梦/高级动物.flac',
  '新裤子/没有理想的人不伤心.mp3',
  '封面.jpg',
  '崔健 - 新长征路上的摇滚/一无所有.flac',
  '李宗盛 - 山丘.flac',
  '告五人/爱人错过.m4a',
  '朴树 - 平凡之路.mp3',
  '歌词/专辑介绍.txt'
];
const JAPANESE = [
  'ゆらゆら帝国 - 空洞です/01 おはようまだやろう.flac',
  'ゆらゆら帝国 - 空洞です/07 空洞です.flac',
  '椎名林檎/無罪モラトリアム/丸の内サディスティック.flac',
  '宇多田ヒカル - First Love.mp3',
  'フィッシュマンズ/空中キャンプ/ナイトクルージング.flac',
  '山下達郎 - RIDE ON TIME.m4a',
  '坂本龍一/千のナイフ.flac',
  'はっぴいえんど - 風をあつめて.mp3',
  'きのこ帝国/東京.flac',
  '松任谷由実 - ひこうき雲.flac',
  'サカナクション/新宝島.m4a',
  '中島みゆき - 糸.mp3',
  'ジャケット.jpg',
  '歌詞カード.txt',
  '細野晴臣/泰安洋行/蝶々さん.flac',
  '相対性理論 - シフォン主義/LOVEずっきゅん.flac',
  '大貫妙子 - 都会.flac',
  'くるり/ばらの花.mp3',
  '東京事変 - 群青日和.flac',
  '竹内まりや - プラスティック・ラブ.flac'
];

test('zip names: GBK and Shift_JIS archives are read by a guess, UTF-8 with or without the flag exactly', async () => {
  for (const [encoding, label, names] of [['GBK', 'gbk', CHINESE], ['SHIFT_JIS', 'shift_jis', JAPANESE]]) {
    const files = [];
    for (const name of names) {
      files.push([await encoded(name, encoding), Buffer.from(name)]);
    }
    const { entries, encoding: guessed } = await openZip(rawZip(files));
    assert.equal(guessed, label);
    assert.deepEqual(entries.map((entry) => entry.path), names);
    // Each entry's content is its own name, so a mix-up of offsets would show.
    assert.equal(new TextDecoder().decode(await entries[3].read()), names[3]);
  }
  for (const utf8Flag of [false, true]) {
    const mixed = [...CHINESE.slice(0, 3), ...JAPANESE.slice(0, 3), 'Sigur Rós/Ágætis byrjun.flac'];
    const { entries, encoding } = await openZip(rawZip(mixed.map((name) => [Buffer.from(name), Buffer.from('x')]), { utf8Flag }));
    assert.equal(encoding, 'utf-8');
    assert.deepEqual(entries.map((entry) => entry.path), mixed);
  }
});

// How well the guess does when it has less to go on than a whole album: each
// name alone. The misses are pinned, so a better guess has to say so here.
test('zip names: the guess, one name at a time', async () => {
  const misses = { GBK: [], SHIFT_JIS: [] };
  for (const [encoding, label, names] of [['GBK', 'gbk', CHINESE], ['SHIFT_JIS', 'shift_jis', JAPANESE]]) {
    for (const name of names) {
      if (chooseNameEncoding([await encoded(name, encoding)]).encoding !== label) {
        misses[encoding].push(name);
      }
    }
  }
  assert.deepEqual(misses, { GBK: [], SHIFT_JIS: [] });
});

// What Windows Explorer writes outside East Asia. Each of these used to be
// taken for Shift_JIS or GBK ('Bj攔k', 'Ja'), or kept as Latin-1 with an
// invisible C1 control in it ('Beyonc' + U+0082).
const WESTERN = ['Björk - Homogenic/01 Jóga.flac', 'Björk - Homogenic/02 Hunter.flac', 'Mötley Crüe/01 Kickstart.mp3', 'Beyoncé/01 Halo.mp3'];
const TAIWANESE = ['五月天 - 後青春期的詩/突然好想你.m4a', '周杰倫 - 葉惠美/03 晴天.flac', '告五人/愛人錯過.m4a', '草東沒有派對 - 醜奴兒/山海.flac'];

test('zip names: western and Big5 archives are read by the same guess', async () => {
  for (const [codepage, label, names] of [['CP437', 'cp437', WESTERN], ['CP950', 'big5', TAIWANESE]]) {
    const files = [];
    for (const name of names) {
      files.push([await encoded(name, codepage), Buffer.from(name)]);
    }
    const zip = await openZip(rawZip(files));
    assert.equal(zip.encoding, label);
    assert.deepEqual(zip.alternatives, []);
    assert.deepEqual(zip.entries.map((entry) => entry.path), names);
    assert.ok(names.includes(zip.sample));
  }
  // Each alone, too: a single track is a zip people make.
  for (const name of WESTERN) {
    const { entries } = await openZip(rawZip([[await encoded(name, 'CP437'), Buffer.from('x')]]));
    assert.equal(entries[0].path, name);
  }
});

test('zip names: a toss-up is shown with each reading, and can be read the other way', async () => {
  const blob = rawZip([
    [Buffer.from('cover.jpg'), Buffer.from('x')],
    [await encoded('Amon Düül II/Yeti.flac', 'CP437'), Buffer.from('y')]
  ]);
  const zip = await openZip(blob);
  assert.equal(zip.encoding, 'cp437');
  // The sample is the name in doubt, not the first one.
  assert.equal(zip.sample, 'Amon Düül II/Yeti.flac');
  assert.deepEqual(zip.alternatives, [{ encoding: 'shift_jis', sample: 'Amon D＝l II/Yeti.flac' }]);

  const other = await openZip(blob, { encoding: 'shift_jis' });
  assert.equal(other.encoding, 'shift_jis');
  assert.deepEqual(other.entries.map((entry) => entry.path), ['cover.jpg', 'Amon D＝l II/Yeti.flac']);
  assert.deepEqual(other.alternatives, [{ encoding: 'cp437', sample: 'Amon Düül II/Yeti.flac' }]);
  assert.equal(new TextDecoder().decode(await other.entries[1].read()), 'y');
});

test('zip names: a name no encoding reads shows its unreadable bytes, never a control character', async () => {
  const { entries, encoding, sample } = await openZip(rawZip([[Buffer.from([0x41, 0x01, 0x82, 0x2e, 0x6d, 0x70, 0x33]), Buffer.from('x')]]));
  assert.equal(encoding, null);
  assert.equal(sample, null);
  assert.equal(entries[0].path, 'A\u2401\u00e9.mp3');
  // One unreadable name puts the whole archive byte for byte, and its other
  // names must stay apart: two tracks under one path would lose one of them.
  const mixed = await openZip(
    rawZip([
      [Buffer.from([0x41, 0x6c, 0x62, 0x2f, 0x82, 0x2e, 0x66, 0x6c, 0x61, 0x63]), Buffer.from('e')],
      [Buffer.from([0x41, 0x6c, 0x62, 0x2f, 0x94, 0x2e, 0x66, 0x6c, 0x61, 0x63]), Buffer.from('o')],
      [Buffer.from([0x41, 0x6c, 0x62, 0x2f, 0x0a, 0x2e, 0x74, 0x78, 0x74]), Buffer.from('n')]
    ])
  );
  assert.equal(mixed.encoding, null);
  assert.deepEqual(mixed.entries.map((entry) => entry.path), ['Alb/\u00e9.flac', 'Alb/\u00f6.flac', 'Alb/\u240a.txt']);
});

test('zip names: paths cannot climb out, backslashes are separators, folders are not files', async () => {
  const blob = rawZip(
    ['../../evil.flac', '/abs/1.flac', 'Al\\CD1\\1.flac', 'Al/', './Al/./2.flac'].map((name) => [Buffer.from(name), Buffer.from('x')])
  );
  assert.deepEqual((await openZip(blob)).entries.map((entry) => entry.path), ['evil.flac', 'abs/1.flac', 'Al/CD1/1.flac', 'Al/2.flac']);
});

test('a file that is no zip, and a zip made by the system zip', async () => {
  await assert.rejects(openZip(new Blob(['not a zip at all'])), ZipError);

  // Deflated, by Info-ZIP, with a non-ASCII name: the way a user's archive arrives.
  const stage = path.join(tmp, 'sys', 'Al');
  await fsp.mkdir(stage, { recursive: true });
  const text = 'liner notes '.repeat(500);
  await fsp.writeFile(path.join(stage, '空洞 ö.txt'), text);
  assert.equal((await run('zip', ['-qr', '../sys.zip', 'Al'], { cwd: path.dirname(stage) })).code, 0);
  const { entries } = await openZip(new Blob([await fsp.readFile(path.join(tmp, 'sys.zip'))]));
  assert.deepEqual(entries.map((entry) => [entry.path, entry.size]), [['Al/空洞 ö.txt', text.length]]);
  assert.equal(new TextDecoder().decode(await entries[0].read()), text);
  assert.equal(entries[0].mtime.getFullYear(), new Date().getFullYear());

  // And back out: what the writer makes, the reader reads.
  const zip = zipWriter();
  zip.add('Al/空洞 ö.txt', new TextEncoder().encode(text), new Date(1970, 0, 1));
  const again = await openZip(zip.finish());
  assert.equal(new TextDecoder().decode(await again.entries[0].read()), text);
});
