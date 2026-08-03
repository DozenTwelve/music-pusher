// A single per-album lock shared by every in-place rewrite (tag fixes and cover
// embeds). Both stage their output under the same TEMP_PREFIX temp-file name and
// rename it over the original, so two overlapping runs on one album would race on
// those temp files. Serializing per album prevents that regardless of which
// operation is running.
//
// Note: process-local Set. If the server is scaled to multiple workers/instances,
// replace with a distributed lock (Redis, etc.) to prevent cross-process races.
const albumsInFlight = new Set();

// Take the album's lock, or report that someone else holds it. The explicit
// pair exists for work that outlives the call that starts it: a beets import
// spawns and returns immediately, so it cannot hold a scoped lock, yet it moves
// the very files a fix renames over and must exclude one for its whole run.
export function acquireAlbum(album) {
  if (albumsInFlight.has(album)) {
    return false;
  }
  albumsInFlight.add(album);
  return true;
}

export function releaseAlbum(album) {
  albumsInFlight.delete(album);
}

export function albumBusyMessage(album) {
  return `Album '${album}' is busy — another fix, cover embed or import is already running.`;
}

// Run `task()` while holding the album's lock. If the album is already locked by
// another rewrite, return a busy result carrying `busyCode` (routes map it to a
// 409) instead of running.
export async function withAlbumLock(album, busyCode, task) {
  if (!acquireAlbum(album)) {
    return {
      ok: false,
      code: busyCode,
      message: albumBusyMessage(album)
    };
  }

  try {
    return await task();
  } finally {
    releaseAlbum(album);
  }
}
