import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';

const cwd = process.cwd();

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function expandHome(inputPath) {
  if (typeof inputPath !== 'string') {
    return inputPath;
  }

  if (inputPath === '~') {
    return os.homedir();
  }

  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export const config = {
  port: parseInteger(process.env.PORT, 3000),
  rawDir: expandHome(process.env.RAW_DIR) || path.join(cwd, 'data', 'RAW'),
  libraryDir: expandHome(process.env.LIBRARY_DIR) || path.join(cwd, 'data', 'LIBRARY'),
  maxFileSizeBytes: parseInteger(process.env.MAX_FILE_SIZE_MB, 2048) * 1024 * 1024,
  maxFiles: parseInteger(process.env.MAX_FILES, 2000),
  exiftoolBin: expandHome(process.env.EXIFTOOL_BIN) || 'exiftool',
  ffmpegBin: expandHome(process.env.FFMPEG_BIN) || 'ffmpeg',
  ffprobeBin: expandHome(process.env.FFPROBE_BIN) || 'ffprobe',
  beetBin: expandHome(process.env.BEET_BIN) || 'beet',
  cleanupRawAfterImport: parseBoolean(process.env.CLEANUP_RAW_AFTER_IMPORT, true)
};
