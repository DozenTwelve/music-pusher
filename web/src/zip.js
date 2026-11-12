// Zip in, zip out, one file in memory at a time. No DOM and no Node built-ins:
// it needs Blob and TextDecoder, which a browser and `node --test` both have.
//
// In:  the central directory is read from the end of the Blob and each entry is
//      sliced out and inflated only when asked for, so the archive itself stays
//      on disk.
// Out: fflate's streaming Zip, each finished entry folded into a Blob, so the
//      written album is held once (and by the browser, which may page it out).

import { inflateSync, Zip, ZipPassThrough } from 'fflate';
import { chooseNameEncoding, decodeName, rawName } from '../../shared/zipnames.js';

export class ZipError extends Error {}

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

// Info-ZIP's Unicode Path extra field (0x7075): the name in UTF-8, written next
// to a name in a local code page.
function unicodePath(extra) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let at = 0; at + 4 <= extra.length; ) {
    const size = view.getUint16(at + 2, true);
    if (view.getUint16(at, true) === 0x7075 && size > 5) {
      return decodeName('utf-8', extra.subarray(at + 9, at + 4 + size));
    }
    at += 4 + size;
  }
  return null;
}

// Forward slashes only, and no segment that climbs out of the folder the
// archive is extracted into — the names go straight into the zip handed back.
const safePath = (name) =>
  name
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');

const dosDate = (date, time) =>
  new Date((date >> 9) + 1980, ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);

// -> { entries: [{ path, size, mtime, read() }], encoding, sample, alternatives }
// `read()` resolves to the entry's bytes. The names not flagged as UTF-8 are
// read in one encoding for the whole archive (see shared/zipnames.js), or in
// `options.encoding` when given. `encoding` is the one used — 'utf-8' when
// nothing had to be guessed, null when no encoding fitted and the names are
// shown byte for byte (shared rawName), each still distinct. `sample` is the name that best shows whether
// the reading is right, and `alternatives` the other readings that fit nearly
// as well, each as { encoding, sample }: a toss-up to put to the user.
// ponytail: no zip64 (archives past 4 GB or 65535 entries) and no encryption;
// both are refused with a ZipError rather than misread.
export async function openZip(blob, options = {}) {
  const tail = await bytesOf(blob.slice(Math.max(0, blob.size - 65557)));
  const tailView = new DataView(tail.buffer);
  let end = tail.length - 22;
  while (end >= 0 && tailView.getUint32(end, true) !== END) {
    end -= 1;
  }
  if (end < 0) {
    throw new ZipError('not a zip archive');
  }
  const total = tailView.getUint16(end + 10, true);
  const size = tailView.getUint32(end + 12, true);
  const offset = tailView.getUint32(end + 16, true);
  if (total === 0xffff || offset === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported');
  }

  const directory = await bytesOf(blob.slice(offset, offset + size));
  const view = new DataView(directory.buffer);
  const found = [];
  for (let at = 0, n = 0; n < total; n += 1) {
    if (at + 46 > directory.length || view.getUint32(at, true) !== CENTRAL) {
      throw new ZipError('damaged central directory');
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const name = directory.subarray(at + 46, at + 46 + nameLength);
    found.push({
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      mtime: dosDate(view.getUint16(at + 14, true), view.getUint16(at + 12, true)),
      packed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      start: view.getUint32(at + 42, true),
      name,
      unicode: unicodePath(directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength))
    });
    at += 46 + nameLength + extraLength + view.getUint16(at + 32, true);
  }

  const isUtf8 = (entry) => entry.flags & 0x800 || entry.unicode != null;
  const legacy = found.filter((entry) => !isUtf8(entry)).map((entry) => entry.name);
  const choice = chooseNameEncoding(legacy);
  const encoding = options.encoding ?? choice.encoding;
  const read = (name, as) => (as && decodeName(as, name)) ?? rawName(name);
  const nameOf = (entry) => entry.unicode ?? read(entry.name, isUtf8(entry) ? 'utf-8' : encoding);
  const telling = choice.sample == null ? null : legacy[choice.sample];
  const alternatives = telling
    ? [choice.encoding, ...choice.alternatives]
        .filter((other) => other && other !== encoding)
        .map((other) => ({ encoding: other, sample: read(telling, other) }))
    : [];

  const entries = found
    .map((entry) => ({ ...entry, name: nameOf(entry) }))
    .filter((entry) => !entry.name.endsWith('/') && safePath(entry.name))
    .map((entry) => ({
      path: safePath(entry.name),
      size: entry.size,
      mtime: entry.mtime,
      async read() {
        if (entry.flags & 1) {
          throw new ZipError('encrypted entry');
        }
        // The local header repeats the name and carries its own extra field.
        const header = new DataView(await blob.slice(entry.start, entry.start + 30).arrayBuffer());
        const data = entry.start + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const packed = await bytesOf(blob.slice(data, data + entry.packed));
        if (entry.method === 0) {
          return packed;
        }
        if (entry.method !== 8) {
          throw new ZipError(`compression method ${entry.method} is not supported`);
        }
        return inflateSync(packed, { out: new Uint8Array(entry.size) });
      }
    }));
  return { entries, encoding, sample: telling && read(telling, encoding), alternatives };
}

// A zip being written. `add(path, bytes, mtime)` per file, then `finish()` for
// the Blob. Stored, not deflated: audio does not compress, so deflating it only
// burns time.
//
// Marked as made on Unix with mode 0644. fflate's default is "made on MS-DOS",
// which makes Info-ZIP `unzip` (the macOS and Linux command line) run the names
// through a DOS-codepage translation: any non-ASCII name comes out as invalid
// bytes and the extraction fails. Unix origin without a mode extracts as 0000.
export function zipWriter() {
  const finished = [];
  let chunks = [];
  let failure = null;
  const zip = new Zip((error, chunk) => {
    failure ||= error;
    chunks.push(chunk);
  });
  // Folding the chunks into a Blob hands them to the browser, so the page's own
  // memory holds one file's worth at a time.
  const fold = () => {
    if (failure) {
      throw failure;
    }
    finished.push(new Blob(chunks));
    chunks = [];
  };
  return {
    add(path, bytes, mtime) {
      const file = new ZipPassThrough(path);
      file.os = 3;
      file.attrs = (0o100644 << 16) >>> 0;
      // The zip format has no dates before 1980.
      if (mtime && new Date(mtime).getFullYear() >= 1980) {
        file.mtime = mtime;
      }
      zip.add(file);
      file.push(bytes, true);
      fold();
    },
    finish() {
      zip.end();
      fold();
      return new Blob(finished, { type: 'application/zip' });
    }
  };
}
