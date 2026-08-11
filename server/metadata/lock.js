// A single per-album lock shared by every in-place rewrite (tag fixes and cover
// embeds). Both stage their output under the same TEMP_PREFIX temp-file name and
// rename it over the original, so two overlapping runs on one album would race on
// those temp files. Serializing per album prevents that regardless of which
// operation is running.
//
// Note: process-local Set. If the server is scaled to multiple workers/instances,
// replace with a distributed lock (Redis, etc.) to prevent cross-process races.
const albumsInFlight = new Set();

// A library repair (`beet update`) relocates files across every album at once,
// so it is the one operation the per-album lock cannot express. It gets its own
// flag, and the two exclude each other in both directions: a repair refuses to
// start while any album is in flight, and holds off every album while it runs.
let libraryInFlight = false;

// Take the album's lock, or report that someone else holds it. The explicit
// pair exists for work that outlives the call that starts it: a beets import
// spawns and returns immediately, so it cannot hold a scoped lock, yet it moves
// the very files a fix renames over and must exclude one for its whole run.
export function acquireAlbum(album) {
  if (libraryInFlight || albumsInFlight.has(album)) {
    return false;
  }
  albumsInFlight.add(album);
  return true;
}

export function releaseAlbum(album) {
  albumsInFlight.delete(album);
}

export function albumBusyMessage(album) {
  if (libraryInFlight) {
    return `Album '${album}' is busy — a library repair is running and moves the same files.`;
  }
  return `Album '${album}' is busy — another fix, cover embed or import is already running.`;
}

// Take the library-wide lock for a `beet update`. Fails while any album is
// mid-rewrite rather than queueing: the repair is a manual, explicit action, so
// reporting "try again in a moment" beats holding an HTTP request open.
export function acquireLibrary() {
  if (libraryInFlight || albumsInFlight.size > 0) {
    return false;
  }
  libraryInFlight = true;
  return true;
}

export function releaseLibrary() {
  libraryInFlight = false;
}

export function libraryBusyMessage() {
  if (libraryInFlight) {
    return 'A library repair is already running.';
  }
  const albums = [...albumsInFlight].join(', ');
  return `A fix, cover embed or import is running (${albums}) — a library repair would move the same files. Try again once it finishes.`;
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
