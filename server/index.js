import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
import { apiRouter } from './routes.js';
import { recoverJobs } from './shell.js';

const app = express();

// No cross-origin access. The client is served by this same app, so it never
// needs CORS, while the API is unauthenticated and now carries a route that
// rewrites the entire library: with the default `cors()` any page in the user's
// browser could POST /api/library/repair and relocate every file beets tracks.
// Same-origin requests are unaffected; the Vite dev server proxies /api, so it
// is same-origin too.
app.use(cors({ origin: false }));
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

  // Too late for a JSON body (an SSE stream, a half-sent file): Express's own
  // handler closes the connection. Answering here would throw, and this handler
  // is async, so that throw would be the unhandled rejection it exists to stop.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof multer.MulterError) {
    res.status(413).json({ ok: false, code: err.code, message: err.message });
    return;
  }

  res.status(500).json({ ok: false, code: 'server_error', message: err.message });
});

// Before taking requests: an import the last run left unfinished is settled
// first, so nothing can start on its album, or count its rows, in between.
try {
  await recoverJobs();
} catch (error) {
  console.error(`Could not recover the previous run's imports: ${error.message}`);
}

const server = app.listen(config.port, () => {
  console.log(`music-pusher backend listening on :${config.port}`);
});

server.requestTimeout = 0;
server.headersTimeout = 65000;

// A signal ends Node without its 'exit' event unless something handles it, and
// 'exit' is where every tool still running is killed (metadata/probe.js). PM2
// stops and reloads with SIGINT; a closed terminal sends SIGHUP.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => process.exit(128 + os.constants.signals[signal]));
}
