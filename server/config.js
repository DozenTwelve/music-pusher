import 'dotenv/config';
import path from 'node:path';

const cwd = process.cwd();

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: parseInteger(process.env.PORT, 3000),
  rawDir: process.env.RAW_DIR || path.join(cwd, 'data', 'RAW'),
  libraryDir: process.env.LIBRARY_DIR || path.join(cwd, 'data', 'LIBRARY'),
  maxFileSizeBytes: parseInteger(process.env.MAX_FILE_SIZE_MB, 2048) * 1024 * 1024,
  maxFiles: parseInteger(process.env.MAX_FILES, 2000)
};
