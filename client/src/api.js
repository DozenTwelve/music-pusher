import axios from 'axios';

// Pull a human-readable message out of an axios error.
export function errorMessage(error) {
  return error?.response?.data?.message || error.message;
}

export function albumCoverUrl(album) {
  return `/api/albums/${encodeURIComponent(album)}/cover`;
}

export async function getAlbums() {
  const { data } = await axios.get('/api/albums');
  return data?.albums || [];
}

export async function getPreflight() {
  const { data } = await axios.get('/api/preflight');
  return data;
}

// Greedy largest-first bin-packing: distribute entries across `binCount` groups
// so each carries a roughly equal number of bytes. Keeps the parallel requests
// finishing around the same time and the aggregate progress bar smooth.
function packIntoBins(entries, binCount) {
  const bins = Array.from({ length: binCount }, () => ({ entries: [], bytes: 0 }));
  const sorted = [...entries].sort((a, b) => (b.file.size || 0) - (a.file.size || 0));
  for (const entry of sorted) {
    const bin = bins.reduce((min, b) => (b.bytes < min.bytes ? b : min), bins[0]);
    bin.entries.push(entry);
    bin.bytes += entry.file.size || 0;
  }
  return bins.filter((bin) => bin.entries.length > 0);
}

function mergeUploadResults(results) {
  const albumSet = new Set();
  const merged = { album: null, albums: [], acceptedCount: 0, skippedCount: 0, totalBytes: 0, skipped: [] };
  for (const result of results) {
    merged.acceptedCount += result.acceptedCount || 0;
    merged.skippedCount += result.skippedCount || 0;
    merged.totalBytes += result.totalBytes || 0;
    if (Array.isArray(result.skipped)) {
      merged.skipped.push(...result.skipped);
    }
    for (const album of result.albums || []) {
      albumSet.add(album);
    }
  }
  merged.albums = [...albumSet];
  merged.album = merged.albums.length === 1 ? merged.albums[0] : null;
  return merged;
}

// A folder upload is split across several concurrent POSTs. One TCP stream is
// near line-rate on wired gigabit, but WiFi / phone connections leave bandwidth
// unused on a single socket — parallel connections claim it. The server needs no
// change: mkdir is recursive/idempotent and each request carries its own files.
export async function uploadAlbum(entries, onProgress, concurrency = 4) {
  const bins = packIntoBins(entries, Math.min(concurrency, entries.length) || 1);
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0) || 1;
  const loaded = new Array(bins.length).fill(0);

  const emit = () => {
    if (!onProgress) {
      return;
    }
    const sum = loaded.reduce((acc, n) => acc + n, 0);
    // event.loaded includes multipart overhead, so it can edge past our
    // size-only denominator — clamp so the bar never overshoots 100%.
    onProgress({ loaded: Math.min(sum, totalBytes), total: totalBytes });
  };

  const requests = bins.map((bin, index) => {
    const body = new FormData();
    for (const { file, path } of bin.entries) {
      body.append('files', file, path);
    }
    return axios
      .post('/api/upload', body, {
        onUploadProgress: (event) => {
          loaded[index] = event.loaded;
          emit();
        }
      })
      .then((response) => response.data);
  });

  // A folder is fanned out across parallel POSTs; if one bin fails the siblings
  // have already written their files, leaving a partial album staged. Remove
  // every album this upload touched before surfacing the error, so a retry
  // starts clean instead of importing an incomplete album.
  // ponytail: a retry into a pre-existing same-named album would also delete
  // that album — acceptable, RAW is app-owned and same-name re-drops are rare.
  const settled = await Promise.allSettled(requests);
  const fulfilled = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failed = settled.find((s) => s.status === 'rejected');

  if (failed) {
    const albums = new Set();
    for (const result of fulfilled) {
      for (const album of result.albums || []) {
        albums.add(album);
      }
    }
    await Promise.all([...albums].map((album) => deleteAlbum(album).catch(() => {})));
    throw failed.reason;
  }

  return mergeUploadResults(fulfilled);
}

export async function uploadArchive(formData, onUploadProgress) {
  const { data } = await axios.post('/api/upload-archive', formData, { onUploadProgress });
  return data;
}

// Confirm a mixed-format archive the server kept under a token, so it extracts
// the already-uploaded .zip instead of making the client re-transfer it.
export async function confirmArchive(token) {
  const { data } = await axios.post('/api/upload-archive/confirm', { token });
  return data;
}

export async function deleteAlbum(album) {
  const { data } = await axios.delete(`/api/albums/${encodeURIComponent(album)}`);
  return data;
}

export async function inspectAlbum(album) {
  const { data } = await axios.post('/api/inspect', { album });
  return data;
}

export async function fixAlbum(album, payload) {
  const { data } = await axios.post('/api/fix', { album, ...payload });
  return data;
}

export async function embedCover(album, file) {
  const formData = new FormData();
  formData.append('album', album);
  formData.append('cover', file);
  const { data } = await axios.post('/api/cover', formData);
  return data;
}

// MusicBrainz releases this album could be. Read-only — nothing is applied
// until one is passed back to startImport.
// `search` overrides what to look for; blank fields fall back to the album's
// own tags, which is all an album that arrived untagged could offer.
export async function searchReleases(album, search = {}) {
  const { data } = await axios.post('/api/releases', { album, search });
  return data;
}

// `force` skips the server's would-split guard, for when the user has seen the
// predicted cause and wants the import anyway. `releaseId` names the release to
// import as, for the albums whose tags are too thin for beets to decide.
export async function startImport(album, { force = false, releaseId = null } = {}) {
  const { data } = await axios.post('/api/import', { album, force, releaseId });
  return data;
}

// Read-only reconciliation of the beets database against the filesystem.
export async function getLibraryHealth() {
  const { data } = await axios.get('/api/library/health');
  return data;
}

// Every album already imported, with the counts that say whether the import
// corrected anything. Read-only.
export async function getLibraryAlbums() {
  const { data } = await axios.get('/api/library/albums');
  return data?.albums || [];
}

// Move an imported album back into RAW, so the ordinary analyze → fix → import
// path can be run over it again. Files are moved, never copied or deleted.
export async function restageLibraryAlbum(albumId) {
  const { data } = await axios.post('/api/library/restage', { albumId });
  return data;
}

// Repair what getLibraryHealth reports, via `beet update`. `pretend` returns the
// same change list without touching anything, so it doubles as the preview.
export async function repairLibrary(pretend) {
  const { data } = await axios.post('/api/library/repair', { pretend });
  return data;
}

// Undo a partial import (remove the rows it added, put the files back in RAW)
// and import again.
export async function retryImport(album) {
  const { data } = await axios.post('/api/import/retry', { album });
  return data;
}

export function importStreamUrl(jobId) {
  return `/api/import/${jobId}/stream`;
}
