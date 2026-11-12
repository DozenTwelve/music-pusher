// Read and rewrite audio tags in memory with TagLib (WebAssembly). No Node
// built-ins here: the same module runs in the browser and under `node --test`.
// The caller supplies the wasm bytes, so loading them (fetch in a page, fs in a
// test) is the only environment-specific step.

import { TagLib, PROPERTIES } from 'taglib-wasm';
import { firstReleaseDate, normalizeReleaseDate } from '../../shared/identity.js';

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
  hasFrontCover: false,
  duration: null,
  title: '',
  artist: '',
  artists: '',
  album: '',
  album_artist: '',
  date: '',
  disc: '',
  track: '',
  artist_values: [],
  artists_values: [],
  album_artist_values: [],
  album_artists_values: [],
  compilation: '',
  musicbrainz_albumid: '',
  album_version: '',
  release_date: '',
  release_date_follows_date: false,
  properties: {}
};

// taglib-wasm renames the properties it knows to camelCase ("albumArtist",
// "musicbrainzReleaseId") and passes the rest through as stored. Map the known
// ones back to TagLib's own names (ALBUMARTIST, MUSICBRAINZ_ALBUMID), which for
// a Vorbis comment is the literal field name in the file.
const tagLibName = (key) => (Object.hasOwn(PROPERTIES, key) ? PROPERTIES[key].key : key);

// The album's cover among a track's pictures: one typed as the front cover, or
// an untyped one ("Other"), which is how ffmpeg embeds a picture. A back cover,
// a booklet page or an artist photo is a picture but not the cover. (An MP4
// cannot type its pictures; TagLib reads them all as front covers.)
const isFrontCover = (picture) => picture.type === 'FrontCover' || picture.type === 'Other';

// ID3v1 is the last 128 bytes, starting "TAG".
const hasId3v1 = (bytes) => bytes.length >= 128 && bytes[bytes.length - 128] === 0x54 && bytes[bytes.length - 127] === 0x41 && bytes[bytes.length - 126] === 0x47;

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
    // Every value of the first of these names the file has, then of the next.
    const all = (...names) => names.flatMap((name) => properties[name] || []);
    // TDRL is how the frame reads in an ID3v2.3 tag, which has no such frame
    // and so no normalized name for it.
    const releaseTags = all('TDRL', 'RELEASEDATE');
    const mp4 = handle.getFormat() === 'MP4';
    return {
      file,
      readable: true,
      formatName: handle.getFormat(),
      sampleRate: props.sampleRate,
      // TagLib reports a nominal 16 for AAC; ffprobe reports nothing for a
      // lossy codec, and "bit depth" means nothing there, so follow ffprobe.
      bitDepth: (props.isLossless && props.bitsPerSample) || null,
      hasArt: handle.getPictures().length > 0,
      hasFrontCover: handle.getPictures().some(isFrontCover),
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
      // The album identity fields (shared/identity.js), as real lists.
      artist_values: all('ARTIST'),
      artists_values: all('ARTISTS'),
      album_artist_values: all('ALBUMARTIST'),
      album_artists_values: all('ALBUMARTISTS'),
      // TCMP: ffmpeg writes the flag to an ID3v2.4 tag as TXXX:TCMP.
      compilation: all('COMPILATION', 'TCMP')[0] || '',
      musicbrainz_albumid: all('MUSICBRAINZ_ALBUMID')[0] || '',
      album_version: all('ALBUMVERSION', 'MUSICBRAINZ_ALBUMCOMMENT', 'MUSICBRAINZ ALBUM COMMENT')[0] || '',
      // In an MP4, DATE is the ©day atom, which Navidrome reads as the release
      // date; everywhere else DATE is the recording date and stays out of it.
      release_date: firstReleaseDate([...releaseTags, ...(mp4 ? all('DATE') : []), ...all('YEAR')]),
      // Rewriting ©day moves the release date unless a RELEASEDATE outranks it.
      release_date_follows_date: mp4 && !releaseTags.some(normalizeReleaseDate),
      properties
    };
  } finally {
    handle.dispose();
  }
}

