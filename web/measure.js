// Spike measurements: time and memory to read and rewrite one large FLAC with
// TagLib's browser (Emscripten) backend, run under Node.
//   node --conditions=browser measure.js [megabytes]
// Node-only harness; the code it measures is src/tags.js, unchanged.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initTagLib, readTrack, writeTrack } from './src/tags.js';

const megabytes = Number(process.argv[2]) || 30;
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-measure-'));
const source = path.join(tmp, 'big.flac');
// White noise does not compress, but the source is mono and FLAC stores the
// duplicated second channel for free: ~0.084 MB a second at 16-bit 44.1 kHz.
execFileSync('ffmpeg', [
  '-v', 'error', '-y', '-f', 'lavfi',
  '-i', `anoisesrc=d=${Math.round(megabytes / 0.084)}:c=white:r=44100:a=0.5`,
  '-ac', '2', '-sample_fmt', 's16', '-metadata', 'title=Big', source
]);
const coverPath = path.join(tmp, 'cover.jpg');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=1200x1200', '-frames:v', '1', coverPath]);
const md5 = (file) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'md5', '-']).toString().trim();

const wasm = await fsp.readFile(new URL('./node_modules/taglib-wasm/dist/taglib-web.wasm', import.meta.url));
const bytes = new Uint8Array(await fsp.readFile(source));
const cover = new Uint8Array(await fsp.readFile(coverPath));
const MB = (n) => `${(n / 1e6).toFixed(1)} MB`;
// The wasm linear memory only ever grows, so its size after a call is the
// high-water mark of that call. The Emscripten module does not expose its
// memory, so pick it out of the instance's exports as it is created.
let memory = null;
let startBytes = 0;
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async (...args) => {
  const result = await instantiate(...args);
  memory = Object.values((result.instance || result).exports).find((value) => value instanceof WebAssembly.Memory);
  startBytes = memory.buffer.byteLength;
  return result;
};
const heap = () => memory.buffer.byteLength;
const options = { set: { TITLE: 'New', ALBUM: 'New', ARTISTS: ['A', 'B'], TRACKNUMBER: '1/9' }, cover };

console.log(`file: ${MB(bytes.length)} FLAC, cover: ${MB(cover.length)} JPEG`);

for (const [label, work] of [
  ['read ', (taglib) => readTrack(taglib, 'big.flac', bytes)],
  ['write', (taglib) => writeTrack(taglib, 'big.flac', bytes, options)]
]) {
  const fresh = await initTagLib(wasm);
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    await work(fresh);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${label}: median ${times[2].toFixed(0)} ms (min ${times[0].toFixed(0)}, max ${times[4].toFixed(0)}); ` +
      `wasm heap ${MB(startBytes)} -> ${MB(heap())} = ${((heap() - startBytes) / bytes.length).toFixed(2)}x the file, after 5 runs`
  );
}

// Does the heap keep growing across an album's worth of files?
const taglib = await initTagLib(wasm);
const sizes = [];
let output;
for (let i = 0; i < 12; i += 1) {
  output = await writeTrack(taglib, 'big.flac', bytes, options);
  sizes.push(heap());
}
console.log(`12 writes in one instance, heap after each: ${[...new Set(sizes)].map(MB).join(', ')}`);
// The result must be its own copy, not a window onto the wasm heap that the
// next file would overwrite.
console.log(`output is ${output.buffer === memory.buffer ? 'A VIEW OF THE WASM HEAP' : 'a separate copy'}`);

const target = path.join(tmp, 'out.flac');
await fsp.writeFile(target, output);
console.log(`audio md5 ${md5(source) === md5(target) ? 'identical' : 'DIFFERENT'}; output ${MB(output.length)}`);
await fsp.rm(tmp, { recursive: true, force: true });
