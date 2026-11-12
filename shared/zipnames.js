// The encoding of zip entry names that are not flagged as UTF-8, judged on
// all of them together. A zip made on Windows stores names in the OEM code
// page of the machine that made it, and macOS writes UTF-8 without setting the
// flag, so the bytes have to be read by a guess. Shared by the server's zip
// upload and the browser's zip reader: TextDecoder and plain JavaScript only.

// Windows' OEM code pages for the US and western Europe. TextDecoder knows
// neither, so here is the upper half of each; the lower half is ASCII.
const CP437 =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5' +
  '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567' +
  '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
  '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229' +
  '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';
const CP850 =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5' +
  '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u00d7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4' +
  '\u00f0\u00d0\u00ca\u00cb\u00c8\u0131\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580' +
  '\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\u00fe\u00de\u00da\u00db\u00d9\u00fd\u00dd\u00af\u00b4' +
  '\u00ad\u00b1\u2017\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0';
const OEM = { cp437: CP437, cp850: CP850 };

// In the order a tie goes: UTF-8 first, since bytes that are valid UTF-8 are
// next to never anything else; then CP437, the zip format's own default, which
// reads the common accented letters exactly as CP850 does.
export const NAME_ENCODINGS = ['utf-8', 'cp437', 'cp850', 'shift_jis', 'gbk', 'big5'];

// The bytes of a name in `encoding`, or null when they are not valid in it.
export function decodeName(encoding, bytes) {
  const table = OEM[encoding];
  if (table) {
    let text = '';
    for (const byte of bytes) {
      text += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80];
    }
    return text;
  }
  try {
    // A leading U+FEFF is part of a name, not a byte order mark.
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

// A name no encoding fits, read byte for byte as CP437 with control bytes
// shown as their control pictures (\u240a for 0x0A): nothing in it is
// invisible, and two different names never come out as one.
export function rawName(bytes) {
  return decodeName('cp437', bytes).replace(/[\x00-\x1f\x7f]/g, (ch) => (ch === '\x7f' ? '\u2421' : String.fromCharCode(0x2400 + ch.charCodeAt(0))));
}

// What no file name holds: controls (C0 and C1), private use, U+FFFD.
const IMPOSSIBLE = /[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd\u{f0000}-\u{10ffff}]/u;

const LATIN = /[A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f]/;
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
// Han, kana, and the full-width Latin letters CJK names use.
const CJK = /[\p{Script=Han}\u3040-\u30ff\u31f0-\u31ff\uff21-\uff3a\uff41-\uff5a]/u;
// Small kana and the long-vowel mark, which only ever follow another kana.
const TRAILING_KANA = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶー]/;
const HALF_KANA = /[\uff61-\uff9f]/;
// CJK brackets, marks and full-width punctuation.
const WIDE = /[\u3000-\u303f\uff01-\uff20\uff3b-\uff40\uff5b-\uff60]/;
// Other punctuation that sits in real names: typographic quotes and dashes,
// and a few symbols put in titles.
const NEUTRAL = /[\u00a0\u00b4\u00d7\u00f7\u2010-\u2027\u2605\u2606\u266a\u266b]/;

function kind(ch) {
  if (ch < '\u0080') {
    return LATIN.test(ch) ? 'latin' : 'neutral';
  }
  if (LATIN.test(ch)) {
    return 'accent';
  }
  if (CJK.test(ch)) {
    return 'cjk';
  }
  if (WIDE.test(ch)) {
    return 'wide';
  }
  if (!HALF_KANA.test(ch) && /\p{L}/u.test(ch)) {
    return 'other';
  }
  return NEUTRAL.test(ch) ? 'neutral' : 'odd';
}
const latin = (k) => k === 'latin' || k === 'accent';
const letter = (k) => latin(k) || k === 'cjk' || k === 'other';
const script = (k) => (k === 'accent' ? 'latin' : k);

// How unlike a real name `text` is: two points per symbol no name carries (box
// drawing, maths, half-width katakana), per jump between scripts inside a word
// (Latin into CJK, either into Greek or Cyrillic), per CJK punctuation mark
// inside a Latin word and per small kana with no kana before it; one per two
// accented letters side by side. That is what
// one code page makes of another's bytes.
function oddness(text) {
  const chars = Array.from(text);
  const kinds = chars.map(kind);
  let points = 0;
  kinds.forEach((now, i) => {
    const before = kinds[i - 1];
    if (now === 'odd') {
      points += 2;
    } else if (now === 'wide') {
      points += latin(before) && latin(kinds[i + 1]) ? 2 : 0;
    } else if (now === 'cjk' && TRAILING_KANA.test(chars[i]) && !KANA.test(chars[i - 1] || '')) {
      points += 2;
    } else if (letter(now) && letter(before)) {
      if (script(now) !== script(before)) {
        points += 2;
      } else if (now === 'accent' && before === 'accent') {
        points += 1;
      }
    }
  });
  return points;
}

