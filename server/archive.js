import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { config } from './config.js';
import { classifyFile, normalizeRelativePath, sanitizeAlbumName } from './upload.js';
import { withAlbumLock } from './metadata/lock.js';
import { TEMP_PREFIX } from './metadata/probe.js';
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

// yauzl does not check CRC-32 (see its README, "No CRC-32 Checking"), so a
// damaged stored entry, or one whose damage inflate does not notice, would
// otherwise extract "successfully" into a broken track.
function checkCrc(entry) {
  let crc = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      crc = zlib.crc32(chunk, crc);
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        crc === entry.crc32
          ? null
          : new ArchiveError('corrupt_archive', `Archive entry '${entry.fileName}' is damaged (checksum mismatch).`)
      );
    }
  });
}

// Second pass: stream each accepted entry to a temp file beside its
// destination. Nothing takes its real name until every entry has arrived intact
// (see extractZipAlbum), so a failure part-way leaves no partial album staged and
// overwrites nothing already in RAW. `written` records the temp files and the
// folders this extraction created, for commit or rollback.
function extractEntries(zipfile, destByRawName, written) {
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

      const fail = (error) =>
        reject(
          String(error.code).startsWith('Z_')
            ? new ArchiveError('corrupt_archive', `Archive entry '${entry.fileName}' is damaged (${error.message}).`)
            : error
        );

      const dir = path.dirname(absolute);
      // Numbered, since two entries can normalize to the same name.
      const temp = path.join(dir, `${TEMP_PREFIX}zip${written.files.length}-${path.basename(absolute)}`);
      written.files.push({ temp, absolute });

      // The folder is made before the entry is opened, not after. Once open,
      // yauzl starts inflating, and a damaged entry's error is emitted on the
      // stream a tick later; with an `await` between opening and pipeline it
      // arrived to no listener and crashed the whole server — taking any
      // running import's job with it.
      fsp.mkdir(dir, { recursive: true }).then((created) => {
        // mkdir names only the topmost folder it made; the ones below it on
        // this path are this extraction's too.
        for (let folder = dir; created && folder.length >= created.length; folder = path.dirname(folder)) {
          written.dirs.add(folder);
        }
        zipfile.openReadStream(entry, (error, readStream) => {
          if (error) {
            fail(error);
            return;
          }
          pipeline(readStream, checkCrc(entry), fs.createWriteStream(temp)).then(() => zipfile.readEntry(), fail);
        });
      }, fail);
    });

    zipfile.on('end', () => resolve());
    zipfile.on('error', (error) => reject(error));

    zipfile.readEntry();
  });
}

// Undo an extraction that did not finish: its temp files, then the folders it
// created, if they are empty. Nothing else in RAW is touched.
async function rollbackEntries(written) {
  await Promise.all(written.files.map(({ temp }) => fsp.rm(temp, { force: true })));
  const dirs = [...written.dirs].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    await fsp.rmdir(dir).catch(() => {});
  }
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

  // Held for the whole extraction: no import may take the folder half-written,
  // and none that is running may have files added under it.
  const busy = await withAlbumLock(album, 'album_busy', async () => {
    const written = { files: [], dirs: new Set() };
    try {
      const extractZip = await openZip(zipPath);
      try {
        await extractEntries(extractZip, destByRawName, written);
      } finally {
        extractZip.close();
      }
      for (const { temp, absolute } of written.files) {
        await fsp.rename(temp, absolute);
      }
    } catch (error) {
      await rollbackEntries(written);
      throw error;
    }
  });
  if (busy) {
    throw new ArchiveError(busy.code, busy.message);
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
