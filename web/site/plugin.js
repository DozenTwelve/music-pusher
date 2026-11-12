// The Vite side of site/: every page of site.js is an entry, each is filled in
// by render.js before Vite reads it (in the dev server and in the build alike),
// and the build gets its sitemap and robots.txt.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './site.js';
import { render, robots, sitemap } from './render.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// For `build.rollupOptions.input`.
export const entries = Object.fromEntries(PAGES.map((page) => [page.file.replace(/\.html$/, ''), path.join(root, page.file)]));

export function site() {
  return {
    name: 'site',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const file = path.relative(root, context.filename).split(path.sep).join('/');
        const page = PAGES.find((candidate) => candidate.file === file);
        return page ? render(html, page) : html;
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap() });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots() });
    }
  };
}
