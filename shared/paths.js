// Path helpers for the album-relative strings the shared rules work on
// ("CD1/01 Song.flac"). Pure string code, because node:path does not exist in a
// browser. They answer exactly what node:path's POSIX basename/extname answer
// for a file path — paths.test.js holds them to that — and, like POSIX, treat
// only "/" as a separator. A path ending in "/" names a folder, not a file, and
// is not handled.

export function basename(filePath) {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

// The extension of the file name, dot included, or '' when it has none. A
// leading dot does not start an extension (".hidden" has none), and ".." is the
// parent folder, not a name ending in an empty extension.
export function extname(filePath) {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name === '..') {
    return '';
  }
  return name.slice(dot);
}