// The double-byte code pages each keep their common characters in one block,
// and reading one as another lands mostly outside it: points per character by
// where its bytes sit. 0 is punctuation or the common block; 1 is the rarer
// characters, and kana in GBK; 2 is Greek, Cyrillic and box drawing.
// Big5's common block shares its byte range with GB2312's, so GBK text —
// Chinese, or Japanese kana — mostly reads as valid Big5 there. A real Big5
// name rarely keeps to that range, so a character in it costs Big5 a point.
const RARITY = {
  gbk(lead, trail) {
    if (trail < 0xa1) return 1;
    if ((lead >= 0xa1 && lead <= 0xa3) || (lead >= 0xb0 && lead <= 0xd7)) return 0;
    if (lead === 0xa4 || lead === 0xa5) return 1;
    return lead <= 0xa9 ? 2 : 1;
  },
  big5(lead, trail) {
    if (lead >= 0xa1 && lead <= 0xa3) return 0;
    if ((lead >= 0xa4 && lead < 0xc6) || (lead === 0xc6 && trail <= 0x7e)) return trail >= 0xa1 ? 1 : 0;
    return lead >= 0xc6 && lead <= 0xc8 ? 2 : 1;
  },
  shift_jis(lead, trail) {
    if (lead === 0x81 || lead === 0x82 || (lead === 0x83 && trail <= 0x96)) return 0;
    if (lead === 0x83 || lead === 0x84) return 2;
    return lead >= 0x88 && (lead < 0x98 || (lead === 0x98 && trail <= 0x72)) ? 0 : 1;
  }
};

function rarity(encoding, bytes) {
  // Valid UTF-8 is evidence in itself: legacy bytes make a valid two-byte
  // sequence now and then, a longer one hardly ever.
  if (encoding === 'utf-8') {
    return bytes.reduce((sum, byte) => sum - (byte >= 0xe0 ? 2 : byte >= 0xc2 ? 1 : 0), 0);
  }
  const points = RARITY[encoding];
  if (!points) {
    return 0;
  }
  let sum = 0;
  for (let at = 0; at < bytes.length; at += 1) {
    const lead = bytes[at];
    // Shift_JIS reads A1-DF alone as half-width katakana, which oddness counts.
    if (lead < 0x80 || (encoding === 'shift_jis' && lead >= 0xa1 && lead <= 0xdf)) {
      continue;
    }
    // GB18030's four-byte form: lead, digit, lead, digit.
    if (encoding === 'gbk' && bytes[at + 1] >= 0x30 && bytes[at + 1] <= 0x39) {
      sum += 2;
      at += 3;
      continue;
    }
    sum += points(lead, bytes[at + 1]);
    at += 1;
  }
  return sum;
}

// Points apart at which two readings stop being a toss-up.
const CLEAR = 2;

// Each folder and file name once, as bytes: an album's folder is in every
// track's path, and counting it each time would make one name's evidence look
// like many. 0x2F is never part of a double-byte character in these code pages.
function segments(names) {
  const seen = new Map();
  for (const name of names) {
    let start = 0;
    for (let at = 0; at <= name.length; at += 1) {
      if (at === name.length || name[at] === 0x2f) {
        const segment = name.subarray(start, at);
        seen.set(String.fromCharCode(...segment), segment);
        start = at + 1;
      }
    }
  }
  return seen;
}

// -> { encoding, sample, alternatives }
// `encoding` is the reading chosen, null when none fits. `alternatives` are
// the encodings that fit nearly as well and read the names differently — and
// valid UTF-8 whenever it was not chosen; when there are any, the choice is a
// toss-up the user should see. `sample` is the index of the name that best
// shows whether the reading is right — of those the readings disagree on, the
// one least like a name — or null when no guess was made.
export function chooseNameEncoding(names) {
  if (names.every((name) => name.every((byte) => byte >= 0x20 && byte < 0x7f))) {
    return { encoding: 'utf-8', sample: null, alternatives: [] };
  }
  const parts = segments(names);
  const readings = [];
  for (const encoding of NAME_ENCODINGS) {
    const scored = new Map();
    for (const [key, segment] of parts) {
      const text = decodeName(encoding, segment);
      if (text == null || IMPOSSIBLE.test(text)) {
        break;
      }
      scored.set(key, oddness(text) + rarity(encoding, segment));
    }
    if (scored.size === parts.size) {
      readings.push({ encoding, scored, texts: names.map((name) => decodeName(encoding, name)), total: [...scored.values()].reduce((a, b) => a + b, 0) });
    }
  }
  if (readings.length === 0) {
    return { encoding: null, sample: null, alternatives: [] };
  }
  // Stable, so a tie keeps the order of NAME_ENCODINGS.
  readings.sort((a, b) => a.total - b.total);
  const [best, ...rest] = readings;
  const differ = rest.filter((reading) => reading.texts.some((text, i) => text !== best.texts[i]));
  const close = differ.filter((reading) => reading.total - best.total < CLEAR || reading.encoding === 'utf-8');
  // Valid UTF-8 needs no second opinion unless another reading is as good.
  if (best.encoding === 'utf-8' && close.length === 0) {
    return { encoding: 'utf-8', sample: null, alternatives: [] };
  }
  // The names worth showing: those the rival readings make something else of,
  // or, when every other reading failed, any name that is not plain ASCII.
  const rivals = close.length > 0 ? close : differ;
  const telling = (i) =>
    rivals.length > 0 ? rivals.some((reading) => reading.texts[i] !== best.texts[i]) : names[i].some((byte) => byte >= 0x80);
  const points = names.map((name) => [...segments([name]).keys()].reduce((sum, key) => sum + best.scored.get(key), 0));
  let sample = null;
  names.forEach((name, i) => {
    if (telling(i) && (sample == null || points[i] > points[sample])) {
      sample = i;
    }
  });
  return { encoding: best.encoding, sample, alternatives: close.map((reading) => reading.encoding) };
}
