// The tool in a real browser: the built site served by Vite's preview, a
// headless Chrome driven over the DevTools protocol (Node's own WebSocket, no
// browser library), and albums dropped on the page the way a visitor drops
// them. These pin what only the page does — its steps, its guards, its
// messages — which the pipeline tests (clean.test.js) cannot see.
// Run with CHROME=/path/to/chrome npm test; skipped without it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { translator } from './src/i18n.js';
import { zipWriter } from './src/zip.js';

const CHROME = process.env.CHROME;
const skip = CHROME ? false : 'set CHROME to a Chrome or Chromium binary to run the page in a browser';
const web = path.dirname(fileURLToPath(import.meta.url));
const en = translator('en');
const zh = translator('zh');

let tmp;
let site;
let server; // the address it is served at
let chrome;
const fixtures = {};

function run(bin, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', (error) => resolve({ code: -1, stderr: error.message }));
    proc.on('close', (code) => resolve({ code, stderr }));
  });
}
async function must(bin, args, options) {
  const result = await run(bin, args, options);
  assert.equal(result.code, 0, `${bin} ${args.join(' ')}: ${result.stderr}`);
}
const SINE = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100'];
const flac = (file, tags) => must('ffmpeg', [...SINE, ...Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]), file]);

// A zip of { path: bytes }, as the page's own writer makes it.
async function zipOf(files) {
  const zip = zipWriter();
  for (const [name, bytes] of Object.entries(files)) {
    zip.add(name, bytes);
  }
  return new Uint8Array(await zip.finish().arrayBuffer());
}

// An album of two tracks whose album names differ by a space: one album with a fix to offer.
async function album(name) {
  const dir = path.join(tmp, name);
  await fsp.mkdir(dir, { recursive: true });
  const common = { ALBUM: name, ARTIST: 'A', ALBUMARTIST: 'A', DATE: '2020' };
  await flac(path.join(dir, '01 One.flac'), { ...common, TITLE: 'One', TRACKNUMBER: '1' });
  await flac(path.join(dir, '02 Two.flac'), { ...common, ALBUM: `${name} `, TITLE: 'Two', TRACKNUMBER: '2' });
  return {
    [`${name}/01 One.flac`]: await fsp.readFile(path.join(dir, '01 One.flac')),
    [`${name}/02 Two.flac`]: await fsp.readFile(path.join(dir, '02 Two.flac'))
  };
}

// --- The browser ---------------------------------------------------------------------

// In English, whatever the machine's language: the root follows the browser's.
async function launch() {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-ui-chrome-'));
  const proc = spawn(
    CHROME,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', '--accept-lang=en-US', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const address = await new Promise((resolve, reject) => {
    let said = '';
    proc.stderr.on('data', (chunk) => {
      said += chunk;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (found) {
        resolve(found[1]);
      }
    });
    proc.on('exit', () => reject(new Error(`Chrome exited: ${said}`)));
  });
  const socket = new WebSocket(address);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let last = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    } else {
      listeners.forEach((listener) => listener(message));
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      last += 1;
      pending.set(last, { resolve, reject });
      socket.send(JSON.stringify({ id: last, method, params, sessionId }));
    });
  return {
    send,
    listeners,
    async close() {
      socket.close();
      proc.kill();
      await new Promise((resolve) => proc.once('exit', resolve));
      await fsp.rm(profile, { recursive: true, force: true });
    }
  };
}

