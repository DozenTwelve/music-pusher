// The pages as a crawler reads them: site/render.js's output for every page
// file, read without a browser. What a page says must be in its HTML; every
// address it points to must exist; the two languages must have the same pages;
// and the sitemap must list exactly the pages there are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { GROUND_TRUTH, BY_RULE } from '../shared/navidrome.groundtruth.js';
import { translator } from './src/i18n.js';
import { LIMITS } from './src/limits.js';
import { CASES, GROUPS } from './site/cases.js';
import { cardOf, render, robots, sitemap } from './site/render.js';
import { LISTED, ORIGIN, PAGES, inLanguage } from './site/site.js';

const web = path.dirname(fileURLToPath(import.meta.url));
const rendered = new Map(PAGES.map((page) => [page, render(fs.readFileSync(path.join(web, page.file), 'utf8'), page)]));

const all = (html, re) => [...html.matchAll(re)];
const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
const unescape = (text) => text.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// The text a reader gets: no head, no scripts, no tags.
const textOf = (html) =>
  unescape(
    html
      .replace(/<head>[\s\S]*?<\/head>/, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ');

// Files the built site serves next to the pages: public/, the licences the
// build emits, the sitemap and robots.txt; and, in the source, what Vite
// rewrites into the build (the entry script, the preloaded font).
function served(address) {
  const clean = decodeURIComponent(address.split(/[?#]/)[0]);
  if (PAGES.some((page) => page.path === clean)) {
    return true;
  }
  if (['/sitemap.xml', '/robots.txt', '/licenses/taglib-wasm-NOTICE.txt', '/licenses/LGPL-2.1.txt', '/licenses/third-party.txt'].includes(clean)) {
    return true;
  }
  return [path.join(web, 'public', clean), path.join(web, clean)].some((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

for (const [page, html] of rendered) {
  test(`${page.file}: one h1, a title and a description, every marker filled`, () => {
    assert.equal(all(html, /<h1[\s>]/g).length, 1);
    assert.equal(html.includes('<!--site:'), false);
    assert.equal(all(html, /<title>/g).length, 1);
    assert.equal(all(html, /<meta name="description"/g).length, 1);
    const title = /<title>([^<]*)<\/title>/.exec(html)[1];
    const description = unescape(/<meta name="description" content="([^"]*)"/.exec(html)[1]);
    // Lengths a result page shows whole, or nearly: wide characters count double.
    const width = (text) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    assert.ok(width(title) <= 70, `title is ${width(title)} wide: ${title}`);
    assert.ok(width(description) <= 200, `description is ${width(description)} wide`);
    if (page.kind !== 'missing') {
      assert.ok(width(description) >= 100, `description is ${width(description)} wide`);
    }
    // The encoding comes before any text.
    assert.ok(html.indexOf('<meta charset="utf-8" />') < html.indexOf('<title>'));
    assert.equal(/<html lang="([^"]+)"/.exec(html)[1], page.language === 'zh' ? 'zh-Hans' : 'en');
  });

  test(`${page.file}: every internal address it points to is served`, () => {
    const ids = new Set(all(html, /\sid="([^"]+)"/g).map((match) => match[1]));
    for (const [, address] of all(html, /(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:)?\/\//.test(address)) {
        continue;
      }
      if (address.startsWith('#')) {
        assert.ok(ids.has(address.slice(1)), `${address} has no target`);
        continue;
      }
      assert.ok(address.startsWith('/'), `${address} is relative; the pages sit at different depths`);
      assert.ok(served(address), `${address} is not served`);
    }
    // Outbound: only the repository and Navidrome's own site.
    for (const [, address] of all(html, /href="(https?:\/\/[^"]+)"/g)) {
      assert.match(address, /^https:\/\/(album\.diamonddoge\.org|github\.com\/DozenTwelve|www\.navidrome\.org)\//, address);
    }
    // Nothing is fetched from anywhere else: no script, image, style or font.
    for (const [, address] of all(html, /<(?:script|img|iframe|link(?![^>]*rel="(?:canonical|alternate)"))[^>]*(?:src|href)="(https?:\/\/[^"]+)"/g)) {
      assert.fail(`${address} would be fetched from elsewhere`);
    }
  });

  if (page.kind === 'missing') {
    test(`${page.file}: kept out of the index, and not in the sitemap`, () => {
      assert.match(html, /<meta name="robots" content="noindex" \/>/);
      assert.equal(html.includes('rel="canonical"'), false);
      assert.equal(LISTED.includes(page), false);
    });
    continue;
  }

  test(`${page.file}: canonical, the language pair, the card and the structured data`, () => {
    const url = ORIGIN + page.path;
    assert.deepEqual(all(html, /<link rel="canonical" href="([^"]+)"/g).map((m) => m[1]), [url]);
    const alternates = Object.fromEntries(all(html, /<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g).map((m) => [m[1], m[2]]));
    assert.deepEqual(alternates, {
      en: ORIGIN + inLanguage(page, 'en').path,
      'zh-Hans': ORIGIN + inLanguage(page, 'zh').path,
      'x-default': ORIGIN + inLanguage(page, 'en').path
    });
    // The pair points back: the other page names this one under this language.
    const other = inLanguage(page, page.language === 'en' ? 'zh' : 'en');
    assert.match(rendered.get(other), new RegExp(`hreflang="${page.language === 'en' ? 'en' : 'zh-Hans'}" href="${url}"`));
    for (const property of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type']) {
      assert.match(html, new RegExp(`<meta property="${property}" content="[^"]+"`), property);
    }
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
    assert.ok(fs.existsSync(path.join(web, 'public', cardOf(page))), cardOf(page));
    const data = all(html, /<script type="application\/ld\+json">([^<]*)<\/script>/g).map((m) => JSON.parse(m[1]));
    assert.deepEqual(data.map((item) => item['@type']), page.kind === 'home' ? ['WebApplication'] : ['Article', 'BreadcrumbList']);
    for (const item of data) {
      assert.equal(item['@context'], 'https://schema.org');
    }
    if (page.kind === 'guide') {
      const [article] = data;
      assert.equal(article.headline, /<title>([^<]*)<\/title>/.exec(html)[1]);
      assert.match(article.datePublished, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(article.dateModified, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(article.mainEntityOfPage, url);
    } else {
      assert.equal(data[0].offers.price, '0');
    }
  });
}

test('the home pages carry the tool’s start screen in their HTML', () => {
  for (const page of PAGES.filter((candidate) => candidate.kind === 'home')) {
    const translate = translator(page.language);
    const text = textOf(rendered.get(page));
    const t = (key, values) => translate(key, values).replace(/\s+/g, ' ');
    for (const key of ['arrive.title', 'arrive.drop', 'arrive.in', 'arrive.fix', 'arrive.out', 'arrive.private', 'arrive.local', 'phone']) {
      assert.ok(text.includes(t(key)), `${page.file}: ${key}`);
    }
    assert.ok(text.includes(t('arrive.formats', { album: translate.size(LIMITS.album) })), `${page.file}: formats`);
    assert.match(rendered.get(page), new RegExp(`<div id="app" data-language="${page.language}">`));
  }
});

// The one script in a page's head, run as a browser would with what the visitor
// remembered (or nothing, or storage that throws) and the browser's languages.
// -> where it sends them, or null for staying.
function arrive(html, { stored, languages, language = languages?.[0], storage = true }) {
  const [, script] = /<head>[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html) || [];
  if (!script) {
    return null;
  }
  let sent = null;
  const localStorage = {
    getItem: () => {
      if (!storage) {
        throw new Error('SecurityError');
      }
      return stored ?? null;
    }
  };
  const location = { search: '?a=1', hash: '#b', replace: (to) => (sent = to) };
  vm.runInNewContext(script, { localStorage, location, navigator: { languages, language } });
  return sent;
}

test('the root sends a visitor to Chinese by their own choice, else by the browser; no other address moves', () => {
  const root = rendered.get(PAGES.find((page) => page.path === '/'));
  const cases = [
    [{ stored: 'zh', languages: ['en-US'] }, '/zh/?a=1#b'],
    [{ stored: 'en', languages: ['zh-CN', 'zh'] }, null],
    [{ languages: ['zh-CN', 'en'] }, '/zh/?a=1#b'],
    [{ languages: ['zh-TW'] }, '/zh/?a=1#b'],
    [{ languages: ['ja', 'zh-Hans', 'en'] }, '/zh/?a=1#b'],
    [{ languages: ['en-GB', 'zh-CN'] }, null],
    [{ languages: ['fr', 'de'] }, null],
    [{ languages: undefined, language: 'zh-CN' }, '/zh/?a=1#b'],
    [{ stored: 'xx', languages: ['zh-CN'] }, '/zh/?a=1#b'],
    // No storage: a click on English could not be remembered, so the browser cannot overrule it.
    [{ storage: false, languages: ['zh-CN'] }, null],
    [{ storage: false, languages: ['en-US'] }, null]
  ];
  for (const [visitor, expected] of cases) {
    assert.equal(arrive(root, visitor), expected, JSON.stringify(visitor));
  }
  for (const page of PAGES.filter((candidate) => candidate.path !== '/')) {
    assert.equal(arrive(rendered.get(page), { languages: ['zh-CN'] }), null, page.file);
    assert.equal(arrive(rendered.get(page), { stored: 'en', languages: ['zh-CN'] }), null, page.file);
  }
  // Both links of the switch are the ones main.js remembers a click on.
  for (const page of PAGES) {
    const links = all(rendered.get(page), /<a [^>]*data-language="(\w+)"/g).map((match) => match[1]);
    assert.deepEqual(links.sort(), ['en', 'zh'], page.file);
  }
});

test('sizes read in a unit that shows them: a small zip is not “0 MB”', () => {
  const en = translator('en');
  const zh = translator('zh');
  // The space before the unit does not break.
  const sizes = [[2.6e9, '2.6 GB'], [80e6, '80 MB'], [1.5e6, '1.5 MB'], [999_000, '999 KB'], [42_000, '42 KB'], [300, '0.3 KB']];
  for (const [bytes, shown] of sizes) {
    assert.equal(en.size(bytes), shown.replace(' ', '\u00a0'));
  }
  assert.equal(zh.size(42_000), '42\u00a0KB');
});

test('the guide shows every case of the scan once, with the count Navidrome gave', () => {
  const grouped = Object.values(GROUPS).flat();
  const cases = [...GROUND_TRUTH, ...BY_RULE];
  assert.deepEqual([...grouped].sort(), cases.map((entry) => entry.id).sort());
  assert.deepEqual(Object.keys(CASES).sort(), [...grouped].sort());
  for (const page of PAGES.filter((candidate) => candidate.kind === 'guide')) {
    const html = rendered.get(page);
    // Every group the guide has a table for is placed exactly once.
    const rows = all(html, /<tr(?: data-by-rule)?>\s*<th scope="row">(\w+)<\/th>[\s\S]*?<span class="sleeves" aria-hidden="true">((?:<i><\/i>)*)<\/span>/g);
    assert.deepEqual(rows.map((row) => row[1]).sort(), [...grouped].sort(), page.file);
    for (const [row, id, sleeves] of rows) {
      const entry = cases.find((candidate) => candidate.id === id);
      assert.equal(sleeves.length / '<i></i>'.length, entry.albums, `${page.file} ${id}`);
      assert.equal(row.startsWith('<tr data-by-rule>'), BY_RULE.includes(entry), `${page.file} ${id} marked`);
    }
    // What the guide says it was tested on.
    assert.ok(textOf(html).includes('0.63.2'));
  }
});

test('the two languages have the same pages, the same sections in the same order', () => {
  const kinds = new Set(PAGES.map((page) => page.kind));
  for (const kind of kinds) {
    const [en, zh] = ['en', 'zh'].map((language) => PAGES.find((page) => page.kind === kind && page.language === language));
    assert.ok(en && zh, kind);
    const outline = (html) => all(html, /<(h[1-3]|section|table|pre|li)\b[^>]*?(?:\sid="([^"]*)")?[^>]*>/g).map((m) => `${m[1]}#${m[2] || ''}`);
    assert.deepEqual(outline(rendered.get(zh)), outline(rendered.get(en)), kind);
  }
});

test('the sitemap lists every page there is, with its language pair, and no 404', () => {
  const xml = sitemap();
  const urls = all(xml, /<url>([\s\S]*?)<\/url>/g).map((m) => m[1]);
  assert.deepEqual(
    urls.map((block) => /<loc>([^<]+)<\/loc>/.exec(block)[1]),
    LISTED.map((page) => ORIGIN + page.path)
  );
  urls.forEach((block, index) => {
    const page = LISTED[index];
    assert.match(block, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    const links = Object.fromEntries(all(block, /hreflang="([^"]+)" href="([^"]+)"/g).map((m) => [m[1], m[2]]));
    assert.deepEqual(links, {
      en: ORIGIN + inLanguage(page, 'en').path,
      'zh-Hans': ORIGIN + inLanguage(page, 'zh').path,
      'x-default': ORIGIN + inLanguage(page, 'en').path
    });
  });
  assert.equal(xml.includes('404'), false);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9" xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml">/);
});

test('robots.txt allows everything and names the sitemap by its full address', () => {
  assert.equal(robots(), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
});

test('the address of the site is written in one place', () => {
  const sources = ['index.html', 'zh/index.html', 'navidrome-album-split/index.html', 'zh/navidrome-album-split/index.html', '404.html', 'zh/404.html', 'site/render.js', 'vite.config.js'];
  for (const file of sources) {
    assert.equal(fs.readFileSync(path.join(web, file), 'utf8').includes('album.diamonddoge.org'), false, file);
  }
});
