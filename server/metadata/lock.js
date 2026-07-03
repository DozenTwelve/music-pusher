// A single per-album lock shared by every in-place rewrite (tag fixes and cover
// embeds). Both stage their output under the same TEMP_PREFIX temp-file name and
// rename it over the original, so two overlapping runs on one album would race on
// those temp files. Serializing per album prevents that regardless of which
// operation is running.
const albumsInFlight = new Set();

// Run `task()` while holding the album's lock. If the album is already locked by
// another rewrite, return a busy result carrying `busyCode` (routes map it to a
// 409) instead of running.
export async function withAlbumLock(album, busyCode, task) {
  if (albumsInFlight.has(album)) {
    return {
      ok: false,
      code: busyCode,
      message: `Album '${album}' is busy — another fix or cover embed is already running.`
    };
  }

  albumsInFlight.add(album);
  try {
    return await task();
  } finally {
    albumsInFlight.delete(album);
  }
}
