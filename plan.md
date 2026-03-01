# Music-Pusher MVP Implementation Plan (Revised)

## 1) Stack

- Runtime: bare metal (no Docker)
- Process manager: PM2
- Backend: Node.js + Express + Multer (disk streaming)
- Frontend: React + Vite (served by Express in production)

## 2) Upload Behavior

- User picks a folder with `<input webkitdirectory>`.
- Frontend sends each file with its `webkitRelativePath` as multipart filename.
- Backend reconstructs folders under `RAW_DIR/<album>/...`.
- Supported files:
  - Audio: `.mp3 .flac .m4a .aac .wav .ogg .alac`
  - Artwork: `.jpg .jpeg .png .webp`
  - Sidecars: `.cue .log .txt`
- Unsupported/system files are skipped and reported in the response.

## 3) API

- `POST /api/upload`
  - Streams files directly to disk
  - Returns `acceptedCount`, `skippedCount`, `totalBytes`, and skipped paths/reasons
- `GET /api/albums`
  - Lists staged album folders from `RAW_DIR`
- `POST /api/audit`
  - Runs `exiftool -r <album-path>` and returns stdout/stderr
- `POST /api/import`
  - Starts single active import with `beet import -A <album-path>`
  - Returns `jobId`
- `GET /api/import/:jobId/stream`
  - SSE endpoint for live import logs

## 4) Safety Requirements

- Sanitize all relative paths and album names.
- Reject path traversal (`..`, absolute, null byte).
- Use `spawn(cmd, args, { shell: false })` for shell commands.
- Multer limits for max file size and max file count.
- Keep upload streaming to disk (`diskStorage`, no memory buffering).

## 5) Frontend Flow

1. Upload panel with folder picker and progress bar.
2. RAW staging list with album size/count.
3. Audit/import console:
   - Run audit and display text output.
   - Start import and stream logs via SSE until completion.

## 6) Runtime Notes

- Configure env vars:
  - `PORT`
  - `RAW_DIR`
  - `LIBRARY_DIR`
  - `MAX_FILE_SIZE_MB`
  - `MAX_FILES`
- For long uploads on local network:
  - `server.requestTimeout = 0`
  - set `server.headersTimeout` to safe value
