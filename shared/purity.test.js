import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { isBuiltin } from 'node:module';

// shared/ is imported by the server today and by a browser build tomorrow, so
// it has to stay plain JavaScript: no Node built-ins, nothing from server/.
// Node will not complain — it has those modules — so the mistake would surface
// only when a browser bundle fails, or worse, when it does not exist yet to
// fail. This is the stand-in for that build. Test files are exempt: they run
// under Node and nowhere else.
const here = path.dirname(url.fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', 'server');

// The specifier of a static import/export (`from '…'`), a side-effect import
// (`import '…'`), a dynamic import (`import('…')`) or a `require('…')`.
const SPECIFIER_RE = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]+)\1/g;

function specifiers(source) {
  return [...source.matchAll(SPECIFIER_RE)].map((match) => match[2]);
}

// Why a module in shared/ may not import this, or null when it may.
function forbidden(specifier, fromFile) {
  if (specifier.startsWith('node:') || isBuiltin(specifier)) {
    return 'a Node built-in';
  }
  if (specifier.startsWith('.')) {
    const target = path.resolve(path.dirname(fromFile), specifier);
    if (target === serverDir || target.startsWith(serverDir + path.sep)) {
      return 'server code';
    }
  }
  return null;
}

async function sharedModules(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sharedModules(full)));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      found.push(full);
    }
  }
  return found;
}

test('nothing in shared/ imports a Node built-in or server code', async () => {
  const modules = await sharedModules(here);
  assert.ok(modules.length >= 5, 'the walk found the modules it is supposed to check');

  const violations = [];
  let seen = 0;
  for (const file of modules) {
    for (const specifier of specifiers(await fsp.readFile(file, 'utf8'))) {
      seen += 1;
      const reason = forbidden(specifier, file);
      if (reason) {
        violations.push(`${path.relative(here, file)} imports '${specifier}' (${reason})`);
      }
    }
  }

  // The shared modules import each other, so a scan that sees no imports at all
  // is a scan that has stopped working, not a clean result.
  assert.ok(seen > 0, 'the scan found the imports that are there');
  assert.deepEqual(violations, []);
});

test('the guard recognises every way of importing, and both kinds of offender', () => {
  const file = path.join(here, 'example.js');
  const source = [
    "import fs from 'node:fs';",
    'import path from "path";',
    "import { readFile } from 'fs/promises';",
    "import '../server/config.js';",
    "export { config } from '../server/config.js';",
    "const os = await import('os');",
    "const net = require('net');",
    "import { spawn } from 'child_process';",
    "import crypto from 'crypto';",
    "import { extname } from './paths.js';",
    "import { x } from '../client/src/x.js';",
    "import yauzl from 'yauzl';"
  ].join('\n');

  assert.deepEqual(
    specifiers(source).map((specifier) => [specifier, forbidden(specifier, file)]),
    [
      ['node:fs', 'a Node built-in'],
      ['path', 'a Node built-in'],
      ['fs/promises', 'a Node built-in'],
      ['../server/config.js', 'server code'],
      ['../server/config.js', 'server code'],
      ['os', 'a Node built-in'],
      ['net', 'a Node built-in'],
      ['child_process', 'a Node built-in'],
      ['crypto', 'a Node built-in'],
      ['./paths.js', null],
      ['../client/src/x.js', null],
      ['yauzl', null]
    ]
  );
});
