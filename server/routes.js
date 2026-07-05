import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { createReadStream } from 'node:fs';
import {
  uploadMiddleware,
  archiveUploadMiddleware,
  listAlbums,
  buildUploadSummary,
  sanitizeAlbumName,
  ART_EXTENSIONS,
  COVER_IMAGE_EXTENSIONS
} from './upload.js';
import { extractZipAlbum, ArchiveError } from './archive.js';
import { runAudit, startImport, streamJob, getJob } from './shell.js';
import { inspectAlbum, fixAlbum, embedCover } from './metadata/index.js';

export const apiRouter = express.Router();

// A single cover image is small, so keep it in memory rather than staging it to
// disk; embedCover writes it into the album folder itself. Only accept the same
// image extensions the album uploader does.
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxCoverSizeBytes, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, COVER_IMAGE_EXTENSIONS.has(ext));
  }
});

// Resolve and validate an album name from the request body, sending the
// appropriate error response and returning null when it is not usable.
async function resolveAlbum(req, res) {
  const album = sanitizeAlbumName(req.body?.album);
  if (!album) {
    res.status(400).json({
      ok: false,
      code: 'invalid_album',
      message: 'Album name is required and must be a single folder segment.'
    });
    return null;
  }

  const albumPath = path.join(config.rawDir, album);
  try {
    const stat = await fs.stat(albumPath);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }
  } catch {
    res.status(404).json({
      ok: false,
      code: 'album_not_found',
      message: `Album '${album}' not found in RAW staging directory.`
    });
    return null;
  }

  return album;
}

apiRouter.get('/health', async (req, res) => {
  try {
    await fs.mkdir(config.rawDir, { recursive: true });
    const disk = await fs.stat(config.rawDir);
    res.json({
      ok: true,
      rawDir: config.rawDir,
      libraryDir: config.libraryDir,
      rawDirReadable: disk.isDirectory()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'health_check_failed',
      message: error.message
    });
  }
});

apiRouter.post('/upload', uploadMiddleware.any(), async (req, res) => {
  try {
    await fs.mkdir(config.rawDir, { recursive: true });

    const summary = buildUploadSummary(req);
    res.json({
      ok: true,
      ...summary
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'upload_failed',
      message: error.message
    });
  }
});

apiRouter.post('/upload-archive', archiveUploadMiddleware.single('archive'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({
      ok: false,
      code: req.archiveRejected || 'no_archive',
      message: 'Upload a single .zip archive in the "archive" field.'
    });
    return;
  }

  try {
    const allowMixed = req.body?.allowMixed === 'true' || req.body?.allowMixed === '1';
    const summary = await extractZipAlbum(req.file.path, req.file.originalname, { allowMixed });
    res.json({ ok: true, ...summary });
  } catch (error) {
    if (error instanceof ArchiveError) {
      if (error.code === 'mixed_formats') {
        res.status(409).json({ ok: false, code: error.code, message: error.message, formats: error.formats });
        return;
      }
      const status = error.code === 'file_too_large' || error.code === 'too_many_files' ? 413 : 422;
      res.status(status).json({ ok: false, code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ ok: false, code: 'archive_extract_failed', message: error.message });
  } finally {
    fs.rm(req.file.path, { force: true }).catch(() => {});
  }
});

apiRouter.get('/albums', async (req, res) => {
  try {
    const albums = await listAlbums();
    res.json({ ok: true, albums });
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'list_albums_failed',
      message: error.message
    });
  }
});

// MIME type for the small set of art extensions we accept.
const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

// Preferred cover basenames, in priority order. Anything else falls back to the
// first art file found (sorted) so an album with only, say, `scan01.jpg` still
// shows something.
const COVER_NAME_PRIORITY = ['cover', 'front', 'folder', 'album'];

