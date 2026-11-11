// Zip in, zip out, with fflate. Browser-safe.
// ponytail: both calls are synchronous and hold the whole archive plus every
// entry in memory. Fine for the spike; the real app should move to fflate's
// streaming Unzip / Zip + ZipPassThrough so one track is in flight at a time.

import { unzipSync, zipSync } from 'fflate';

// A zip entry name is UTF-8 only when the archive flags it so, and macOS `zip`
// (Info-ZIP 3.0) writes UTF-8 without the flag. fflate reads an unflagged name
// as Latin-1, one char per byte, which turns "空洞です" into mojibake — so take
// the bytes back and read them as UTF-8 when they are valid UTF-8.
// ponytail: UTF-8 or Latin-1 only. A Windows zip in GBK / Shift_JIS needs a
// guess between TextDecoder('gbk'), ('shift_jis'), ... — add when it shows up.
function decodeName(name) {
  if (!/[\u0080-ÿ]/.test(name) || /[^\u0000-ÿ]/.test(name)) {
    return name; // plain ASCII, or already decoded as UTF-8
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(name, (c) => c.charCodeAt(0)));
  } catch {
    return name;
  }
}

// -> [{ path, bytes }], directories and macOS resource forks dropped.
export function unzipAlbum(zipBytes) {
  const entries = unzipSync(zipBytes, {
    filter: (entry) => !entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/')
  });
  return Object.entries(entries)
    .map(([name, bytes]) => ({ path: decodeName(name), bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// [{ path, bytes }] -> zip bytes, stored (level 0): audio does not deflate, so
// compressing it only burns time.
//
// Marked as made on Unix with mode 0644. fflate's default is "made on MS-DOS",
// which makes Info-ZIP `unzip` (the macOS and Linux command line) run the names
// through a DOS-codepage translation: any non-ASCII name comes out as invalid
// bytes and the extraction fails. Unix origin without a mode extracts as 0000.
export function zipAlbum(entries) {
  return zipSync(Object.fromEntries(entries.map(({ path, bytes }) => [path, bytes])), {
    level: 0,
    os: 3,
    attrs: (0o100644 << 16) >>> 0
  });
}
