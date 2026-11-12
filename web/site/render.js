// What a page file leaves to the build. A page (index.html at its address)
// holds its own text, its <title> and its description; the markers in it are
// filled here:
//   <!--site:head-->      canonical, the language pair, the social card, icons,
//                         structured data, the stylesheet and the script
//   <!--site:header-->    the bar: the name, the guide, the two languages
//   <!--site:tool-->      the tool's start screen, as the app itself draws it
//   <!--site:cases x-->   one table of the Navidrome scan (site/cases.js)
//   <!--site:footer-->    the small print
// Pure: a string in, a string out, so the tests can read what a crawler will.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GROUND_TRUTH, BY_RULE } from '../../shared/navidrome.groundtruth.js';
import { Arrive, Tool } from '../src/arrive.js';
import { translator } from '../src/i18n.js';
import { LANGUAGES, STORAGE_KEY } from '../src/language.js';
import { LIMITS } from '../src/limits.js';
import { CASES, GROUPS } from './cases.js';
import { AUTHOR, LISTED, ORIGIN, PAGES, REPOSITORY, WORDS, inLanguage } from './site.js';

const FONT = '/node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2';
const CARD = { width: 1200, height: 630 };

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tagOf = (language) => LANGUAGES.find(({ code }) => code === language).tag;
const absolute = (path) => ORIGIN + path;
export const cardOf = (page) => `/og/${page.kind}.${page.language}.png`;

// A visitor who once followed a language link is taken to that language when
// they open the root address again. Only a choice they made themselves does
// this — never the browser's language, never anything a crawler carries — so
// every address shows one language to whoever asks for it.
export const REMEMBERED = `try{if(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})==='zh')location.replace('/zh/'+location.search+location.hash)}catch(e){}`;

// Where the tool cannot run without scripts, its empty sleeve says so.
const NOSCRIPT = '<noscript><style>.drop__title,.pickers{display:none}.drop .drop__noscript{display:block}</style></noscript>';

function structuredData(page, { title, description }) {
  const url = absolute(page.path);
  const image = absolute(cardOf(page));
  const language = tagOf(page.language);
  const author = { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url };
  if (page.kind === 'home') {
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: WORDS[page.language].app,
        url,
        description,
        inLanguage: language,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Windows, macOS, Linux',
        browserRequirements: 'A desktop Firefox or Chrome with JavaScript on',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        image,
        author
      }
    ];
  }
  const home = inLanguage(PAGES.find((other) => other.kind === 'home'), page.language);
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: title,
      description,
      inLanguage: language,
      datePublished: page.published,
      dateModified: page.modified,
      image: [image],
      author,
      mainEntityOfPage: url
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: WORDS[page.language].app, item: absolute(home.path) },
        { '@type': 'ListItem', position: 2, name: WORDS[page.language].guide }
      ]
    }
  ];
}

function head(page, meta) {
  const words = WORDS[page.language];
  const lines = [];
  if (page.path === '/') {
    lines.push(`<script>${REMEMBERED}</script>`);
  }
  if (page.kind === 'missing') {
    lines.push('<meta name="robots" content="noindex" />');
  } else {
    const url = absolute(page.path);
    const card = absolute(cardOf(page));
    lines.push(
      '<meta name="robots" content="max-image-preview:large" />',
      `<link rel="canonical" href="${url}" />`,
      ...LANGUAGES.map(({ code, tag }) => `<link rel="alternate" hreflang="${tag}" href="${absolute(inLanguage(page, code).path)}" />`),
      `<link rel="alternate" hreflang="x-default" href="${absolute(inLanguage(page, 'en').path)}" />`,
      `<meta property="og:type" content="${page.kind === 'guide' ? 'article' : 'website'}" />`,
      `<meta property="og:site_name" content="${words.app}" />`,
      `<meta property="og:locale" content="${page.language === 'zh' ? 'zh_CN' : 'en_US'}" />`,
      `<meta property="og:url" content="${url}" />`,
      `<meta property="og:title" content="${escape(meta.title)}" />`,
      `<meta property="og:description" content="${escape(meta.description)}" />`,
      `<meta property="og:image" content="${card}" />`,
      `<meta property="og:image:width" content="${CARD.width}" />`,
      `<meta property="og:image:height" content="${CARD.height}" />`,
      `<meta property="og:image:alt" content="${escape(words.card)}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
      `<meta name="twitter:title" content="${escape(meta.title)}" />`,
      `<meta name="twitter:description" content="${escape(meta.description)}" />`,
      `<meta name="twitter:image" content="${card}" />`,
      ...structuredData(page, meta).map((data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`)
    );
  }
  lines.push(
    '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    // The one font file every page sets its first line in, asked for alongside
    // the stylesheet instead of after it.
    // (The stylesheet itself is main.js's import, which the build links here.)
    `<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin />`,
    ...(page.kind === 'home' ? [NOSCRIPT] : []),
    '<script type="module" src="/src/main.js"></script>'
  );
  return lines.join('\n    ');
}

