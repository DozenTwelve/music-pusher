import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { listAudioFiles, runProcess, TEMP_PREFIX } from './probe.js';
import { inspectAlbum } from './inspect.js';

const MP4_EXTENSIONS = new Set(['.m4a', '.aac', '.alac', '.mp4', '.m4b']);

// Embed the cover into one track: map the audio streams from the file and the
// picture from the cover, flag it attached_pic, write to a temp file, then rename
// over the original — the same temp-then-rename pattern as the tag rewrites.
//
// The picture is transcoded to JPEG rather than copied: MP4's cover atom only
// accepts jpeg/png, so a copied webp/gif/bmp would fail there. Normalizing to
// mjpeg lets any uploaded image format embed cleanly across MP3/FLAC/MP4.
async function embedInFile(absPath, coverPath) {
  const ext = path.extname(absPath).toLowerCase();
  const dir = path.dirname(absPath);
  const tmpPath = path.join(dir, `${TEMP_PREFIX}${path.basename(absPath)}`);

  const args = [
    '-v', 'error',
    '-i', absPath,
    '-i', coverPath,
    '-map', '0:a',
    '-map', '1:v',
    '-c:a', 'copy',
    '-c:v', 'mjpeg',
    '-disposition:v:0', 'attached_pic',
    '-map_metadata', '0'
  ];
  if (ext === '.mp3') {
    args.push(
      '-id3v2_version', '3',
      '-metadata:s:v', 'title=Album cover',
      '-metadata:s:v', 'comment=Cover (front)'
    );
  }
  if (MP4_EXTENSIONS.has(ext)) {
    args.push('-movflags', '+faststart');
  }
  args.push(tmpPath);

  const result = await runProcess(config.ffmpegBin, args);
  if (result.code !== 0) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw new Error(result.stderr.trim() || `ffmpeg exited with code ${result.code}`);
  }
  await fsp.rename(tmpPath, absPath);
}

// Albums with an embed in progress. Concurrent embeds of the same album would
// race on the shared temp cover file, so reject overlapping requests.
const coversInFlight = new Set();

export async function embedCover(album, { buffer, ext }) {
  if (coversInFlight.has(album)) {
    return { ok: false, code: 'cover_busy', message: `A cover embed is already running for album '${album}'.` };
  }

  coversInFlight.add(album);
  try {
    return await runEmbed(album, { buffer, ext });
  } finally {
    coversInFlight.delete(album);
  }
}

async function runEmbed(album, { buffer, ext }) {
  const albumPath = path.join(config.rawDir, album);
  const files = await listAudioFiles(albumPath);

  if (files.length === 0) {
    return { ok: false, code: 'no_audio_files', message: 'No audio files found in album folder.' };
  }

  // Stage the uploaded image once. TEMP_PREFIX keeps listAudioFiles from ever
  // treating it (or a crashed leftover) as a track.
  const coverPath = path.join(albumPath, `${TEMP_PREFIX}cover${ext || '.jpg'}`);
  await fsp.writeFile(coverPath, buffer);

  const changes = [];
  const errors = [];
  try {
    for (const absPath of files) {
      const relPath = path.relative(albumPath, absPath);
      try {
        await embedInFile(absPath, coverPath);
        changes.push({ file: relPath });
      } catch (error) {
        errors.push({ file: relPath, message: error.message });
      }
    }
  } finally {
    await fsp.rm(coverPath, { force: true }).catch(() => {});
  }

  // Re-run diagnosis so the UI can confirm every track now carries art.
  const after = await inspectAlbum(album);

  return {
    ok: errors.length === 0,
    album,
    embedded: changes.length,
    changes,
    errors,
    after: after.ok ? after : null
  };
}
