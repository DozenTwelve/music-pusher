import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
import { apiRouter } from './routes.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api', apiRouter);

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

// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, next) => {
  // Multer streams files to disk before it aborts on a limit; remove the
  // partial files so a rejected upload does not leave junk in RAW_DIR.
  if (Array.isArray(req.files) && req.files.length > 0) {
    await Promise.all(
      req.files
        .filter((file) => file?.path)
        .map((file) => fs.rm(file.path, { force: true }).catch(() => {}))
    );
  }

  if (err instanceof multer.MulterError) {
    res.status(413).json({ ok: false, code: err.code, message: err.message });
    return;
  }

  res.status(500).json({ ok: false, code: 'server_error', message: err.message });
});

const server = app.listen(config.port, () => {
  console.log(`music-pusher backend listening on :${config.port}`);
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
