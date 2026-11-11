// The album pipeline: read, diagnose, plan, clean, check again. It works on
// entries — { path, size, mtime, read() } — so a dropped folder, a zip and a
// test fixture all go through the same code, one file in memory at a time. No
// DOM here; the page (app.jsx) and the Node tests both drive it.

import { AUDIO_EXTENSIONS, ART_EXTENSIONS } from '../../shared/extensions.js';
import { diagnoseAlbum } from '../../shared/inspect.js';
import { basename, extname } from '../../shared/paths.js';
import { albumIdentity } from '../../shared/identity.js';
import { planAlbum, planWrites } from '../../shared/plan.js';
import { readTrack, readPicture, writeTrack } from './tags.js';
import { openZip, zipWriter } from './zip.js';

// The containers the tag code is proven on (spike.test.js).
const SUPPORTED = new Set(['.flac', '.mp3', '.m4a']);
const extension = (path) => extname(path).toLowerCase();
const isTrack = (entry) => SUPPORTED.has(extension(entry.path));

// Ceilings, from measurement (measure.js, and the browser runs in the report).
// Rewriting a track peaks at about five times its size — the bytes read, three
// times that inside TagLib's heap, and the bytes written — and that heap never
// shrinks, so the largest track sets the page's memory for the rest of the
// visit. The album as a whole is bounded by the zip format without zip64.
export const LIMITS = { track: 300e6, album: 2e9 };

// What a Mac leaves behind in folders and archives; never part of the album.
const isJunk = (path) => path.startsWith('__MACOSX/') || /^(\._.*|\.DS_Store)$/.test(basename(path));

// The album as one folder: junk dropped, paths sorted, and everything under a
// single top folder — the one the files came in, or `fallback` (the archive's
// name) when they came loose. `guess` is that name when it is a real one: the
// best guess at the album name for tracks that carry none.
export function asAlbum(entries, fallback) {
  const kept = entries.filter((entry) => !isJunk(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
  const tops = new Set(kept.map((entry) => (entry.path.includes('/') ? entry.path.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) {
    return { name: [...tops][0], guess: [...tops][0], entries: kept };
  }
  const name = fallback || 'Album';
  return { name, guess: fallback || '', entries: kept.map((entry) => ({ ...entry, path: `${name}/${entry.path}` })) };
}

// Why this album cannot be taken on, as { code, … }, or null when it can.
export function refusal(entries) {
  const tracks = entries.filter(isTrack);
  if (tracks.length === 0) {
    return { code: 'no_audio' };
  }
  const largest = tracks.reduce((a, b) => (b.size > a.size ? b : a));
  if (largest.size > LIMITS.track) {
    return { code: 'track_too_big', name: basename(largest.path), size: largest.size, limit: LIMITS.track };
  }
  const size = entries.reduce((sum, entry) => sum + entry.size, 0);
  return size > LIMITS.album ? { code: 'album_too_big', size, limit: LIMITS.album } : null;
}

// `progress(done, total, path)` is called before each file, in bytes.
function stepper(entries, progress) {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  let done = 0;
  return (entry) => {
    progress?.(done, total, entry.path);
    done += entry.size;
  };
}

// -> { tracks, images, unsupported }: a record per track (tags.js `readTrack`),
// the loose images, and the audio files in a container this page does not read.
export async function readAlbum(taglib, entries, progress) {
  const audio = entries.filter(isTrack);
  const step = stepper(audio, progress);
  const tracks = [];
  for (const entry of audio) {
    step(entry);
    tracks.push(await readTrack(taglib, entry.path, await entry.read()));
  }
  return {
    tracks,
    images: entries.map((entry) => entry.path).filter((path) => ART_EXTENSIONS.has(extension(path))),
    unsupported: entries.map((entry) => entry.path).filter((path) => AUDIO_EXTENSIONS.has(extension(path)) && !SUPPORTED.has(extension(path)))
  };
}

// The diagnosis and the proposal (shared/plan.js `planAlbum`) in one.
export function inspect(name, album, entries, context = {}) {
  const report = diagnoseAlbum(name, album.tracks, album.images);
  const whole = { paths: entries.map((entry) => entry.path), ...context };
  return { report, context: whole, ...planAlbum(report, album.tracks, whole) };
}

// The albums Navidrome would make of these tracks, largest first: what each is
// called, by whom, and how many tracks it gets. `album` and `artist` are null
// where Navidrome would show its "[Unknown …]".
export function shelf(tracks) {
  const albums = new Map();
  for (const track of tracks.filter((candidate) => candidate.readable)) {
    const identity = albumIdentity(track);
    if (!albums.has(identity.key)) {
      albums.set(identity.key, {
        album: identity.unknownAlbum ? null : track.album,
        artist: identity.unknownArtist ? null : identity.albumArtist,
        tracks: 0
      });
    }
    albums.get(identity.key).tracks += 1;
  }
  return [...albums.values()].sort((a, b) => b.tracks - a.tracks);
}

// The bytes of the cover `chooseCover` settled on: { mimeType, data } or null.
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
export async function loadCover(taglib, entries, cover) {
  const entry = entries.find((candidate) => candidate.path === (cover?.path || cover?.file));
  if (!entry) {
    return null;
  }
  const bytes = await entry.read();
  return cover.kind === 'embedded'
    ? readPicture(taglib, entry.path, bytes)
    : { mimeType: MIME[extension(entry.path)] || 'image/jpeg', data: bytes };
}

// Applies the plan and zips the album: every entry in its place, the tracks the
// plan names rewritten (and renamed), everything else byte for byte.
//   fixes   the proposal as the user left it
//   cover   the album's cover as JPEG bytes, when the plan may need it
// -> { blob, changed, failed }: the zip, how many tracks were rewritten, and
// the tracks that could not be and went in as they came.
export async function cleanAlbum(taglib, entries, inspected, fixes, cover, progress) {
  const { files, addCover } = planWrites(inspected.report, inspected.report.tracks, fixes, inspected.context);
  const todo = new Map(files.map((entry) => [entry.file, entry]));
  const step = stepper(entries, progress);
  const zip = zipWriter();
  const failed = [];
  let changed = 0;
  for (const entry of entries) {
    step(entry);
    let bytes = await entry.read();
    const { set = {}, cover: embed = false, rename = null } = todo.get(entry.path) || {};
    const picture = embed && cover ? cover : undefined;
    if (Object.keys(set).length > 0 || picture) {
      try {
        bytes = await writeTrack(taglib, entry.path, bytes, { set, cover: picture });
        changed += 1;
      } catch {
        failed.push(entry.path);
      }
    }
    zip.add(rename || entry.path, bytes, entry.mtime);
  }
  if (addCover && cover) {
    zip.add(addCover, cover);
  }
  return { blob: zip.finish(), changed, failed };
}

// The proof: the finished zip, opened and read as if it had just been dropped.
export async function recheck(taglib, blob, name, progress) {
  const { entries } = await openZip(blob);
  const album = await readAlbum(taglib, entries, progress);
  return { album, ...inspect(name, album, entries) };
}
