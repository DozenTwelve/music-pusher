import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from './config.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.alac']);
export const ART_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
// Cover images are transcoded to JPEG on embed, so we can accept any format
// ffmpeg can decode — a broader set than the art files bundled with an album.
export const COVER_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'
]);
const SIDECAR_EXTENSIONS = new Set(['.cue', '.log', '.txt', '.lrc']);
const SKIP_FILENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

// Busboy decodes multipart filenames as latin1 unless configured otherwise,
// but browsers send them as raw UTF-8 bytes — so any non-ASCII name arrives
// mojibake and gets written to disk double-encoded. Re-decode. A string with
// any char above U+00FF was already decoded correctly; a re-decode that yields
// U+FFFD means the bytes weren't UTF-8 after all — keep the original either way.
export function decodeLatin1Filename(name) {
  if (typeof name !== 'string' || !/[\u0080-\u00ff]/.test(name) || /[\u0100-\uffff]/.test(name)) {
    return name;
  }
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

export function normalizeRelativePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }

  if (inputPath.includes('\0')) {
    return { ok: false, reason: 'invalid_path' };
  }

  const normalized = inputPath.replace(/\\+/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  // NFC + trim must match what sanitizeAlbumName does to lookups, or a name
  // that only differs by trailing whitespace uploads fine and then 404s on
  // inspect. A segment that trims to nothing is a whitespace-only name —
  // rejecting beats silently merging two path levels.
  const segments = normalized
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.normalize('NFC').trim());

  if (segments.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, reason: 'invalid_path' };
    }
  }

  return { ok: true, relativePath: segments.join('/') };
}

export function classifyFile(relativePath) {
  const lowerBase = path.posix.basename(relativePath).toLowerCase();

  if (lowerBase.startsWith('._')) {
    return { accept: false, reason: 'system_file' };
  }

  if (SKIP_FILENAMES.has(lowerBase)) {
    return { accept: false, reason: 'system_file' };
  }

  const extension = path.posix.extname(lowerBase);

  if (AUDIO_EXTENSIONS.has(extension) || ART_EXTENSIONS.has(extension) || SIDECAR_EXTENSIONS.has(extension)) {
    return { accept: true, type: extension };
  }

  return { accept: false, reason: 'unsupported_extension' };
}

function ensureReport(req) {
  if (!req.uploadReport) {
    req.uploadReport = {
      skipped: []
    };
  }

  return req.uploadReport;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const safeRelativePath = file.safeRelativePath;

    if (!safeRelativePath) {
      cb(new Error('Missing safe path for upload file.'));
      return;
    }

    const safeDirectory = path.dirname(safeRelativePath);
    const absoluteTargetDir = path.resolve(config.rawDir, safeDirectory);
    const resolvedRawDir = path.resolve(config.rawDir);

    if (
      absoluteTargetDir !== resolvedRawDir &&
      !absoluteTargetDir.startsWith(resolvedRawDir + path.sep)
    ) {
      cb(new Error('Invalid file destination path.'));
      return;
    }

    fs.mkdir(absoluteTargetDir, { recursive: true }, (error) => {
      cb(error, absoluteTargetDir);
    });
  },
  filename(req, file, cb) {
    cb(null, path.basename(file.safeRelativePath));
  }
});

export const uploadMiddleware = multer({
  storage,
  preservePath: true,
  limits: {
    fileSize: config.maxFileSizeBytes,
    files: config.maxFiles
  },
  fileFilter(req, file, cb) {
    const report = ensureReport(req);
    file.originalname = decodeLatin1Filename(file.originalname);
    const normalized = normalizeRelativePath(file.originalname || file.fieldname);

    if (!normalized.ok) {
      report.skipped.push({
        path: file.originalname || file.fieldname,
        reason: normalized.reason
      });
      cb(null, false);
      return;
    }

    const classification = classifyFile(normalized.relativePath);
    if (!classification.accept) {
      report.skipped.push({
        path: normalized.relativePath,
        reason: classification.reason
      });
      cb(null, false);
      return;
    }

    file.safeRelativePath = normalized.relativePath;
    cb(null, true);
  }
});

