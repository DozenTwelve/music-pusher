import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ART_EXTENSIONS } from '../upload.js';
import { diagnoseAlbum } from '../../shared/inspect.js';
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
      track: tags.track || tags.tracknumber || ''
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
