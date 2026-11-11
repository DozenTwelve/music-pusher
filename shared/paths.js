// Path helpers for the album-relative strings the shared rules work on
// ("CD1/01 Song.flac"). Pure string code, because node:path does not exist in a
// browser. They answer exactly what node:path's POSIX basename/extname answer —
// paths.test.js holds them to that — and, like POSIX, treat only "/" as a
// separator.

// The last segment of the path. Trailing slashes are not part of it, so
// "red/12/" is "12", just as "red/12" is.
export function basename(filePath) {
  let end = filePath.length;
  while (end > 0 && filePath[end - 1] === '/') {
    end -= 1;
  }
  return filePath.slice(filePath.lastIndexOf('/', end - 1) + 1, end);
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