// What the page is given to drop: files from base64, a drop of them on the
// document, a folder whose walk takes `delay` ms per read, and reads of files
// slowed by `window.slow` ms (set it to hold the page in a step).
const HELPERS = `
  window.slow = 0;
  const arrayBuffer = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function () {
    if (window.slow) await new Promise((resolve) => setTimeout(resolve, window.slow));
    return arrayBuffer.call(this);
  };
  window.fileOf = (name, base64, type = '') => new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type });
  window.drop = (...files) => {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  };
  window.dropFolder = (name, files, delay) => {
    const fileEntry = (file) => ({ isFile: true, isDirectory: false, fullPath: '/' + name + '/' + file.name, file: (ok) => ok(file) });
    const folder = {
      isFile: false,
      isDirectory: true,
      fullPath: '/' + name,
      createReader() {
        let given = false;
        return { readEntries: (ok) => setTimeout(() => ok(given ? [] : ((given = true), files.map(fileEntry))), delay) };
      }
    };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], items: [{ webkitGetAsEntry: () => folder }], files: [] } });
    document.dispatchEvent(event);
  };
  // Every text the stage has shown, to tell what came and went.
  window.seen = [];
  new MutationObserver(() => window.seen.push(document.querySelector('.stage')?.innerText || '')).observe(document.body, { subtree: true, childList: true, characterData: true });
  // The answers to window.confirm, and the questions it was asked.
  window.asked = [];
  window.answer = false;
  window.confirm = (question) => (window.asked.push(question), window.answer);
  true;
`;

