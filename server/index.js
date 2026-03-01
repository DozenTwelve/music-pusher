import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import {
  uploadMiddleware,
  listAlbums,
  buildUploadSummary,
  sanitizeAlbumName
} from './upload.js';
import { runAudit, startImport, streamJob, getJob } from './shell.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (req, res) => {
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

app.post('/api/upload', uploadMiddleware.any(), async (req, res) => {
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

app.get('/api/albums', async (req, res) => {
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

app.post('/api/audit', async (req, res) => {
  const album = sanitizeAlbumName(req.body?.album);
  if (!album) {
    res.status(400).json({
      ok: false,
      code: 'invalid_album',
      message: 'Album name is required and must be a single folder segment.'
    });
    return;
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

app.post('/api/import', async (req, res) => {
  const album = sanitizeAlbumName(req.body?.album);
  if (!album) {
    res.status(400).json({
      ok: false,
      code: 'invalid_album',
      message: 'Album name is required and must be a single folder segment.'
    });
    return;
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

app.get('/api/import/:jobId', (req, res) => {
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

app.get('/api/import/:jobId/stream', (req, res) => {
  const streamResult = streamJob(req.params.jobId, res);
  if (!streamResult.ok) {
    res.status(404).json({
      ok: false,
      code: 'job_not_found',
      message: 'No import job found for the given id.'
    });
  }
});

app.get('/1.ico', (req, res) => {
  res.sendFile(path.join(process.cwd(), '1.ico'));
});

const clientDist = path.join(process.cwd(), 'client', 'dist');
app.use(express.static(clientDist));

app.get('*', async (req, res, next) => {
  try {
    await fs.access(path.join(clientDist, 'index.html'));
    res.sendFile(path.join(clientDist, 'index.html'));
  } catch {
    next();
  }
});

const server = app.listen(config.port, () => {
  console.log(`music-pusher backend listening on :${config.port}`);
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
