import fs from 'node:fs';
import { defineConfig } from 'vite';

const read = (file) => fs.readFileSync(new URL(`./node_modules/${file}`, import.meta.url), 'utf8');

// taglib-wasm's binary is LGPL-2.1: its notice and the licence text ship with
// the build, where the page's footer links to them, next to the licences of
// everything else in the bundle.
function licenses() {
  const bundled = ['taglib-wasm', 'fflate', 'react', 'react-dom', 'scheduler'];
  return {
    name: 'licenses',
    generateBundle() {
      const emit = (fileName, source) => this.emitFile({ type: 'asset', fileName: `licenses/${fileName}`, source });
      emit('taglib-wasm-NOTICE.txt', read('taglib-wasm/NOTICE'));
      emit('LGPL-2.1.txt', read('taglib-wasm/legal/COPYING.LGPL'));
      emit('third-party.txt', bundled.map((name) => `${name}\n${'='.repeat(name.length)}\n\n${read(`${name}/LICENSE`)}`).join('\n\n'));
    }
  };
}

export default defineConfig({
  // Relative URLs throughout, so the build works from any host and sub-path.
  base: './',
  plugins: [licenses()],
  // Top-level await in the entry (the phone check comes before any import).
  build: { target: 'es2022' },
  // The rules live in ../shared, outside this package's root.
  server: { fs: { allow: ['..'] } }
});
