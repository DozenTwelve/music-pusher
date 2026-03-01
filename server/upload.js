import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { config } from './config.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.alac']);
const ART_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SIDECAR_EXTENSIONS = new Set(['.cue', '.log', '.txt']);
const SKIP_FILENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function normalizeRelativePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }

  if (inputPath.includes('\0')) {
    return { ok: false, reason: 'invalid_path' };
  }

  const normalized = inputPath.replace(/\\+/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: 'invalid_path' };
    }
  }

  return { ok: true, relativePath: segments.join('/') };
}

function classifyFile(relativePath) {
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

    if (!absoluteTargetDir.startsWith(resolvedRawDir)) {
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
  limits: {
    fileSize: config.maxFileSizeBytes,
    files: config.maxFiles
  },
  fileFilter(req, file, cb) {
    const report = ensureReport(req);
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

    const albumPath = path.join(config.rawDir, entry.name);
    const stats = await gatherAlbumStats(albumPath);
    albums.push({
      album: entry.name,
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

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') || trimmed === '.' || trimmed === '..') {
    return null;
  }

  return trimmed;
}
