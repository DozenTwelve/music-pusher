// Ceilings, from measurement (measure.js, and the browser runs in the report).
// Rewriting a track peaks at about five times its size — the bytes read, three
// times that inside TagLib's heap, and the bytes written — and that heap never
// shrinks, so the largest track sets the page's memory for the rest of the
// visit. The album as a whole is bounded by the zip format without zip64.
// On their own so the static pages can quote them without loading the tag code.
export const LIMITS = { track: 300e6, album: 2e9 };
