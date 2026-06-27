import path from 'node:path';

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

// Apostrophe-style filename damage from downloaders, e.g. "Don_t", "It_s",
// "I_m", "you_re". Restrict to known contraction/possessive suffixes so we do
// not touch legitimate underscores.
const APOSTROPHE_PATTERN = /([A-Za-z])_(t|s|m|re|ve|ll|d)\b/g;

export function suggestFilenameFix(fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const fixedBase = base.replace(APOSTROPHE_PATTERN, "$1'$2");
  if (fixedBase === base) {
    return null;
  }
  return `${fixedBase}${ext}`;
}

// Control bytes (excluding tab/newline/CR) show up in tags when a downloader
// truncated a Unicode code point to its low byte (e.g. U+2019 ’ -> 0x19).
const CONTROL_RANGES = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f]
];
const INVISIBLE_RANGES = [
  [0x200b, 0x200d], // zero-width space / joiners
  [0xfeff, 0xfeff] // BOM
];
const NBSP = 0x00a0;

const CONTROL_RE = rangeClass(CONTROL_RANGES, 'g');
const INVISIBLE_RE = rangeClass(INVISIBLE_RANGES, 'g');
const NBSP_RE = new RegExp(cp(NBSP), 'g');
const INVISIBLE_OR_NBSP_RE = rangeClass([...INVISIBLE_RANGES, [NBSP, NBSP]], '');
const PLACEHOLDER = cp(0x00b7); // visible middle dot ·

// Only the typographic-punctuation family has a confident single-codepoint
// reconstruction. Anything else (U+2606 -> 0x06, U+221E -> 0x1E, ...) is
// ambiguous and left for manual review.
const CONTROL_FIX = {
  0x13: cp(0x2013), // en dash –
  0x14: cp(0x2014), // em dash —
  0x18: cp(0x2018), // left single quote ‘
  0x19: cp(0x2019), // right single quote / apostrophe ’
  0x1c: cp(0x201c), // left double quote “
  0x1d: cp(0x201d) // right double quote ”
};
export const TEXT_FIELDS = ['title', 'artist', 'album', 'album_artist'];

// Collapse the spacing/encoding noise that silently splits albums: NBSP,
// zero-width chars, NFC drift, and stray/edge whitespace.
export function normalizeTagValue(value) {
  return value
    .normalize('NFC')
    .replace(NBSP_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Return a hygiene report for a tag value, or null when it is clean.
export function analyzeText(value) {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  CONTROL_RE.lastIndex = 0;
  const hasControl = CONTROL_RE.test(value);
  const hasInvisible = INVISIBLE_OR_NBSP_RE.test(value);
  const hasSpacing = value !== value.trim() || /\s{2,}/.test(value);
  const hasNfc = value !== value.normalize('NFC');

  if (!hasControl && !hasInvisible && !hasSpacing && !hasNfc) {
    return null;
  }

  let confident = true;
  const repaired = value.replace(CONTROL_RE, (ch) => {
    const fix = CONTROL_FIX[ch.charCodeAt(0)];
    if (fix) {
      return fix;
    }
    confident = false;
    return ch; // leave the unknown control char in place
  });

  CONTROL_RE.lastIndex = 0;
  return {
    kind: hasControl ? 'control' : 'whitespace',
    display: value.replace(CONTROL_RE, PLACEHOLDER),
    suggested: normalizeTagValue(repaired),
    confident
  };
}
