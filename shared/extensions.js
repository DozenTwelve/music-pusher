// Single source of truth for file classification, shared by the server and the
// client build. Keep this module dependency-free — it is imported from both
// Node and Vite bundles.
//
// AUDIO_EXTENSIONS defines what counts as "audio" everywhere: upload
// classification, album scanning, and every mixed-format check. An album whose
// audio files span more than one of these extensions is flagged — mixed formats
// cause Navidrome to split the album. Lyrics (.lrc), artwork, and other
// sidecars are deliberately NOT in this set so they never count toward a mix.
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.alac']);

export const ART_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Cover images are transcoded to JPEG on embed, so we can accept any format
// ffmpeg can decode — a broader set than the art files bundled with an album.
export const COVER_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'
]);

export const SIDECAR_EXTENSIONS = new Set(['.cue', '.log', '.txt', '.lrc']);

// Distinct audio extensions (without the dot) among a list of file paths.
// Non-audio files (lyrics, art, sidecars) never count. >1 result means the
// album mixes formats and should be flagged.
export function distinctAudioFormats(paths) {
  const formats = new Set();
  for (const p of paths) {
    const name = String(p);
    const dot = name.lastIndexOf('.');
    if (dot < 0) {
      continue;
    }
    const extension = name.slice(dot).toLowerCase();
    if (AUDIO_EXTENSIONS.has(extension)) {
      formats.add(extension.slice(1));
    }
  }
  return [...formats].sort();
}
