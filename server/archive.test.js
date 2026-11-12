import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { extractZipAlbum } from './archive.js';
import { acquireAlbum, releaseAlbum } from './metadata/lock.js';

// The smallest zip writer that yauzl accepts: local headers, data, central
// directory, end record. Each entry is stored or deflated; `corrupt` replaces
// the compressed bytes with garbage and `badCrc` records the wrong checksum —
// the two ways a damaged download actually reaches the server.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.body);
    const deflate = entry.deflate ?? false;
    let data = deflate ? zlib.deflateRawSync(raw) : raw;
    if (entry.corrupt) {
      data = Buffer.alloc(data.length + 8, 0xff);
    }
    const crc = entry.badCrc ? (zlib.crc32(raw) ^ 1) >>> 0 : zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let root;
let rawDir;
let savedRaw;

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-'));
  rawDir = path.join(root, 'RAW');
  savedRaw = config.rawDir;
  config.rawDir = rawDir;
});

after(async () => {
  config.rawDir = savedRaw;
  await fsp.rm(root, { recursive: true, force: true });
});

async function writeZip(name, entries) {
  const file = path.join(root, name);
  await fsp.writeFile(file, buildZip(entries));
  return file;
}

// Every file under dir, relative, sorted — or null when dir is not there.
async function tree(dir) {
  try {
    const all = await fsp.readdir(dir, { recursive: true });
    const files = [];
    for (const rel of all) {
      if ((await fsp.stat(path.join(dir, rel))).isFile()) {
        files.push(rel);
      }
    }
    return files.sort();
  } catch {
    return null;
  }
}

const tracks = (body) => [
  { name: 'Alb/01.flac', body: `${body} one`, deflate: true },
  { name: 'Alb/02.flac', body: `${body} two`, deflate: true }
];

test('a good archive extracts into its album folder', async () => {
  const zip = await writeZip('good.zip', [
    ...tracks('good'),
    { name: 'Alb/Scans/cover.jpg', body: 'art' }
  ]);
  const summary = await extractZipAlbum(zip, 'good.zip');
  assert.equal(summary.album, 'Alb');
  assert.equal(summary.acceptedCount, 3);
  assert.deepEqual(await tree(path.join(rawDir, 'Alb')), ['01.flac', '02.flac', path.join('Scans', 'cover.jpg')]);
  assert.equal(await fsp.readFile(path.join(rawDir, 'Alb', '02.flac'), 'utf8'), 'good two');
  await fsp.rm(path.join(rawDir, 'Alb'), { recursive: true });
});

test('a corrupt entry leaves nothing of the archive staged', async () => {
  const zip = await writeZip('corrupt.zip', [
    ...tracks('x'),
    { name: 'Alb/CD2/03.flac', body: 'three '.repeat(200), deflate: true, corrupt: true }
  ]);
  await assert.rejects(extractZipAlbum(zip, 'corrupt.zip'), (error) => error.code === 'corrupt_archive');
  assert.equal(await tree(path.join(rawDir, 'Alb')), null, 'no partial album, no empty folder');
});

// yauzl does not check CRC-32 (its README says so), so a flipped byte in a
// stored entry extracts "successfully" into a damaged track.
test('a checksum mismatch is caught, not staged', async () => {
  const zip = await writeZip('crc.zip', [
    { name: 'Alb/01.flac', body: 'fine' },
    { name: 'Alb/02.flac', body: 'damaged in transit', badCrc: true }
  ]);
  await assert.rejects(extractZipAlbum(zip, 'crc.zip'), (error) => error.code === 'corrupt_archive');
  assert.equal(await tree(path.join(rawDir, 'Alb')), null);
});

// Only what this extraction wrote is undone. An album already staged under the
// same name keeps every file it had, byte for byte — including one the archive
// would have overwritten.
test('a failed extraction into an existing album leaves the album as it was', async () => {
  const dir = path.join(rawDir, 'Alb');
  await fsp.mkdir(path.join(dir, 'CD2'), { recursive: true });
  await fsp.writeFile(path.join(dir, '01.flac'), 'the one already here');
  await fsp.writeFile(path.join(dir, 'CD2', 'keep.flac'), 'mine');

  const zip = await writeZip('again.zip', [
    { name: 'Alb/01.flac', body: 'new one', deflate: true },
    { name: 'Alb/New/02.flac', body: 'new two', deflate: true },
    { name: 'Alb/CD2/03.flac', body: 'three '.repeat(200), deflate: true, corrupt: true }
  ]);
  await assert.rejects(extractZipAlbum(zip, 'again.zip'), (error) => error.code === 'corrupt_archive');

  assert.deepEqual(await tree(dir), ['01.flac', path.join('CD2', 'keep.flac')]);
  assert.equal(await fsp.readFile(path.join(dir, '01.flac'), 'utf8'), 'the one already here');
  await fsp.rm(dir, { recursive: true });
});

test('an archive into an album that is importing is refused before writing', async () => {
  const zip = await writeZip('busy.zip', tracks('busy'));
  assert.equal(acquireAlbum('Alb'), true);
  try {
    await assert.rejects(extractZipAlbum(zip, 'busy.zip'), (error) => error.code === 'album_busy');
  } finally {
    releaseAlbum('Alb');
  }
  assert.equal(await tree(path.join(rawDir, 'Alb')), null);
});