// Find the best cover image inside a staged album directory. Walks the tree
// (albums are usually flat, but art can sit in a subfolder) and ranks matches.
async function findCoverFile(albumPath) {
  const images = [];
  const stack = [albumPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && ART_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        images.push(full);
      }
    }
  }
  if (images.length === 0) {
    return null;
  }
  images.sort((a, b) => {
    const rank = (p) => {
      const base = path.basename(p, path.extname(p)).toLowerCase();
      const i = COVER_NAME_PRIORITY.indexOf(base);
      return i === -1 ? COVER_NAME_PRIORITY.length : i;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return images[0];
}

// Stream a staged album's cover art. Used by the uploader to preview the cover
// right after upload. 404 when the album has no loose image.
apiRouter.get('/albums/:album/cover', async (req, res) => {
  const album = sanitizeAlbumName(req.params.album);
  if (!album) {
    res.status(400).json({ ok: false, code: 'invalid_album', message: 'Album name is required.' });
    return;
  }

  const resolvedRawDir = path.resolve(config.rawDir);
  const albumPath = path.resolve(resolvedRawDir, album);
  if (albumPath !== resolvedRawDir && !albumPath.startsWith(resolvedRawDir + path.sep)) {
    res.status(400).json({ ok: false, code: 'invalid_album', message: 'Invalid album path.' });
    return;
  }

  try {
    const coverPath = await findCoverFile(albumPath);
    if (!coverPath) {
      res.status(404).json({ ok: false, code: 'no_cover', message: 'No cover art found for this album.' });
      return;
    }
    // Cover is served by album name, so re-uploading the same album would reuse
    // this URL — no-cache keeps the preview from showing stale art.
    res.set('Cache-Control', 'no-cache');
    res.type(IMAGE_MIME[path.extname(coverPath).toLowerCase()] || 'application/octet-stream');
    createReadStream(coverPath)
      .on('error', () => {
        // A mid-stream error means the headers are already flushed, so we can't
        // change the status — just abort the response.
        if (!res.headersSent) {
          res.sendStatus(500);
        }
        res.destroy();
      })
      .pipe(res);
  } catch {
    res.status(404).json({ ok: false, code: 'album_not_found', message: `Album '${album}' not found.` });
  }
});

// Remove a staged album from RAW entirely (its whole folder). The name is
// sanitized to a single segment and the resolved path is re-checked to be
// inside RAW before anything is deleted.
apiRouter.delete('/albums/:album', async (req, res) => {
  const album = sanitizeAlbumName(req.params.album);
  if (!album) {
    res.status(400).json({
      ok: false,
      code: 'invalid_album',
      message: 'Album name is required and must be a single folder segment.'
    });
    return;
  }

  const resolvedRawDir = path.resolve(config.rawDir);
  const albumPath = path.resolve(resolvedRawDir, album);
  if (albumPath !== resolvedRawDir && !albumPath.startsWith(resolvedRawDir + path.sep)) {
    res.status(400).json({ ok: false, code: 'invalid_album', message: 'Invalid album path.' });
    return;
  }

  try {
    const stat = await fs.stat(albumPath);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }
  } catch {
    res.status(404).json({
      ok: false,
      code: 'album_not_found',
      message: `Album '${album}' not found in RAW staging directory.`
    });
    return;
  }

  try {
    await fs.rm(albumPath, { recursive: true, force: true });
    res.json({ ok: true, album });
  } catch (error) {
    res.status(500).json({ ok: false, code: 'delete_album_failed', message: error.message });
  }
});

apiRouter.post('/audit', async (req, res) => {
  const album = await resolveAlbum(req, res);
  if (!album) {
    return;
  }

  const audit = await runAudit(album);
  res.status(audit.ok ? 200 : 500).json({
    ok: audit.ok,
    code: audit.code,
    stdout: audit.stdout,
    stderr: audit.stderr
  });
});

apiRouter.post('/inspect', async (req, res) => {
  const album = await resolveAlbum(req, res);
  if (!album) {
    return;
  }

  try {
    const report = await inspectAlbum(album);
    res.status(report.ok ? 200 : 422).json(report);
  } catch (error) {
    res.status(500).json({ ok: false, code: 'inspect_failed', message: error.message });
  }
});

apiRouter.post('/fix', async (req, res) => {
  const album = await resolveAlbum(req, res);
  if (!album) {
    return;
  }

  try {
    const result = await fixAlbum(album, {
      set: req.body?.set || {},
      normalizeTracks: Boolean(req.body?.normalizeTracks),
      fixFilenames: Boolean(req.body?.fixFilenames),
      repairText: Boolean(req.body?.repairText)
    });
    // A fix that ran is a 200 even with per-file errors (a partial success the
    // client renders from result.errors); reserve 4xx for not-run outcomes.
    let status;
    if (result.code === 'fix_busy') {
      status = 409;
    } else if (result.code === 'no_audio_files') {
      status = 422;
    } else {
      status = 200;
    }
    res.status(status).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, code: 'fix_failed', message: error.message });
  }
});

apiRouter.post('/cover', coverUpload.single('cover'), async (req, res) => {
  // Multer parses the multipart body first, so req.body.album is populated by the
  // time resolveAlbum reads it.
  const album = await resolveAlbum(req, res);
  if (!album) {
    return;
  }

  if (!req.file) {
    res.status(400).json({
      ok: false,
      code: 'no_cover',
      message: 'A cover image is required (field "cover": jpg, jpeg, png, webp, gif, bmp, or tiff).'
    });
    return;
  }

  try {
    const result = await embedCover(album, {
      buffer: req.file.buffer,
      ext: path.extname(req.file.originalname).toLowerCase()
    });
    // Mirrors /fix: a run that reached files is 200 even with per-file errors;
    // reserve 4xx for not-run outcomes.
    let status;
    if (result.code === 'cover_busy') {
      status = 409;
    } else if (result.code === 'no_audio_files') {
      status = 422;
    } else {
      status = 200;
    }
    res.status(status).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, code: 'cover_failed', message: error.message });
  }
});

apiRouter.post('/import', async (req, res) => {
  const album = await resolveAlbum(req, res);
  if (!album) {
    return;
  }

  const result = startImport(album);
  if (!result.ok) {
    res.status(409).json({
      ok: false,
      code: result.error,
      message: result.message
    });
    return;
  }

  res.status(202).json({ ok: true, job: result.job });
});

apiRouter.get('/import/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({
      ok: false,
      code: 'job_not_found',
      message: 'No import job found for the given id.'
    });
    return;
  }

  res.json({
    ok: true,
    job: {
      id: job.id,
      album: job.album,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt
    }
  });
});

apiRouter.get('/import/:jobId/stream', (req, res) => {
  const streamResult = streamJob(req.params.jobId, res);
  if (!streamResult.ok) {
    res.status(404).json({
      ok: false,
      code: 'job_not_found',
      message: 'No import job found for the given id.'
    });
  }
});

apiRouter.use((req, res) => {
  res.status(404).json({
    ok: false,
    code: 'not_found',
    message: `Unknown API route: ${req.method} ${req.originalUrl}`
  });
});
