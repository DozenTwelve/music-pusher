// Zip in, zip out, one file in memory at a time. No DOM and no Node built-ins:
// it needs Blob and TextDecoder, which a browser and `node --test` both have.
//
// In:  the central directory is read from the end of the Blob and each entry is
//      sliced out and inflated only when asked for, so the archive itself stays
//      on disk.
// Out: fflate's streaming Zip, each finished entry folded into a Blob, so the
//      written album is held once (and by the browser, which may page it out).

import { inflateSync, Zip, ZipPassThrough } from 'fflate';

export class ZipError extends Error {}

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

function decode(encoding, bytes) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
const count = (text, pattern) => (text.match(pattern) || []).length;

// The encoding of the names that are not flagged as UTF-8, judged on all of
// them together: 'utf-8', 'shift_jis', 'gbk', or null when none of them fits.
//
// macOS writes UTF-8 without the flag, so that is tried first; bytes that are
// valid UTF-8 are next to never anything else. Shift_JIS and GBK overlap — most
// Japanese names are valid GBK and many Chinese names valid Shift_JIS — and
// what tells them apart is half-width katakana: the common Chinese characters
// start with a byte Shift_JIS reads as one, and real Japanese names hardly use
// them. So Shift_JIS it is when the names decode with no more half-width kana
// than ordinary kana, and GBK otherwise.
// ponytail: no Big5 or EUC-KR (they would need telling apart from GBK by
// character frequency), and a Chinese name made only of rarer characters (lead
// byte E0 and up) reads as Shift_JIS.
export function guessEncoding(names) {
  const all = new Uint8Array(names.reduce((sum, name) => sum + name.length + 1, 0));
  let at = 0;
  for (const name of names) {
    all.set(name, at);
    at += name.length + 1;
    all[at - 1] = 0x0a;
  }
  if (decode('utf-8', all) != null) {
    return 'utf-8';
  }
  const japanese = decode('shift_jis', all);
  if (japanese != null && count(japanese, /[｡-ﾟ]/g) <= count(japanese, /[぀-ヿ]/g)) {
    return 'shift_jis';
  }
  if (decode('gbk', all) != null) {
    return 'gbk';
  }
  return japanese != null ? 'shift_jis' : null;
}

// Info-ZIP's Unicode Path extra field (0x7075): the name in UTF-8, written next
// to a name in a local code page.
function unicodePath(extra) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let at = 0; at + 4 <= extra.length; ) {
    const size = view.getUint16(at + 2, true);
    if (view.getUint16(at, true) === 0x7075 && size > 5) {
      return decode('utf-8', extra.subarray(at + 9, at + 4 + size));
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

// -> { entries: [{ path, size, mtime, read() }], encoding }
// `read()` resolves to the entry's bytes. `encoding` is the guess the names
// were read with — 'utf-8' when nothing had to be guessed, null when no
// encoding fitted and the names are shown byte for byte.
// ponytail: no zip64 (archives past 4 GB or 65535 entries) and no encryption;
// both are refused with a ZipError rather than misread.
export async function openZip(blob) {
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
  const encoding = guessEncoding(found.filter((entry) => !isUtf8(entry)).map((entry) => entry.name));
  const nameOf = (entry) =>
    entry.unicode ??
    decode(entry.flags & 0x800 ? 'utf-8' : encoding || 'utf-8', entry.name) ??
    String.fromCharCode(...entry.name);

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
  return { entries, encoding };
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
