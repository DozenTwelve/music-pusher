const cp = String.fromCharCode;

// Build a RegExp character class from inclusive code-point ranges, so this
// source file never contains raw control bytes.
function rangeClass(ranges, flags) {
  let body = '';
  for (const [start, end] of ranges) {
    for (let code = start; code <= end; code += 1) {
      body += cp(code);
    }
  }
  return new RegExp(`[${body}]`, flags);
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const size = Math.floor(Math.log(value) / Math.log(1024));
  const amount = value / 1024 ** size;
  return `${amount.toFixed(amount < 10 && size > 0 ? 1 : 0)} ${units[size]}`;
}

// Make invisible/corrupt characters visible in tag-issue previews: control
// bytes and zero-width chars become a middle dot, a non-breaking space becomes
// an open-box symbol.
const HIDDEN_CHARS_RE = rangeClass(
  [
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x200b, 0x200d],
    [0xfeff, 0xfeff]
  ],
  'g'
);
const NBSP_RE = new RegExp(cp(0x00a0), 'g');
const DOT = cp(0x00b7); // middle dot ·
const OPEN_BOX = cp(0x2423); // open box ␣

export function showText(value) {
  return String(value ?? '')
    .replace(HIDDEN_CHARS_RE, DOT)
    .replace(NBSP_RE, OPEN_BOX);
}

export const FIELD_LABELS = {
  date: 'Date / Year',
  album: 'Album',
  album_artist: 'Album Artist',
  disc: 'Disc'
};
