import fs from 'node:fs';
import { defineConfig } from 'vite';
import { entries, site } from './site/plugin.js';

const read = (file) => fs.readFileSync(new URL(`./node_modules/${file}`, import.meta.url), 'utf8');

// taglib-wasm's binary is LGPL-2.1: its notice and the licence text ship with
// the build, where the page's footer links to them, next to the licences of
// everything else in the bundle.
function licenses() {
  // The Archivo font files are bundled too, under the SIL Open Font License.
  const bundled = ['taglib-wasm', 'fflate', 'react', 'react-dom', 'scheduler', '@fontsource-variable/archivo'];
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
  // Served from the root of its own domain: pages sit at nested addresses
  // (/zh/, the guide), so every URL in them is absolute from the root.
  base: '/',
  // Several real pages and a real 404, not one page answering every address.
  appType: 'mpa',
  plugins: [site(), licenses()],
  build: {
    // Top-level await in the entry's lazy half.
    target: 'es2022',
    rollupOptions: { input: entries }
  },
  // The rules live in ../shared, outside this package's root.
  server: { fs: { allow: ['..'] } }
});
