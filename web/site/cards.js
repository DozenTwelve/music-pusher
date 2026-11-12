// The social cards (public/og/*.png, 1200×630) and the bitmap icons, drawn in
// the page's own type by a headless Chrome. Run by hand when a card's words
// change: CHROME=/path/to/chrome node site/cards.js
// The cards are files in the repository; nothing here runs in the build.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const font = path.join(web, 'node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2');
const chrome = process.env.CHROME;
if (!chrome) {
  throw new Error('Set CHROME to a Chrome or Chromium binary.');
}

// The light tokens of src/tokens.css.
const PAPER = 'oklch(90% 0.004 250)';
const INK = 'oklch(17% 0.006 250)';
const MUTED = 'oklch(40% 0.006 250)';

const CARDS = [
  { file: 'og/home.en.png', lang: 'en', name: 'Album Cleaner', title: 'Fix an album that Navidrome shows in pieces.', line: 'Fixed in your browser. Nothing is uploaded.', sleeves: [3, 1] },
  { file: 'og/home.zh.png', lang: 'zh-Hans', name: '专辑整理', title: '修好被 Navidrome 拆散的专辑。', line: '在浏览器里修，不上传任何文件。', sleeves: [3, 1] },
  { file: 'og/guide.en.png', lang: 'en', name: 'Album Cleaner', title: 'Why Navidrome splits one album into several', line: '22 cases from a real Navidrome 0.63.2 scan.', sleeves: [2, 1] },
  { file: 'og/guide.zh.png', lang: 'zh-Hans', name: '专辑整理', title: 'Navidrome 为什么把一张专辑拆成好几张', line: '真实 Navidrome 0.63.2 扫描里的 22 个例子。', sleeves: [2, 1] }
];

const style = `
@font-face { font-family: Archivo; src: url("file://${font}") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
body { display: grid; grid-template-rows: auto 1fr auto; padding: 64px 72px 56px; background: ${PAPER}; color: ${INK}; font-family: Archivo, "PingFang SC", sans-serif; -webkit-font-smoothing: antialiased; }
.name { justify-self: start; padding: 6px 16px; background: ${INK}; color: ${PAPER}; font-size: 30px; font-stretch: 68%; font-weight: 800; letter-spacing: 0.02em; text-transform: uppercase; }
:lang(zh) .name { font-weight: 600; letter-spacing: 0.08em; }
main { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 56px; padding-bottom: 40px; }
h1 { max-width: 12em; font-size: 92px; font-stretch: 75%; font-weight: 800; letter-spacing: -0.012em; line-height: 1; text-wrap: balance; }
:lang(zh) h1 { max-width: 11em; font-size: 74px; font-stretch: 100%; font-weight: 600; letter-spacing: 0; line-height: 1.2; }
.rack { display: grid; gap: 14px; justify-items: end; padding-bottom: 8px; }
.rack div { display: flex; gap: 10px; }
.rack i { width: 46px; height: 46px; border: 4px solid ${INK}; }
.rack div:nth-child(even) i { width: 70px; height: 70px; background: ${INK}; }
footer { display: flex; white-space: nowrap; justify-content: space-between; gap: 32px; padding-top: 20px; border-top: 4px solid ${INK}; font-size: 28px; font-weight: 600; }
footer span:last-child { color: ${MUTED}; }
`;

const page = (card) => `<!doctype html><html lang="${card.lang}"><meta charset="utf-8"><style>${style}</style>
<body><p class="name">${card.name}</p>
<main><h1>${card.title}</h1><div class="rack">${card.sleeves.map((n) => `<div>${'<i></i>'.repeat(n)}</div>`).join('')}</div></main>
<footer><span>${card.line}</span><span>album.diamonddoge.org</span></footer></body></html>`;

const icon = (size) => `<!doctype html><style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden}</style>
<body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" style="display:block">${fs.readFileSync(path.join(web, 'public/favicon.svg'), 'utf8').replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')}</svg></body>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));
function shoot(html, out, width, height) {
  const source = path.join(tmp, 'page.html');
  fs.writeFileSync(source, html);
  fs.rmSync(out, { force: true });
  try {
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${width},${height}`, `--screenshot=${out}`, `file://${source}`], { stdio: 'ignore' });
  } catch (error) {
    // Chrome on macOS can exit non-zero on teardown after writing the picture.
    if (!fs.existsSync(out)) {
      throw error;
    }
  }
}
for (const card of CARDS) {
  shoot(page(card), path.join(web, 'public', card.file), 1200, 630);
}
shoot(icon(180), path.join(web, 'public/apple-touch-icon.png'), 180, 180);
shoot(icon(32), path.join(tmp, 'icon-32.png'), 32, 32);
// The .ico browsers ask for unprompted: the 32-pixel bitmap, by ffmpeg.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, 'icon-32.png'), path.join(web, 'public/favicon.ico')]);
fs.rmSync(tmp, { recursive: true, force: true });