function header(page) {
  const words = WORDS[page.language];
  const home = inLanguage(PAGES[0], page.language);
  const guide = inLanguage(PAGES.find((other) => other.kind === 'guide'), page.language);
  // A missing page has no counterpart of its own: its language links go home.
  const counterpart = (code) => inLanguage(page.kind === 'missing' ? home : page, code);
  const current = (yes, value = 'page') => (yes ? ` aria-current="${value}"` : '');
  // On the tool's own page the name is not a link: following it would throw
  // away an album that is being worked on.
  const wordmark = page.kind === 'home' ? `<p class="wordmark">${words.app}</p>` : `<a class="wordmark" href="${home.path}">${words.app}</a>`;
  return `<header class="container bar">
      ${wordmark}
      <nav class="nav" aria-label="${words.menu}">
        <a href="${guide.path}"${current(page.kind === 'guide')}>${words.guide}</a>
        <span class="switch" role="group" aria-label="${words.language}">
          ${LANGUAGES.map(({ code, tag, label }) => `<a href="${counterpart(code).path}" lang="${tag}" hreflang="${tag}" data-language="${code}"${current(code === page.language, 'true')}>${label}</a>`).join('\n          ')}
        </span>
      </nav>
    </header>`;
}

function footer(page) {
  const words = WORDS[page.language];
  return `<footer class="container">
      <div class="foot">
        <dl><dt>${words.source}</dt><dd><a href="${REPOSITORY}">GitHub</a></dd></dl>
        <dl><dt>${words.tags}</dt><dd>${words.taglib}</dd></dl>
        <dl><dt>${words.licences}</dt><dd><a href="/licenses/taglib-wasm-NOTICE.txt">${words.notice}</a> <a href="/licenses/LGPL-2.1.txt">${words.lgpl}</a> <a href="/licenses/third-party.txt">${words.all}</a></dd></dl>
      </div>
      <p class="foot__note">${words.independent}</p>
    </footer>`;
}

// The start screen exactly as the app draws it, inside the element the app
// mounts on.
function tool(page) {
  const t = translator(page.language);
  const screen = createElement(Tool, { step: 'arrive', over: false }, createElement(Arrive, { t, limit: LIMITS.album }));
  return `<div id="app" data-language="${page.language}">${renderToStaticMarkup(screen)}</div>`;
}

// One table of the scan: what differed, and how many albums Navidrome made.
// A sleeve is drawn for each album, as the tool draws them.
function cases(group, language) {
  const words = WORDS[language];
  const scanned = new Map(GROUND_TRUTH.map((entry) => [entry.id, entry]));
  const ruled = new Map(BY_RULE.map((entry) => [entry.id, entry]));
  const rows = GROUPS[group].map((id) => {
    const entry = scanned.get(id) || ruled.get(id);
    const { note, ...text } = CASES[id];
    const notes = [...(note ? [note[language]] : []), ...(ruled.has(id) ? [words.byRule] : [])];
    return `<tr${ruled.has(id) ? ' data-by-rule' : ''}>
            <th scope="row">${id}</th>
            <td>${text[language]}</td>
            <td><span class="sleeves" aria-hidden="true">${'<i></i>'.repeat(entry.albums)}</span> <span class="count">${words.albums(entry.albums)}</span>${notes.map((line) => `<small>${line}</small>`).join('')}</td>
          </tr>`;
  });
  return `<div class="cases">
        <table>
          <thead><tr><th scope="col">${words.caseId}</th><th scope="col">${words.caseDiffers}</th><th scope="col">${words.caseAlbums}</th></tr></thead>
          <tbody>
          ${rows.join('\n          ')}
          </tbody>
        </table>
      </div>`;
}

// The page's own words about itself, read back out of its file.
export function metaOf(html) {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1];
  const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { title: title && unescape(title), description: description && unescape(description) };
}

export function render(html, page) {
  const meta = metaOf(html);
  if (!meta.title || !meta.description) {
    throw new Error(`${page.file}: a page needs a <title> and a description of its own`);
  }
  return html
    // The encoding before anything else, the page's own title included.
    .replace('<head>', '<head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />')
    .replace('<!--site:head-->', () => head(page, meta))
    .replace('<!--site:header-->', () => header(page))
    .replace('<!--site:footer-->', () => footer(page))
    .replace('<!--site:tool-->', () => tool(page))
    .replace(/<!--site:cases (\w+)-->/g, (_, group) => cases(group, page.language));
}

// --- The files beside the pages ---------------------------------------------------

export function sitemap() {
  const entries = LISTED.map(
    (page) => `  <url>
    <loc>${absolute(page.path)}</loc>
    <lastmod>${page.modified}</lastmod>
${[...LANGUAGES.map(({ code, tag }) => [tag, code]), ['x-default', 'en']]
  .map(([tag, code]) => `    <xhtml:link rel="alternate" hreflang="${tag}" href="${absolute(inLanguage(page, code).path)}" />`)
  .join('\n')}
  </url>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

export function robots() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absolute('/sitemap.xml')}\n`;
}
