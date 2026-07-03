# music-pusher

A tiny **self-hosted web frontend for [beets](https://beets.io)**: pick an album
folder in your browser, stage it, inspect and fix the tag problems that make
players split one album into several, then `beet import` it into your library —
all while watching the import logs stream live.

It is intentionally small. No database, no accounts, no media server. If you
already curate your music with beets on a home server and just want a friendlier
"drop a folder, clean it up, import it" workflow from any device on your network,
this is for you.

<!-- Add a screenshot at docs/screenshot.png and uncomment: -->
<!-- ![Audit + Import console](docs/screenshot.png) -->

## Features

- 📁 **Folder upload from the browser** (`webkitdirectory`) — the whole album
  tree is reconstructed under a RAW staging directory.
- 🩺 **Deep tag inspection** (`ffprobe`) — catches the metadata that makes a
  music player split one album into several: per-track album / album-artist /
  date drift, multi-disc structure, missing or mis-numbered tracks, corrupted
  tag text (control-char / invisible-character damage), and apostrophe-mangled
  filenames (`Don_t` → `Don't`).
- 🔧 **One-click fixes** (`ffmpeg`, in-place) — unify a field to a single value,
  renumber tracks per disc, repair confidently-recoverable tag text, and fix
  filenames; then it re-inspects to confirm the album collapsed to one group.
- 🖼️ **Cover-art detection & embed** — flags tracks with no embedded picture
  (a loose `cover.jpg` in the folder is reported but still counts as missing),
  then embeds an uploaded image into every track in place (`ffmpeg`).
- 🔎 **Raw tag dump** via `exiftool -r` for a quick eyeball.
- ⬇️ **One-click `beet import -A`** with logs streamed live over Server-Sent Events.
- 🧹 **Optional auto-cleanup** of the RAW folder after a successful import.
- 🛟 **Safe by construction** — path-traversal-checked uploads, `spawn(..., { shell: false })`,
  a single-active-import lock, and Multer size/count limits.

Supported uploads: audio (`.mp3 .flac .m4a .aac .wav .ogg .alac`),
artwork (`.jpg .jpeg .png .webp`), sidecars including `.lrc` lyrics
(`.cue .log .txt .lrc`). Everything else (and system files like `.DS_Store`) is
skipped and reported.

## Requirements

- **Node.js 18+**
- **[beets](https://beets.io)** installed and configured — imports run *your*
  beets config, so set that up first.
- **[ffmpeg](https://ffmpeg.org)** (provides both `ffmpeg` and `ffprobe`) for the
  inspect and fix steps.
- **[exiftool](https://exiftool.org)** for the raw tag-dump step.
- **[PM2](https://pm2.keymetrics.io)** (optional) for the deploy script.

## Quick start

```bash
git clone <your-repo-url> music-pusher
cd music-pusher

cp .env.example .env          # then edit RAW_DIR / LIBRARY_DIR / bin paths
npm install                   # server deps
npm run client:install        # client deps
npm run build                 # builds the React client into client/dist
npm start                     # serves API + UI on http://localhost:3000
```

Open `http://<host>:3000`, drop an album folder, audit, import.

### Development

```bash
npm run dev                   # API on :3000
npm --prefix client run dev   # Vite dev server on :5173 (proxies /api to :3000)
```

## Configuration

All settings come from `.env` (see `.env.example`):

| Variable                   | Default          | Description                                             |
| -------------------------- | ---------------- | ------------------------------------------------------- |
| `PORT`                     | `3000`           | HTTP port for the API + static client.                  |
| `RAW_DIR`                  | `./data/RAW`     | Staging directory uploads land in.                      |
| `LIBRARY_DIR`              | `./data/LIBRARY` | Reported by `/api/health` (your beets library target).  |
| `MAX_FILE_SIZE_MB`         | `2048`           | Per-file upload limit.                                  |
| `MAX_FILES`                | `2000`           | Max files per upload.                                   |
| `MAX_COVER_SIZE_MB`        | `20`             | Max size for an uploaded cover image.                   |
| `BEET_BIN`                 | `beet`           | Path to the `beet` binary (e.g. a venv path).           |
| `EXIFTOOL_BIN`             | `exiftool`       | Path to the `exiftool` binary.                          |
| `FFMPEG_BIN`               | `ffmpeg`         | Path to the `ffmpeg` binary (used to rewrite tags).     |
| `FFPROBE_BIN`              | `ffprobe`        | Path to the `ffprobe` binary (used to read tags).       |
| `CLEANUP_RAW_AFTER_IMPORT` | `true`           | Remove the RAW album folder after a successful import.  |

Paths support `~` expansion.

## Deploy

On the server:

```bash
npm run deploy
```

This pulls the latest (`git fetch` + fast-forward `pull`), installs server and
client dependencies, rebuilds the client, and reloads the PM2 process. Override
the process name if yours differs:

```bash
PM2_APP_NAME=my-app npm run deploy
```

## API

| Method | Route                        | Purpose                                  |
| ------ | ---------------------------- | ---------------------------------------- |
| `GET`  | `/api/health`               | Liveness + resolved RAW/LIBRARY dirs.    |
| `POST` | `/api/upload`               | Multipart folder upload → RAW staging.   |
| `GET`  | `/api/albums`               | List staged albums with size/count.      |
| `POST` | `/api/audit`                | Run `exiftool -r` on an album (raw dump).|
| `POST` | `/api/inspect`              | Structured tag/split/track report.       |
| `POST` | `/api/fix`                  | Apply tag/track/filename fixes in place. |
| `POST` | `/api/cover`                | Embed an uploaded cover into every track.|
| `POST` | `/api/import`               | Start a `beet import` job.               |
| `GET`  | `/api/import/:jobId`        | Job status.                              |
| `GET`  | `/api/import/:jobId/stream` | Live import logs (SSE).                  |

## Security note

**There is no authentication.** This app spawns `beet`/`exiftool` and deletes
RAW folders on request, and CORS is open. Run it only on a **trusted LAN** —
do not expose it directly to the internet. Put it behind a reverse proxy with
auth if you need remote access.

## License

[MIT](LICENSE)
