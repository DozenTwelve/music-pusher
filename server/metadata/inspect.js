import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ART_EXTENSIONS } from '../upload.js';
import { diagnoseAlbum } from '../../shared/inspect.js';
import { firstReleaseDate, normalizeReleaseDate } from '../../shared/identity.js';
import { listAudioFiles, probeTags } from './probe.js';

// Walk the album tree and collect loose image files (cover.jpg, folder.png, ...).
// These are reported for context but do not count as "has art" — detection is
// embedded-only, so a folder image sitting next to art-less tracks is still a gap.
async function listFolderImages(albumPath) {
  const found = [];
  const stack = [albumPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && ART_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.relative(albumPath, fullPath));
      }
    }
  }

  found.sort((a, b) => a.localeCompare(b));
  return found;
}

// A tag's values as a list. ffprobe hands every tag over as one string, and what
// it does with a tag that has several values depends on where the tag lives:
// repeated Vorbis comments (FLAC, Ogg, Opus) and repeated values of a standard
// MP4 atom come joined with ";", while an ID3 frame or an MP4 freeform atom
// yields its first value and silently drops the rest. Cutting at the ";" makes
// the same tag read as the same list in every container — and the album
// identity only ever looks at the first value, or at all of ALBUMARTIST.
// ponytail: a ";" ffprobe put between two values and a ";" that is part of one
// value look the same from here. A ";" followed by a space is taken to be
// typed ("Nujabes; Shing02" in one ARTISTS comment stays one value, which is
// how Navidrome reads it); a bare one is taken to be a join, so a literal
// "A;B" is misread as two values, and a second value that begins with a space
// as none. The dropped values of an ID3 frame are simply not there. The upgrade
// is a reader that returns real lists — TagLib, as web/src/tags.js does.
function valueList(joined) {
  return joined ? joined.split(/;(?! )/) : [];
}

// The identity fields of the track record (shared/identity.js), from the keys
// ffprobe reports — lowercased by probeTags. Per container:
//   FLAC  every Vorbis comment under its own name, so DATE, RELEASEDATE and
//         YEAR stay three tags.
//   MP3   TXXX frames under their description ("MusicBrainz Album Id",
//         RELEASEDATE, YEAR, ALBUMVERSION, ARTISTS, ALBUMARTISTS); TCMP as
//         `compilation`. TDRC and TDRL both arrive as `date`, one hiding the
//         other when both are set, so an ID3 release date cannot be told from
//         a recording date: `date` is read as the recording date, which is
//         what ffmpeg and most taggers write, and a TDRL is not seen.
//   MP4   freeform atoms under their name, as MP3's TXXX; cpil as
//         `compilation`; ©day as `date`, which there is the release date too.
function identityFields(tags) {
  const mp4 = (tags.__format_name || '').split(',').includes('mp4');
  return {
    artist_values: valueList(tags.artist),
    artists_values: valueList(tags.artists),
    album_artist_values: valueList(tags.album_artist || tags.albumartist),
    album_artists_values: valueList(tags.albumartists),
    compilation: tags.compilation || '',
    musicbrainz_albumid: tags.musicbrainz_albumid || tags['musicbrainz album id'] || '',
    album_version:
      tags.albumversion || tags.musicbrainz_albumcomment || tags['musicbrainz album comment'] || '',
    release_date: firstReleaseDate([tags.releasedate, mp4 ? tags.date : '', tags.year]),
    // Rewriting ©day moves the release date unless a RELEASEDATE outranks it.
    release_date_follows_date: mp4 && !normalizeReleaseDate(tags.releasedate || '')
  };
}

// How many ffprobe processes may run at once while scanning an album.
const PROBE_CONCURRENCY = 8;

export async function inspectAlbum(album) {
  const albumPath = path.join(config.rawDir, album);
  const files = await listAudioFiles(albumPath);

  if (files.length === 0) {
    return { ok: false, code: 'no_audio_files', message: 'No audio files found in album folder.' };
  }

  async function readTrack(absPath) {
    const tags = await probeTags(absPath);
    return {
      file: path.relative(albumPath, absPath),
      readable: Boolean(tags.__ok),
      formatName: tags.__format_name || '',
      sampleRate: tags.__sample_rate ?? null,
      bitDepth: tags.__bit_depth ?? null,
      hasArt: Boolean(tags.__has_art),
      duration: tags.__duration ?? null,
      title: tags.title || '',
      artist: tags.artist || '',
      artists: tags.artists || '',
      album: tags.album || '',
      album_artist: tags.album_artist || tags.albumartist || '',
      date: tags.date || tags.year || '',
      disc: tags.disc || tags.disk || tags.discnumber || '',
      track: tags.track || tags.tracknumber || '',
      ...identityFields(tags)
    };
  }

  // One ffprobe process per track, and /import runs a whole inspect before it
  // starts, so serializing this put a visible stall in front of every import.
  // Batched rather than one flat Promise.all: a 100-track box set would
  // otherwise fork 100 processes at once on a small box.
  const tracks = [];
  for (let i = 0; i < files.length; i += PROBE_CONCURRENCY) {
    tracks.push(...(await Promise.all(files.slice(i, i + PROBE_CONCURRENCY).map(readTrack))));
  }

  return diagnoseAlbum(album, tracks, await listFolderImages(albumPath));
}