// Archives are uploaded as one .zip file to a scratch location outside the RAW
// directory (so a half-written temp file never registers as an album), then
// extracted by server/archive.js.
const archiveStorage = multer.diskStorage({
  destination(req, file, cb) {
    const tmpDir = path.join(os.tmpdir(), 'music-pusher-uploads');
    fs.mkdir(tmpDir, { recursive: true }, (error) => cb(error, tmpDir));
  },
  filename(req, file, cb) {
    cb(null, `${crypto.randomUUID()}.zip`);
  }
});

export const archiveUploadMiddleware = multer({
  storage: archiveStorage,
  limits: {
    fileSize: config.maxArchiveSizeBytes,
    files: 1
  },
  fileFilter(req, file, cb) {
    // The archive's basename can become the album folder name (planLayout), so
    // it needs the same mojibake repair as individual upload filenames.
    file.originalname = decodeLatin1Filename(file.originalname);
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (extension !== '.zip') {
      req.archiveRejected = 'unsupported_archive';
      cb(null, false);
      return;
    }
    cb(null, true);
  }
});

function countBytes(files) {
  return files.reduce((sum, file) => sum + (file.size || 0), 0);
}

export async function listAlbums() {
  await fsp.mkdir(config.rawDir, { recursive: true });
  const entries = await fsp.readdir(config.rawDir, { withFileTypes: true });
  const albums = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    // Self-heal albums staged before names were normalized: a folder whose
    // on-disk name is mojibake (latin1-decoded UTF-8) or differs by NFC/trim
    // can never match a sanitized lookup, so inspect/delete would 404 forever.
    // RAW is app-owned, so renaming to the normalized form is safe; if the
    // rename fails (e.g. the normalized name is taken), keep the old name.
    let name = entry.name;
    const healed = sanitizeAlbumName(decodeLatin1Filename(name));
    if (healed && healed !== name) {
      try {
        await fsp.rename(path.join(config.rawDir, name), path.join(config.rawDir, healed));
        name = healed;
      } catch {
        // keep the original name; the album stays listed
      }
    }

    const albumPath = path.join(config.rawDir, name);
    const stats = await gatherAlbumStats(albumPath);
    if (stats.fileCount === 0) {
      continue;
    }

    albums.push({
      album: name,
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes
    });
  }

  albums.sort((a, b) => a.album.localeCompare(b.album));
  return albums;
}

async function gatherAlbumStats(albumPath) {
  const stack = [albumPath];
  let fileCount = 0;
  let totalBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stat = await fsp.stat(fullPath);
      fileCount += 1;
      totalBytes += stat.size;
    }
  }

  return { fileCount, totalBytes };
}

export function buildUploadSummary(req) {
  const acceptedFiles = Array.isArray(req.files) ? req.files : [];
  const acceptedPaths = acceptedFiles
    .map((file) => file.safeRelativePath)
    .filter(Boolean);
  const skipped = req.uploadReport?.skipped || [];
  const albums = Array.from(new Set(acceptedPaths.map((p) => p.split('/')[0]).filter(Boolean)));

  return {
    album: albums.length === 1 ? albums[0] : null,
    albums,
    acceptedCount: acceptedFiles.length,
    skippedCount: skipped.length,
    totalBytes: countBytes(acceptedFiles),
    skipped
  };
}

export function sanitizeAlbumName(input) {
  if (typeof input !== 'string') {
    return null;
  }

  // NFC to match what normalizeRelativePath did when the album was written —
  // a macOS browser can send the same name decomposed (NFD) in a later request.
  const trimmed = input.normalize('NFC').trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') || trimmed === '.' || trimmed === '..') {
    return null;
  }

  return trimmed;
}