async function open(address) {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  const errors = [];
  const listener = (message) => {
    if (message.sessionId === sessionId && message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
  };
  chrome.listeners.add(listener);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    }
    return result.value;
  };
  const waitFor = async (expression, what = expression, timeout = 30000) => {
    const end = Date.now() + timeout;
    for (;;) {
      if (await evaluate(`Boolean(${expression})`)) {
        return;
      }
      if (Date.now() > end) {
        throw new Error(`waited for ${what}; the stage says: ${await evaluate("document.querySelector('.stage')?.innerText")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await send('Page.navigate', { url: server + address });
  // Taken over by React: its root is on the element.
  await waitFor("document.readyState === 'complete' && Object.keys(document.getElementById('app') || {}).some((key) => key.startsWith('__reactContainer'))", 'the tool to start');
  await evaluate(HELPERS);
  const page = {
    evaluate,
    waitFor,
    errors,
    step: () => evaluate("document.querySelector('.stage').dataset.step"),
    text: () => evaluate("document.querySelector('.stage').innerText"),
    alert: () => evaluate("document.querySelector('.stage [role=alert]')?.innerText ?? null"),
    file: (name, bytes, type) => `fileOf(${JSON.stringify(name)}, ${JSON.stringify(Buffer.from(bytes).toString('base64'))}, ${JSON.stringify(type || '')})`,
    drop: (...files) => evaluate(`void drop(${files.join(', ')})`),
    click: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
    clickText: (text) =>
      evaluate(`[...document.querySelectorAll('.stage button, .stage a')].find((node) => node.textContent.trim() === ${JSON.stringify(text)}).click()`),
    // Whether the page would hold a visitor who is leaving.
    holds: () => evaluate("(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; })()"),
    async close() {
      chrome.listeners.delete(listener);
      await chrome.send('Target.closeTarget', { targetId });
    }
  };
  return page;
}

// A page at the plan for `zip`, dropped as `name`.
async function atPlan(zip, name = 'Album.zip', address = '/') {
  const page = await open(address);
  await page.drop(page.file(name, zip, 'application/zip'));
  await page.waitFor("document.querySelector('.stage').dataset.step === 'plan'", 'the plan');
  return page;
}
async function atDone(zip) {
  const page = await atPlan(zip);
  await page.clickText(en('action.clean'));
  await page.waitFor("document.querySelector('.stage').dataset.step === 'done'", 'the result');
  return page;
}

before(async () => {
  if (skip) {
    return;
  }
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-ui-'));
  const { build, preview } = await import('vite');
  const outDir = path.join(tmp, 'dist');
  await build({ root: web, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  site = await preview({ root: web, logLevel: 'silent', build: { outDir }, preview: { port: 0, host: '127.0.0.1' } });
  server = site.resolvedUrls.local[0].replace(/\/$/, '');
  chrome = await launch();

  const alpha = await album('Alpha');
  fixtures.alpha = await zipOf(alpha);
  fixtures.betaFiles = await album('Beta');
  fixtures.beta = await zipOf(fixtures.betaFiles);
  fixtures.alphaFiles = alpha;
  fixtures.notes = new TextEncoder().encode('liner notes');
  const png = path.join(tmp, 'red.png');
  await must('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', png]);
  fixtures.png = await fsp.readFile(png);
  // A cover.png that is no image at all.
  fixtures.badCover = await zipOf({ ...alpha, 'Alpha/cover.png': new TextEncoder().encode('not a png') });

  // Password-protected, by the system zip: the whole album, and only the notes beside it.
  const stage = path.join(tmp, 'locked');
  await fsp.mkdir(path.join(stage, 'Alpha'), { recursive: true });
  for (const [name, bytes] of Object.entries(alpha)) {
    await fsp.writeFile(path.join(stage, name), bytes);
  }
  await fsp.writeFile(path.join(stage, 'Alpha/notes.txt'), fixtures.notes);
  await must('zip', ['-q', '-P', 'secret', 'whole.zip', ...Object.keys(alpha)], { cwd: stage });
  await must('zip', ['-q', 'half.zip', ...Object.keys(alpha)], { cwd: stage });
  await must('zip', ['-q', '-P', 'secret', 'half.zip', 'Alpha/notes.txt'], { cwd: stage });
  fixtures.locked = await fsp.readFile(path.join(stage, 'whole.zip'));
  fixtures.halfLocked = await fsp.readFile(path.join(stage, 'half.zip'));
});

after(async () => {
  await chrome?.close();
  await site?.close();
  if (tmp) {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

// --- Password-protected zips --------------------------------------------------------

test('a password-protected album says the zip won’t open, in the page’s language', { skip }, async () => {
  const page = await open('/zh/');
  await page.drop(page.file('Alpha.zip', fixtures.locked, 'application/zip'));
  await page.waitFor("document.querySelector('.stage [role=alert]')", 'an alert');
  assert.equal(await page.alert(), zh('error.zip_bad'));
  assert.equal(await page.step(), 'arrive');
  await page.close();
});

test('a password-protected file beside the tracks is left out of the zip, and named', { skip }, async () => {
  const page = await atDone(fixtures.halfLocked);
  const text = await page.text();
  assert.ok(text.includes(en('done.left', { n: 1 })), text);
  assert.ok(text.includes('notes.txt'), text);
  assert.deepEqual(page.errors, []);
  await page.close();
});

// --- A drop that is no album, and a second drop -------------------------------------

const stepIs = (step) => `document.querySelector('.stage').dataset.step === '${step}'`;
const download = "document.querySelector('a[download]')?.href";

test('a stray drop on the result leaves the result, and says why it was not taken', { skip }, async () => {
  const page = await atDone(fixtures.alpha);
  const href = await page.evaluate(download);
  await page.drop(page.file('notes.txt', fixtures.notes, 'text/plain'));
  await page.waitFor("document.querySelector('.stage [role=alert]')", 'an alert');
  assert.equal(await page.alert(), en('error.no_audio'));
  assert.equal(await page.step(), 'done');
  assert.equal(await page.evaluate(download), href);
  // Still there to download.
  assert.equal(await page.evaluate(`fetch(${JSON.stringify(href)}).then((response) => response.ok, () => false)`), true);
  await page.close();
});

test('a stray drop on the plan leaves the plan as the user left it', { skip }, async () => {
  const page = await atPlan(fixtures.alpha);
  await page.click('.fix input[type=checkbox]');
  const lines = async () => (await page.text()).split('\n').filter((line) => line && line !== en('error.zip_bad'));
  const plan = await lines();
  await page.drop(page.file('broken.zip', fixtures.notes, 'application/zip'));
  await page.waitFor("document.querySelector('.stage [role=alert]')", 'an alert');
  assert.equal(await page.alert(), en('error.zip_bad'));
  assert.equal(await page.step(), 'plan');
  assert.deepEqual(await lines(), plan);
  assert.equal(await page.evaluate("document.querySelector('.fix input[type=checkbox]').checked"), false);
  await page.close();
});

test('another album dropped on the result is taken only when the user says so', { skip }, async () => {
  const page = await atDone(fixtures.alpha);
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  await page.waitFor('window.asked.length === 1', 'the question');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await page.step(), 'done');
  assert.ok(!(await page.text()).includes('Beta'));
  await page.evaluate('window.answer = true');
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  await page.waitFor(stepIs('plan'), 'the new plan');
  assert.ok((await page.text()).includes('Beta'));
  await page.close();
});

test('starting over while a dropped zip is still being opened lets the zip go', { skip }, async () => {
  const page = await atPlan(fixtures.alpha);
  await page.evaluate('window.slow = 500');
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  await page.clickText(en('action.another'));
  await page.evaluate('window.slow = 0');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await page.step(), 'arrive');
  assert.equal(await page.evaluate("window.seen.some((text) => text.includes('Beta'))"), false);
  await page.close();
});

test('a folder still being walked when the user starts over does not replace what they take next', { skip }, async () => {
  const page = await atPlan(fixtures.alpha);
  const files = Object.entries(fixtures.betaFiles).map(([name, bytes]) => page.file(path.basename(name), bytes, 'audio/flac'));
  await page.evaluate(`dropFolder('Beta', [${files.join(', ')}], 800)`);
  await page.clickText(en('action.another'));
  await page.drop(page.file('Alpha.zip', fixtures.alpha, 'application/zip'));
  await page.waitFor(stepIs('plan'), 'the plan');
  await page.click('.fix input[type=checkbox]');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await page.evaluate("window.seen.some((text) => text.includes('Beta'))"), false);
  assert.equal(await page.evaluate("document.querySelector('.fix input[type=checkbox]').checked"), false);
  await page.close();
});

test('a second drop while a folder is still being walked is ignored', { skip }, async () => {
  const page = await open('/');
  const files = Object.entries(fixtures.alphaFiles).map(([name, bytes]) => page.file(path.basename(name), bytes, 'audio/flac'));
  await page.evaluate(`dropFolder('Alpha', [${files.join(', ')}], 400)`);
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  await page.waitFor(`${stepIs('plan')} && document.querySelector('.stage').innerText.includes('Alpha')`, 'the folder’s plan');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(await page.evaluate("window.seen.some((text) => text.includes('Beta'))"), false);
  assert.ok((await page.text()).includes('Alpha'));
  await page.close();
});

test('a cover being read keeps what the user switches meanwhile, and holds off another album', { skip }, async () => {
  const page = await atPlan(fixtures.alpha);
  await page.evaluate('window.slow = 600');
  await page.drop(page.file('red.png', fixtures.png, 'image/png'));
  await page.click('.fix input[type=checkbox]');
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  await page.waitFor("document.querySelector('.rack img')", 'the cover');
  await page.evaluate('window.slow = 0');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(await page.step(), 'plan');
  assert.ok(!(await page.text()).includes('Beta'));
  assert.equal(await page.evaluate("document.querySelector('.fix input[type=checkbox]').checked"), false);
  assert.ok((await page.text()).includes('Put the cover in the tracks'));
  await page.close();
});

// --- Leaving, and stopping ----------------------------------------------------------

test('the page holds a visitor who is leaving while there is work on it or a result not yet downloaded', { skip }, async () => {
  const page = await open('/');
  assert.equal(await page.holds(), false);
  await page.evaluate('window.slow = 300');
  await page.drop(page.file('Alpha.zip', fixtures.alpha, 'application/zip'));
  await page.waitFor(stepIs('reading'), 'reading');
  assert.equal(await page.holds(), true);
  await page.evaluate('window.slow = 0');
  await page.waitFor(stepIs('plan'), 'the plan');
  assert.equal(await page.holds(), true);
  await page.clickText(en('action.clean'));
  await page.waitFor(stepIs('done'), 'the result');
  assert.equal(await page.holds(), true);
  await page.click('a[download]');
  assert.equal(await page.holds(), false);
  // Downloaded: another album is taken without asking.
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  await page.waitFor(stepIs('plan'), 'the new plan');
  assert.equal(await page.evaluate('window.asked.length'), 0);
  await page.clickText(en('action.another'));
  assert.equal(await page.holds(), false);
  await page.close();
});

test('reading can be stopped: back to the start, and nothing arrives later', { skip }, async () => {
  const page = await open('/');
  await page.evaluate('window.slow = 400');
  await page.drop(page.file('Alpha.zip', fixtures.alpha, 'application/zip'));
  await page.waitFor(stepIs('reading'), 'reading');
  await page.clickText(en('action.cancel'));
  assert.equal(await page.step(), 'arrive');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await page.step(), 'arrive');
  assert.equal(await page.alert(), null);
  await page.evaluate('window.slow = 0');
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  await page.waitFor(`${stepIs('plan')} && document.querySelector('.stage').innerText.includes('Beta')`, 'the next album');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('right after a stop, another album is taken at once', { skip }, async () => {
  const page = await open('/');
  await page.evaluate('window.slow = 3000');
  await page.drop(page.file('Alpha.zip', fixtures.alpha, 'application/zip'));
  await page.waitFor(stepIs('reading'), 'reading');
  await page.clickText(en('action.cancel'));
  await page.evaluate('window.slow = 0');
  await page.drop(page.file('Beta.zip', fixtures.beta, 'application/zip'));
  // Sooner than the stopped read lets go.
  await page.waitFor(`${stepIs('plan')} && document.querySelector('.stage').innerText.includes('Beta')`, 'the next album', 2000);
  await page.close();
});

test('cleaning can be stopped: back to the plan as it was, and no result arrives later', { skip }, async () => {
  const page = await atPlan(fixtures.alpha);
  await page.click('.fix input[type=checkbox]');
  await page.evaluate('window.slow = 400');
  await page.clickText(en('action.clean'));
  await page.waitFor(stepIs('cleaning'), 'cleaning');
  await page.clickText(en('action.cancel'));
  assert.equal(await page.step(), 'plan');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await page.step(), 'plan');
  assert.equal(await page.alert(), null);
  assert.equal(await page.evaluate("document.querySelector('.fix input[type=checkbox]').checked"), false);
  await page.evaluate('window.slow = 0');
  await page.clickText(en('action.clean'));
  await page.waitFor(stepIs('done'), 'the result');
  assert.deepEqual(page.errors, []);
  await page.close();
});

// --- A cover that cannot be read ----------------------------------------------------

test('a cover image that cannot be read is said where the cover is picked, and no cover fix is offered', { skip }, async () => {
  const page = await atPlan(fixtures.badCover);
  const said = en('cover.unreadable.file', { name: 'cover.png' });
  assert.equal(await page.evaluate('document.querySelector(".rack .drop")?.innerText.includes(' + JSON.stringify(said) + ')'), true);
  const text = await page.text();
  assert.ok(!text.includes('Put the cover in the tracks'), text);
  assert.ok(!text.includes(en('fix.cover_file')), text);
  // An image of the user's own brings the cover fixes back.
  await page.drop(page.file('red.png', fixtures.png, 'image/png'));
  await page.waitFor("document.querySelector('.rack img')", 'the cover');
  const after = await page.text();
  assert.ok(after.includes('Put the cover in the tracks'), after);
  assert.ok(!after.includes(said), after);
  await page.close();
});
