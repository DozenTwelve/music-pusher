// Spike page: drop a folder or a zip, see the tags, write test tags + a cover,
// download the result as a zip. No design; this exists to prove the tag code
// runs in a real browser on real File objects.

import wasmUrl from '../node_modules/taglib-wasm/dist/taglib-web.wasm?url';
import { initTagLib, readTrack, writeTrack } from './tags.js';
import { unzipAlbum, zipAlbum } from './zip.js';
import { diagnoseAlbum } from '../../shared/inspect.js';
import { AUDIO_EXTENSIONS, ART_EXTENSIONS } from '../../shared/extensions.js';
import { extname } from '../../shared/paths.js';

const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);
const isAudio = (path) => AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
const bytesOfFile = async (file) => new Uint8Array(await file.arrayBuffer());

const taglib = await initTagLib(await (await fetch(wasmUrl)).arrayBuffer());
status('Ready. Drop an album.');

let album = []; // [{ path, bytes }]

const COLUMNS = ['file', 'readable', 'formatName', 'sampleRate', 'bitDepth', 'duration', 'hasArt', 'title', 'artist', 'artists', 'album', 'album_artist', 'date', 'disc', 'track'];

async function show(name) {
  const started = performance.now();
  const tracks = [];
  for (const { path, bytes } of album.filter((entry) => isAudio(entry.path))) {
    tracks.push(await readTrack(taglib, path, bytes));
  }
  const elapsed = Math.round(performance.now() - started);

  const table = $('tracks');
  table.replaceChildren();
  const row = (cells, tag) => {
    const tr = table.insertRow();
    for (const text of cells) {
      tr.appendChild(document.createElement(tag)).textContent = String(text ?? '');
    }
  };
  row(COLUMNS, 'th');
  tracks.forEach((track) => row(COLUMNS.map((column) => track[column]), 'td'));

  const images = album.map((e) => e.path).filter((p) => ART_EXTENSIONS.has(extname(p).toLowerCase()));
  // Everything but the per-track echo, which the table already shows.
  const { tracks: _tracks, ...report } = diagnoseAlbum(name, tracks.map(({ properties, ...track }) => track), images);
  $('report').textContent = JSON.stringify(report, null, 2);
  $('write').disabled = tracks.length === 0;
  status(`${album.length} files, ${tracks.length} audio, read in ${elapsed} ms.`);
  return tracks;
}

async function load(name, entries) {
  album = entries.sort((a, b) => a.path.localeCompare(b.path));
  $('download').hidden = true;
  await show(name);
}

// A dropped folder arrives as a FileSystemDirectoryEntry tree.
async function walk(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ path: entry.fullPath.replace(/^\//, ''), bytes: await bytesOfFile(file) });
    return;
  }
  const reader = entry.createReader();
  // readEntries hands back a batch at a time; an empty batch means done.
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) {
      break;
    }
    for (const child of batch) {
      await walk(child, out);
    }
  }
}

async function loadZip(file) {
  status(`Unzipping ${file.name}…`);
  await load(file.name.replace(/\.zip$/i, ''), unzipAlbum(await bytesOfFile(file)));
}

document.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('over');
});
document.addEventListener('dragleave', () => document.body.classList.remove('over'));
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  document.body.classList.remove('over');
  // Entries must be taken before the first await: the item list dies with the event.
  const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry()).filter(Boolean);
  const files = [...event.dataTransfer.files];
  if (entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)) {
    await loadZip(files[0]);
    return;
  }
  status('Reading dropped files…');
  const out = [];
  for (const entry of entries) {
    await walk(entry, out);
  }
  await load(entries[0]?.name || 'album', out);
});

$('zip').addEventListener('change', (event) => event.target.files[0] && loadZip(event.target.files[0]));
$('folder').addEventListener('change', async (event) => {
  const out = [];
  for (const file of event.target.files) {
    out.push({ path: file.webkitRelativePath || file.name, bytes: await bytesOfFile(file) });
  }
  await load(out[0]?.path.split('/')[0] || 'album', out);
});

// A JPEG made on the spot, so the page needs no asset — and the same canvas
// route turns any image the user picks into the JPEG every container accepts.
async function testCover() {
  const canvas = new OffscreenCanvas(300, 300);
  const context = canvas.getContext('2d');
  context.fillStyle = '#063';
  context.fillRect(0, 0, 300, 300);
  context.fillStyle = '#fff';
  context.font = '40px sans-serif';
  context.fillText('spike', 90, 160);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return new Uint8Array(await blob.arrayBuffer());
}

$('write').addEventListener('click', async () => {
  $('write').disabled = true;
  const cover = await testCover();
  const audio = album.filter((entry) => isAudio(entry.path));
  const failed = [];
  const started = performance.now();
  for (const [index, entry] of audio.entries()) {
    status(`Writing ${index + 1}/${audio.length}: ${entry.path}`);
    try {
      entry.bytes = await writeTrack(taglib, entry.path, entry.bytes, {
        set: {
          TITLE: `Spike ${index + 1}`,
          ARTIST: 'A feat. B',
          ARTISTS: ['A', 'B'],
          ALBUM: 'Spike Album',
          ALBUMARTIST: 'Spike Artist',
          DATE: '2021-05-29',
          TRACKNUMBER: `${index + 1}/${audio.length}`,
          DISCNUMBER: '1/1',
          MUSICBRAINZ_ALBUMID: '11111111-2222-3333-4444-555555555555'
        },
        cover
      });
    } catch (error) {
      failed.push(`${entry.path}: ${error.message}`); // unreadable: shipped as it came
    }
  }
  const written = performance.now();
  const zipped = zipAlbum(album);
  const done = performance.now();

  const link = $('download');
  URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
  link.download = 'spike-album.zip';
  link.textContent = `Download zip (${(zipped.length / 1e6).toFixed(1)} MB)`;
  link.hidden = false;

  await show('Spike Album');
  status(
    `Wrote ${audio.length - failed.length}/${audio.length} tracks in ${Math.round(written - started)} ms, ` +
      `zipped in ${Math.round(done - written)} ms.` +
      (failed.length ? ` Not written: ${failed.join('; ')}` : '')
  );
});
