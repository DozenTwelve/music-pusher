# syntax=docker/dockerfile:1

# ---- stage 1: build the React client ----
FROM node:22-slim AS client
WORKDIR /app
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix client ci
COPY client/ ./client/
# Definitions shared between server and client live outside the client root.
COPY shared/ ./shared/
RUN npm --prefix client run build

# ---- stage 2: runtime ----
FROM node:22-slim AS runtime

# The app shells out to real binaries — they must live in the image.
# ffmpeg ships both ffmpeg and ffprobe. gosu drops root to PUID/PGID at start.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       libimage-exiftool-perl \
       python3 \
       python3-venv \
       gosu \
    && rm -rf /var/lib/apt/lists/*

# beets in its own venv — the layout the README recommends on bare metal.
RUN python3 -m venv /opt/beets \
    && /opt/beets/bin/pip install --no-cache-dir beets

WORKDIR /app

# Server deps only; the client build tooling stays in stage 1.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY shared/ ./shared/
COPY 1.ico ./
COPY --from=client /app/client/dist ./client/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# In-container defaults. Override via compose/env only if you remap the volumes.
# BEETSDIR points beets at /config so its config.yaml AND library db persist.
ENV NODE_ENV=production \
    PORT=3000 \
    RAW_DIR=/data/RAW \
    LIBRARY_DIR=/music \
    BEET_BIN=/opt/beets/bin/beet \
    BEETSDIR=/config \
    FFMPEG_BIN=ffmpeg \
    FFPROBE_BIN=ffprobe \
    EXIFTOOL_BIN=exiftool

EXPOSE 3000
VOLUME ["/data", "/config", "/music"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/index.js"]
