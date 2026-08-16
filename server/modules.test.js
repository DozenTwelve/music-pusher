import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

// Nothing in the suite ever imported routes.js, so a duplicate `const album` in
// it passed every test and every client build and only surfaced as a crash loop
// on the deployment box. A module that cannot even be loaded is the cheapest
// possible failure to catch, and this is the cheapest possible way to catch it:
// import every server module and see that it comes up.
//
// index.js is excluded because it is the entry point — importing it binds the
// port, which is a server, not a test.
const here = path.dirname(url.fileURLToPath(import.meta.url));
const SKIP = new Set(['index.js']);

async function serverModules(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await serverModules(full)));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && !SKIP.has(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

test('every server module loads', async () => {
  const modules = await serverModules(here);
  assert.ok(modules.length > 5, 'the walk found the modules it is supposed to check');

  for (const file of modules) {
    await assert.doesNotReject(
      () => import(url.pathToFileURL(file).href),
      `${path.relative(here, file)} failed to load`
    );
  }
});
