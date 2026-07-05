import axios from 'axios';

// Pull a human-readable message out of an axios error.
export function errorMessage(error) {
  return error?.response?.data?.message || error.message;
}

export async function getAlbums() {
  const { data } = await axios.get('/api/albums');
  return data?.albums || [];
}

export async function uploadAlbum(formData, onUploadProgress) {
  const { data } = await axios.post('/api/upload', formData, { onUploadProgress });
  return data;
}

export async function uploadArchive(formData, onUploadProgress) {
  const { data } = await axios.post('/api/upload-archive', formData, { onUploadProgress });
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

export async function startImport(album) {
  const { data } = await axios.post('/api/import', { album });
  return data;
}

export function importStreamUrl(jobId) {
  return `/api/import/${jobId}/stream`;
}
