import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDate } from './fix.js';
import { parseNumberPair, leadingTrackNumber } from './probe.js';
import { analyzeText, normalizeTagValue, suggestFilenameFix, TEXT_FIELDS } from './text.js';
import { albumBase } from './inspect.js';

// Characterization tables for the pure album rules: input on the left, what the
// code answers today on the right. Several rows pin behaviour that is merely
// what happens rather than what anyone designed — that is the point. A change
// to any row is a behaviour change and has to be made on purpose.

const cp = String.fromCharCode;
const NBSP = cp(0x00a0);
const ZERO_WIDTH_SPACE = cp(0x200b);
const BOM = cp(0xfeff);
const MIDDLE_DOT = cp(0x00b7);

function checkTable(fn, table) {
  for (const [input, expected] of table) {
    assert.deepStrictEqual(fn(input), expected, `${fn.name}(${JSON.stringify(input)})`);
  }
}

test('normalizeDate table', () => {
  checkTable(normalizeDate, [
    ['2026', '2026'],
    ['2026-05', '2026-05'],
    ['2026-05-29', '2026-05-29'],
    ['2026.5.29', '2026-05-29'],
    ['2026/5/29', '2026-05-29'],
    ['2026-5-9', '2026-05-09'],
    ['2026.5', '2026-05'],
    ['2026/12', '2026-12'],
    // Separators may be mixed.
    ['2026-5.29', '2026-05-29'],
    ['2026/05-29', '2026-05-29'],
    ['  2026-05-29\t', '2026-05-29'],
    ['0000', '0000'],
    ['2026-1-31', '2026-01-31'],
    // Only the range is checked, not the calendar.
    ['2026-02-31', '2026-02-31'],
    ['2026-12-31', '2026-12-31'],
    ['2026-00', null],
    ['2026-13', null],
    ['2026-05-00', null],
    ['2026-05-32', null],
    ['2026-', null],
    ['2026-05-', null],
    ['2026-05-29-01', null],
    ['2026-05-29T00:00:00', null],
    ['2026-005', null],
    ['26-05-29', null],
    ['20260529', null],
    ['202', null],
    ['20266', null],
    ['2026 05 29', null],
    ['May 2026', null],
    ['', null],
    ['   ', null]
  ]);
});

test('parseNumberPair table', () => {
  const none = { num: null, total: null };
  checkTable(parseNumberPair, [
    ['1', { num: 1, total: null }],
    ['1/8', { num: 1, total: 8 }],
    ['03/09', { num: 3, total: 9 }],
    [' 3 / 12 ', { num: 3, total: 12 }],
    ['12/100', { num: 12, total: 100 }],
    ['0', { num: 0, total: null }],
    ['0/0', { num: 0, total: 0 }],
    ['007', { num: 7, total: null }],
    // Numbers are accepted as well as strings.
    [5, { num: 5, total: null }],
    [0, { num: 0, total: null }],
    [null, none],
    [undefined, none],
    ['', none],
    ['   ', none],
    ['A1', none],
    ['1A', none],
    ['1/', none],
    ['/8', none],
    ['1/8/2', none],
    ['1.5', none],
    ['-1', none],
    ['1 of 8', none],
    ['1-8', none]
  ]);
});

test('leadingTrackNumber table', () => {
  checkTable(leadingTrackNumber, [
    ['01 Song.flac', 1],
    ['7 - Song.flac', 7],
    ['12. Song.flac', 12],
    ['003-Song.flac', 3],
    ['  9 Song.flac', 9],
    ['05.flac', 5],
    ['100 Years.flac', 100],
    // Only the file name is read, never a folder above it.
    ['CD2/12 Song.flac', 12],
    ['2024 Remaster/03 Song.flac', 3],
    ['03 Disc/Song.flac', null],
    ['/data/RAW/Some Album/CD1/07 Song.flac', 7],
    ['/data/RAW/01 Album/Song.flac', null],
    // More than three digits is a year or an id, not a track number.
    ['1234 Song.flac', null],
    ['2024 Song.flac', null],
    // No word boundary after the digits.
    ['01_Song.flac', null],
    ['1st Song.flac', null],
    ['Song 05.flac', null],
    ['Song.flac', null],
    ['-01 Song.flac', null],
    ['', null]
  ]);
});

