import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { config } from './config.js';
import { classifyFile, normalizeRelativePath, sanitizeAlbumName } from './upload.js';
import { distinctAudioFormats } from '../shared/extensions.js';

// Music archives are almost always a single album. We extract a .zip into the
// RAW staging directory reusing the exact same file classification, path
// safety, and limits as a folder upload, then report the same summary shape.

class ArchiveError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) {
      Object.assign(this, details);
    }
  }
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (error, zipfile) => {
        if (error) {
          reject(new ArchiveError('invalid_archive', 'Could not read the archive — is it a valid .zip?'));
          return;
        }
        resolve(zipfile);
      }
    );
  });
}

function isDirectoryEntry(entry) {
  return /\/$/.test(entry.fileName);
}

// First pass: walk the central directory (no extraction) to classify every
// entry and enforce limits. Returns accepted entries plus the skip report.
function scanEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const accepted = [];
    const skipped = [];

    zipfile.on('entry', (entry) => {
      if (isDirectoryEntry(entry)) {
        zipfile.readEntry();
        return;
      }

      const normalized = normalizeRelativePath(entry.fileName);
      if (!normalized.ok) {
        skipped.push({ path: entry.fileName, reason: normalized.reason });
        zipfile.readEntry();
        return;
      }

      const classification = classifyFile(normalized.relativePath);
      if (!classification.accept) {
        skipped.push({ path: normalized.relativePath, reason: classification.reason });
        zipfile.readEntry();
        return;
      }

      if (entry.uncompressedSize > config.maxFileSizeBytes) {
        reject(new ArchiveError('file_too_large', `Archive entry '${normalized.relativePath}' exceeds the per-file size limit.`));
        return;
      }

      accepted.push({
        rawName: entry.fileName,
        relativePath: normalized.relativePath,
        size: entry.uncompressedSize
      });

      if (accepted.length > config.maxFiles) {
        reject(new ArchiveError('too_many_files', 'Archive contains more files than the allowed limit.'));
        return;
      }

      zipfile.readEntry();
    });

    zipfile.on('end', () => resolve({ accepted, skipped }));
    zipfile.on('error', (error) => reject(error));

    zipfile.readEntry();
  });
}

// Decide the album folder and the destination path for each accepted entry.
// If the archive is a single wrapper folder, that folder becomes the album;
// otherwise (loose files or multiple top-level folders) the archive filename
// does, with the internal structure preserved beneath it.
function planLayout(accepted, originalName) {
  const archiveBase = sanitizeAlbumName(path.parse(originalName || '').name);
  const topSegments = new Set(accepted.map((item) => item.relativePath.split('/')[0]));
  const singleWrapper =
    topSegments.size === 1 &&
    accepted.every((item) => item.relativePath.includes('/'));

  let album;
  let rewriteFirstSegment;
  if (singleWrapper) {
    album = sanitizeAlbumName([...topSegments][0]) || archiveBase;
    rewriteFirstSegment = true;
  } else {
    album = archiveBase;
    rewriteFirstSegment = false;
  }

  if (!album) {
    throw new ArchiveError('invalid_archive_name', 'Could not derive a valid album name from the archive.');
  }

  const destByRawName = new Map();
  for (const item of accepted) {
    const rest = rewriteFirstSegment
      ? item.relativePath.split('/').slice(1).join('/')
      : item.relativePath;
    destByRawName.set(item.rawName, `${album}/${rest}`);
  }

  return { album, destByRawName };
}

function resolveWithinRaw(destRelative) {
  const resolvedRawDir = path.resolve(config.rawDir);
  const absolute = path.resolve(resolvedRawDir, destRelative);
  if (absolute !== resolvedRawDir && !absolute.startsWith(resolvedRawDir + path.sep)) {
    throw new ArchiveError('invalid_path', 'Archive entry resolved outside the staging directory.');
  }
  return absolute;
}

// Second pass: stream each accepted entry to its destination on disk.
function extractEntries(zipfile, destByRawName) {
  return new Promise((resolve, reject) => {
    zipfile.on('entry', (entry) => {
      const destRelative = destByRawName.get(entry.fileName);
      if (!destRelative) {
        zipfile.readEntry();
        return;
      }

      let absolute;
      try {
        absolute = resolveWithinRaw(destRelative);
      } catch (error) {
        reject(error);
        return;
      }

      zipfile.openReadStream(entry, async (error, readStream) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          await fsp.mkdir(path.dirname(absolute), { recursive: true });
          await pipeline(readStream, fs.createWriteStream(absolute));
          zipfile.readEntry();
        } catch (writeError) {
          reject(writeError);
        }
      });
    });

    zipfile.on('end', () => resolve());
    zipfile.on('error', (error) => reject(error));

    zipfile.readEntry();
  });
}

export async function extractZipAlbum(zipPath, originalName, { allowMixed = false } = {}) {
  await fsp.mkdir(config.rawDir, { recursive: true });

  const scanZip = await openZip(zipPath);
  let scan;
  try {
    scan = await scanEntries(scanZip);
  } finally {
    scanZip.close();
  }

  if (scan.accepted.length === 0) {
    throw new ArchiveError('empty_archive', 'The archive contains no supported music, art, or sidecar files.');
  }

  // Scanning only reads the central directory (no extraction yet), so we can
  // reject a mixed-format archive before writing anything to disk.
  const formats = distinctAudioFormats(scan.accepted.map((item) => item.relativePath));
  if (!allowMixed && formats.length > 1) {
    throw new ArchiveError(
      'mixed_formats',
      `Archive mixes audio formats (${formats.join(', ')}). An album is usually a single format.`,
      { formats }
    );
  }

  const { album, destByRawName } = planLayout(scan.accepted, originalName);

  const extractZip = await openZip(zipPath);
  try {
    await extractEntries(extractZip, destByRawName);
  } finally {
    extractZip.close();
  }

  const totalBytes = scan.accepted.reduce((sum, item) => sum + item.size, 0);
  return {
    album,
    albums: [album],
    acceptedCount: scan.accepted.length,
    skippedCount: scan.skipped.length,
    totalBytes,
    skipped: scan.skipped
  };
}

export { ArchiveError };