// The picture embedded in a track — the front cover when it has several — as
// { mimeType, data }, or null.
export async function readPicture(taglib, file, bytes) {
  const handle = await taglib.open({ name: file, data: bytes });
  try {
    const pictures = handle.getPictures();
    const picture = pictures.find((candidate) => candidate.type === 'FrontCover') || pictures.find(isFrontCover) || pictures[0];
    // A copy: the picture must outlive the handle.
    return picture ? { mimeType: picture.mimeType, data: picture.data.slice() } : null;
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
//   cover: JPEG bytes; the front cover, put first, in place of the one the file
//          has (isFrontCover); every other picture is kept.
// An MP3 is saved without an ID3v1 tag unless it came with one.
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
    const mp3 = handle.getFormat() === 'MP3';
    // ffmpeg writes an MP3 comment as TXXX:comment, which TagLib reads as
    // COMMENT — and writes back as a COMM frame next to it, so every save would
    // leave the comment in the file twice. When the comment is not what is
    // being written and no COMM frame exists yet, the property is kept out of
    // the typed save (which drops the TXXX frame) and the frame is put back,
    // byte for byte, by the raw pass.
    const commentKey = Object.keys(properties).find((name) => name.toUpperCase() === 'COMMENT');
    const strayComments =
      mp3 && commentKey && !('COMMENT' in upperSet(set)) && handle.getId3v2Frames('COMM').length === 0
        ? handle.getId3v2Frames('TXXX').map(({ data }) => data.slice()).filter((data) => txxxDescription(data).toUpperCase() === 'COMMENT')
        : [];
    if (strayComments.length > 0) {
      delete properties[commentKey];
    }

    handle.setProperties(properties);
    if (cover) {
      const others = handle.getPictures().filter((picture) => !isFrontCover(picture));
      handle.setPictures([{ mimeType: 'image/jpeg', data: cover, type: 'FrontCover', description: '' }, ...others]);
    }
    if (!handle.save()) {
      throw new Error(`TagLib could not save ${file}`);
    }
    const saved = handle.getFileBuffer();
    const picardCase = mp3 && PICARD_TXXX.some(([name]) => properties[name]);
    const output = picardCase || strayComments.length > 0 ? await patchId3Frames(taglib, file, saved, picardCase, strayComments) : saved;
    // TagLib copies the ID3v2 tag into an ID3v1 one on every save, and the
    // binding offers no way to say otherwise. ID3v1 holds Latin-1 only, so CJK
    // would land there as "?": a tag the file did not have is cut off again.
    return mp3 && !hasId3v1(bytes) && hasId3v1(output) ? output.subarray(0, output.length - 128) : output;
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

const upperSet = (set) => Object.fromEntries(Object.keys(set).map((name) => [name.toUpperCase(), true]));

// A TXXX frame body is one encoding byte, the description, a terminator, the value.
const ID3_ENCODINGS = ['latin1', 'utf-16', 'utf-16be', 'utf-8'];
const txxxDescription = (data) => new TextDecoder(ID3_ENCODINGS[data[0]] || 'latin1').decode(data.subarray(1)).split('\0')[0];

// The raw-frame pass over a saved MP3: Picard's spelling for the TXXX frames
// that need it, and the TXXX frames in `added` appended as they are.
async function patchId3Frames(taglib, file, bytes, picardCase, added) {
  const handle = await taglib.open({ name: file, data: bytes });
  try {
    let changed = added.length > 0;
    // Frame body: one encoding byte, the description, NUL, the value.
    // ponytail: Latin-1 / UTF-8 bodies only, which is all TagLib writes for an
    // ASCII description; a UTF-16 body is left as it is.
    const bodies = handle.getId3v2Frames('TXXX').map(({ data }) => {
      for (const [, description] of picardCase ? PICARD_TXXX : []) {
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
    handle.setId3v2Frames('TXXX', [...bodies, ...added]);
    if (!handle.save()) {
      throw new Error(`TagLib could not save ${file}`);
    }
    return handle.getFileBuffer();
  } finally {
    handle.dispose();
  }
}
