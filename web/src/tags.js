// Read and rewrite audio tags in memory with TagLib (WebAssembly). No Node
// built-ins here: the same module runs in the browser and under `node --test`.
// The caller supplies the wasm bytes, so loading them (fetch in a page, fs in a
// test) is the only environment-specific step.

import { TagLib, PROPERTIES } from 'taglib-wasm';

// Supplying the binary selects TagLib's Emscripten backend in every runtime —
// the one a browser gets — so the Node test exercises the code path that ships.
export function initTagLib(wasmBinary) {
  return TagLib.initialize({ wasmBinary });
}

// ffprobe joins a repeated tag into one string with ";" and the shared rules
// were written against that, so a multi-valued tag is joined the same way.
const MULTI_VALUE_SEPARATOR = ';';

const UNREADABLE = {
  readable: false,
  formatName: '',
  sampleRate: null,
  bitDepth: null,
  hasArt: false,
  duration: null,
  title: '',
  artist: '',
  artists: '',
  album: '',
  album_artist: '',
  date: '',
  disc: '',
  track: '',
  properties: {}
};

// taglib-wasm renames the properties it knows to camelCase ("albumArtist",
// "musicbrainzReleaseId") and passes the rest through as stored. Map the known
// ones back to TagLib's own names (ALBUMARTIST, MUSICBRAINZ_ALBUMID), which for
// a Vorbis comment is the literal field name in the file.
const tagLibName = (key) => (Object.hasOwn(PROPERTIES, key) ? PROPERTIES[key].key : key);

// The track record shared/inspect.js `diagnoseAlbum` expects, built from bytes.
// Mirrors server/metadata/inspect.js + probe.js field for field, plus
// `properties`: every tag under its TagLib name, each an array of values.
//
// What a TagLib name means in the file, per container:
//   FLAC  the Vorbis comment of that name, so DATE, RELEASEDATE and YEAR are
//         three different entries and stay distinguishable.
//   MP3   a normalized name: DATE is TDRC (and a v2.3 TYER, which TagLib folds
//         into TDRC on load), RELEASEDATE is TDRL, COMPILATION is TCMP,
//         MUSICBRAINZ_ALBUMID is TXXX:MusicBrainz Album Id (any letter case),
//         and a name TagLib has no frame for is TXXX:<NAME>.
//   MP4   a normalized name: DATE is the ©day atom, COMPILATION is cpil,
//         MUSICBRAINZ_ALBUMID is ----:com.apple.iTunes:MusicBrainz Album Id,
//         and a name TagLib has no atom for is ----:com.apple.iTunes:<NAME>.
export async function readTrack(taglib, file, bytes) {
  let handle;
  try {
    handle = await taglib.open({ name: file, data: bytes });
  } catch {
    // Garbage or a truncated container: TagLib refuses it outright.
    return { file, ...UNREADABLE };
  }
  try {
    const props = handle.audioProperties();
    // Same test as the server: a file is readable when it has a sample rate.
    if (!handle.isValid() || !props?.sampleRate) {
      return { file, ...UNREADABLE };
    }
    const properties = {};
    for (const [key, values] of Object.entries(handle.properties())) {
      properties[tagLibName(key).toUpperCase()] = values || [];
    }
    const tag = (name) => (properties[name] || []).join(MULTI_VALUE_SEPARATOR);
    return {
      file,
      readable: true,
      formatName: handle.getFormat(),
      sampleRate: props.sampleRate,
      // TagLib reports a nominal 16 for AAC; ffprobe reports nothing for a
      // lossy codec, and "bit depth" means nothing there, so follow ffprobe.
      bitDepth: (props.isLossless && props.bitsPerSample) || null,
      hasArt: handle.getPictures().length > 0,
      // 0 for a FLAC whose STREAMINFO says total_samples=0.
      duration: props.durationMs ? props.durationMs / 1000 : null,
      title: tag('TITLE'),
      artist: tag('ARTIST'),
      artists: tag('ARTISTS'),
      album: tag('ALBUM'),
      album_artist: tag('ALBUMARTIST'),
      date: tag('DATE'),
      disc: tag('DISCNUMBER'),
      track: tag('TRACKNUMBER'),
      properties
    };
  } finally {
    handle.dispose();
  }
}

