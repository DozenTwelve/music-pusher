// Rules for single tag values: dates and track/disc numbers. Dependency-free,
// like extensions.js, so the server and a browser build read them the same way.

import { basename } from './paths.js';

// Everything downstream of a date tag parses it as ISO. ffmpeg writes whatever
// string it is handed, so a hand-typed `2026.5.29` survives the fix, reaches
// beets, fails its parse, and comes back out of the import as `DATE=0000` —
// a blank date that looks like the fix never ran. Accept the separators people
// actually type and hand ffmpeg the ISO form; reject the rest at the door
// rather than writing a value we know will be discarded.
const DATE_RE = /^(\d{4})(?:[-./](\d{1,2})(?:[-./](\d{1,2}))?)?$/;

export function normalizeDate(value) {
  const match = DATE_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  if (month != null && (Number(month) < 1 || Number(month) > 12)) {
    return null;
  }
  if (day != null && (Number(day) < 1 || Number(day) > 31)) {
    return null;
  }
  // Year-only and year-month are legitimate release dates, so a missing part
  // stays missing instead of being padded to a day nobody claimed.
  return [year, month?.padStart(2, '0'), day?.padStart(2, '0')].filter(Boolean).join('-');
}

// "1/8" or "1" -> { num: 1, total: 8|null }
export function parseNumberPair(value) {
  if (value == null) {
    return { num: null, total: null };
  }
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
  if (!match) {
    return { num: null, total: null };
  }
  return {
    num: Number.parseInt(match[1], 10),
    total: match[2] ? Number.parseInt(match[2], 10) : null
  };
}

export function leadingTrackNumber(fileName) {
  const match = basename(fileName).match(/^\s*(\d{1,3})\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}