test('normalizeTagValue table', () => {
  checkTable(normalizeTagValue, [
    ['Plain', 'Plain'],
    ['  padded  ', 'padded'],
    ['two  spaces', 'two spaces'],
    ['tab\t\ttab', 'tab tab'],
    [`Test${NBSP}Album`, 'Test Album'],
    [`Test${NBSP}${NBSP}Album`, 'Test Album'],
    [`zero${ZERO_WIDTH_SPACE}width`, 'zerowidth'],
    [`${BOM}Title`, 'Title'],
    // Decomposed e + combining acute becomes the single code point.
    [`Caf${cp(0x65)}${cp(0x0301)}`, `Caf${cp(0xe9)}`],
    // Newlines are not collapsed.
    ['line\n\nbreak', 'line\n\nbreak'],
    ['', '']
  ]);
});

test('analyzeText table', () => {
  const table = [
    ['Plain Title', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
    ['a b', null],
    ['line\nbreak', null],
    // A code point truncated to its low byte, from the family that has one
    // confident reconstruction.
    [
      `Don${cp(0x19)}t Stop`,
      { kind: 'control', display: `Don${MIDDLE_DOT}t Stop`, suggested: `Don${cp(0x2019)}t Stop`, confident: true }
    ],
    [
      `${cp(0x1c)}Hi${cp(0x1d)} ${cp(0x13)} ${cp(0x14)} ${cp(0x18)}x`,
      {
        kind: 'control',
        display: `${MIDDLE_DOT}Hi${MIDDLE_DOT} ${MIDDLE_DOT} ${MIDDLE_DOT} ${MIDDLE_DOT}x`,
        suggested: `${cp(0x201c)}Hi${cp(0x201d)} ${cp(0x2013)} ${cp(0x2014)} ${cp(0x2018)}x`,
        confident: true
      }
    ],
    // Ambiguous control bytes are shown, left in place, and not vouched for.
    [
      `Star ${cp(0x06)}`,
      { kind: 'control', display: `Star ${MIDDLE_DOT}`, suggested: `Star ${cp(0x06)}`, confident: false }
    ],
    [
      `a${cp(0x19)}b${cp(0x06)}`,
      { kind: 'control', display: `a${MIDDLE_DOT}b${MIDDLE_DOT}`, suggested: `a${cp(0x2019)}b${cp(0x06)}`, confident: false }
    ],
    [
      `a${cp(0x0b)}b`,
      { kind: 'control', display: `a${MIDDLE_DOT}b`, suggested: `a${cp(0x0b)}b`, confident: false }
    ],
    [
      `a${cp(0x00)}b`,
      { kind: 'control', display: `a${MIDDLE_DOT}b`, suggested: `a${cp(0x00)}b`, confident: false }
    ],
    // Control damage and spacing noise together: reported as control, both repaired.
    [
      ` Don${cp(0x19)}t${NBSP}Stop `,
      { kind: 'control', display: ` Don${MIDDLE_DOT}t${NBSP}Stop `, suggested: `Don${cp(0x2019)}t Stop`, confident: true }
    ],
    // Invisible and spacing noise.
    [
      `Test${NBSP}Album`,
      { kind: 'whitespace', display: `Test${NBSP}Album`, suggested: 'Test Album', confident: true }
    ],
    [
      `zero${ZERO_WIDTH_SPACE}width`,
      { kind: 'whitespace', display: `zero${ZERO_WIDTH_SPACE}width`, suggested: 'zerowidth', confident: true }
    ],
    [`${BOM}Title`, { kind: 'whitespace', display: `${BOM}Title`, suggested: 'Title', confident: true }],
    [' padded ', { kind: 'whitespace', display: ' padded ', suggested: 'padded', confident: true }],
    ['two  spaces', { kind: 'whitespace', display: 'two  spaces', suggested: 'two spaces', confident: true }],
    ['tab\t\ttab', { kind: 'whitespace', display: 'tab\t\ttab', suggested: 'tab tab', confident: true }],
    // Flagged, but the suggestion is the value unchanged: newlines are not collapsed.
    ['line\n\nbreak', { kind: 'whitespace', display: 'line\n\nbreak', suggested: 'line\n\nbreak', confident: true }],
    // NFC drift alone.
    [
      `Caf${cp(0x65)}${cp(0x0301)}`,
      {
        kind: 'whitespace',
        display: `Caf${cp(0x65)}${cp(0x0301)}`,
        suggested: `Caf${cp(0xe9)}`,
        confident: true
      }
    ]
  ];
  checkTable(analyzeText, table);
  // The patterns are global regexes; a second pass in the opposite order shows
  // no state leaks from one call into the next.
  checkTable(analyzeText, [...table].reverse());
});

test('the tag fields checked for text hygiene', () => {
  assert.deepStrictEqual(TEXT_FIELDS, ['title', 'artist', 'album', 'album_artist']);
});

test('suggestFilenameFix table', () => {
  checkTable(suggestFilenameFix, [
    ['01 Don_t Stop.flac', "01 Don't Stop.flac"],
    ['It_s Time.mp3', "It's Time.mp3"],
    ['I_m Here.m4a', "I'm Here.m4a"],
    ['you_re.flac', "you're.flac"],
    ['We_ve Got.flac', "We've Got.flac"],
    ['I_ll Be.flac', "I'll Be.flac"],
    ['He_d Go.flac', "He'd Go.flac"],
    ['Don_t and Can_t.flac', "Don't and Can't.flac"],
    // Legitimate underscores are left alone.
    ['my_song.flac', null],
    ['a_b.flac', null],
    ['Rock_n_Roll.flac', null],
    ['01_track.flac', null],
    ['1_s.flac', null],
    ['Plain Name.flac', null],
    ['', null],
    // Extension handling: only the last one is set aside, and it is never rewritten.
    ['Don_t', "Don't"],
    ['I_m.tar.gz', "I'm.tar.gz"],
    ['Track.it_s', null],
    ['It_s.', "It's."],
    ['It_s..flac', "It's..flac"],
    // A leading-dot name has no extension, so the whole of it is the base.
    ['.Don_t', ".Don't"],
    ['.it_s.flac', ".it's.flac"],
    // Unicode around the damage.
    ['Café Don_t.flac', "Café Don't.flac"],
    ['空洞です It_s.flac', "空洞です It's.flac"],
    // Callers pass a bare file name; a path still only loses the file's own extension.
    ['CD1/01 Don_t.flac', "CD1/01 Don't.flac"],
    ['v1.0/Don_t', "v1.0/Don't"]
  ]);
});

test('albumBase table', () => {
  checkTable(albumBase, [
    ['The Scholars', 'The Scholars'],
    ['The Scholars [Explicit]', 'The Scholars'],
    ['The Scholars (Deluxe Edition)', 'The Scholars'],
    ['The Scholars (Deluxe) [Explicit]', 'The Scholars'],
    ['The Scholars [Explicit](Deluxe)', 'The Scholars'],
    ['  The Scholars  [Explicit]  ', 'The Scholars'],
    [`The Scholars${NBSP}(Deluxe)`, 'The Scholars'],
    // Mismatched bracket kinds still count as a marker.
    ['The Scholars (Deluxe]', 'The Scholars'],
    // Only trailing markers go.
    ['Album [Live] Sessions', 'Album [Live] Sessions'],
    ['(Live) Album', '(Live) Album'],
    ['Album (Deluxe', 'Album (Deluxe'],
    ['Album Deluxe)', 'Album Deluxe)'],
    // A nested bracket is not a marker, and shields what precedes it.
    ['Album (feat. (x))', 'Album (feat. (x))'],
    ['Album (Deluxe) (feat. (x))', 'Album (Deluxe) (feat. (x))'],
    // A name that is nothing but a marker has an empty base.
    ['[Explicit]', ''],
    ['()', ''],
    ['', ''],
    [null, ''],
    [undefined, ''],
    [1989, '1989']
  ]);
});