// Returns the rewritten file as new bytes; `bytes` is left untouched.
//   set:   { TAGLIB_NAME: value } — a string, an array of strings (written as
//          separate values, never joined), or null to remove the tag outright.
//          TagLib puts each name where the container's convention has it:
//          uppercase Vorbis comments, ID3v2 frames, MP4 atoms.
//          TRACKNUMBER / DISCNUMBER take "2/9" to carry the total.
//   cover: JPEG bytes; replaces every embedded picture with one front cover
export async function writeTrack(taglib, file, bytes, { set = {}, cover } = {}) {
  const handle = await taglib.open({ name: file, data: bytes });
  try {
    // setProperties replaces the whole set — a name left out is removed from
    // the file — so start from what is there.
    const properties = {};
    // Repeats of one value are dropped on the way: ffmpeg writes an MP3 comment
    // as TXXX:comment, TagLib reads that and a real COMM frame as one COMMENT
    // list, and writing the list back unchanged adds another copy every pass.
    for (const [key, values] of Object.entries(handle.properties())) {
      properties[tagLibName(key)] = [...new Set(values)];
    }
    for (const [name, value] of Object.entries(set)) {
      for (const existing of Object.keys(properties)) {
        if (existing.toUpperCase() === name.toUpperCase()) {
          delete properties[existing];
        }
      }
      if (value != null) {
        properties[name] = Array.isArray(value) ? value : [value];
      }
    }
    handle.setProperties(properties);
    if (cover) {
      handle.setPictures([{ mimeType: 'image/jpeg', data: cover, type: 'FrontCover', description: '' }]);
    }
    if (!handle.save()) {
      throw new Error(`TagLib could not save ${file}`);
    }
    const output = handle.getFileBuffer();
    const needsPicardCase = handle.getFormat() === 'MP3' && PICARD_TXXX.some(([name]) => properties[name]);
    return needsPicardCase ? picardCaseTxxx(taglib, file, output) : output;
  } finally {
    handle.dispose();
  }
}

// TagLib writes the TXXX frames it has a name for with an uppercase description
// ("MUSICBRAINZ ALBUM ID"). Picard writes "MusicBrainz Album Id", and readers
// built on mutagen (beets, Picard itself) match the description exactly, so
// they would not find TagLib's. Same letters, different case — so patch the
// description bytes in place through the raw-frame API. It needs a second open:
// raw and typed edits cannot be mixed in one save. A later typed pass leaves
// the patched frame alone as long as its value does not change.
const PICARD_TXXX = [['MUSICBRAINZ_ALBUMID', 'MusicBrainz Album Id']];

async function picardCaseTxxx(taglib, file, bytes) {
  const handle = await taglib.open({ name: file, data: bytes });
  try {
    let changed = false;
    // Frame body: one encoding byte, the description, NUL, the value.
    // ponytail: Latin-1 / UTF-8 bodies only, which is all TagLib writes for an
    // ASCII description; a UTF-16 body is left as it is.
    const bodies = handle.getId3v2Frames('TXXX').map(({ data }) => {
      for (const [, description] of PICARD_TXXX) {
        const end = 1 + description.length;
        const stored = String.fromCharCode(...data.subarray(1, end));
        if (data[end] === 0 && stored !== description && stored.toUpperCase() === description.toUpperCase()) {
          const patched = data.slice();
          patched.set(Uint8Array.from(description, (c) => c.charCodeAt(0)), 1);
          changed = true;
          return patched;
        }
      }
      return data;
    });
    if (!changed) {
      return bytes;
    }
    handle.setId3v2Frames('TXXX', bodies);
    if (!handle.save()) {
      throw new Error(`TagLib could not save ${file}`);
    }
    return handle.getFileBuffer();
  } finally {
    handle.dispose();
  }
}
