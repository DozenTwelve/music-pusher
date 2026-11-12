// The site as a list: where it lives, which pages it has, and the few words
// that stand around every page. Each page is an HTML file at its own address
// holding its own text; site/render.js fills in what can be worked out from
// this list (the head, the bar, the footer, the start screen, the tables).

// The one place the address is written.
export const ORIGIN = 'https://album.diamonddoge.org';
export const REPOSITORY = 'https://github.com/DozenTwelve/music-pusher';
// Who wrote the guide, as the structured data names them.
export const AUTHOR = { name: 'DozenTwelve', url: 'https://github.com/DozenTwelve' };

// The scan every claim in the guide rests on (shared/navidrome.groundtruth.js).
export const TESTED = { navidrome: '0.63.2', on: '2026-11-11' };

// `file` is the page's source, relative to web/, and where the build puts it.
// `modified` is the day its text last changed, by hand: it feeds the sitemap
// and the article's dates, and a date nobody meant is worse than an old one.
export const PAGES = [
  { file: 'index.html', path: '/', language: 'en', kind: 'home', modified: '2026-11-12' },
  { file: 'zh/index.html', path: '/zh/', language: 'zh', kind: 'home', modified: '2026-11-12' },
  { file: 'navidrome-album-split/index.html', path: '/navidrome-album-split/', language: 'en', kind: 'guide', published: '2026-11-12', modified: '2026-11-12' },
  { file: 'zh/navidrome-album-split/index.html', path: '/zh/navidrome-album-split/', language: 'zh', kind: 'guide', published: '2026-11-12', modified: '2026-11-12' },
  // Cloudflare Pages answers an unknown address with the nearest 404.html up
  // the tree, so the Chinese half of the site has its own.
  { file: '404.html', path: '/404.html', language: 'en', kind: 'missing' },
  { file: 'zh/404.html', path: '/zh/404.html', language: 'zh', kind: 'missing' }
];

// The pages a search engine is told about: every one but the 404s.
export const LISTED = PAGES.filter((page) => page.kind !== 'missing');

// The same page in the given language.
export const inLanguage = (page, language) => PAGES.find((other) => other.kind === page.kind && other.language === language);

export const WORDS = {
  en: {
    app: 'Album Cleaner',
    guide: 'Why Navidrome splits albums',
    menu: 'Site',
    language: 'Language',
    source: 'Source and self-hosted version',
    tags: 'Tags',
    taglib: 'TagLib, under the LGPL',
    licences: 'Licences',
    notice: 'TagLib notice',
    lgpl: 'LGPL 2.1',
    all: 'All licences',
    independent: 'An independent project, not affiliated with Navidrome.',
    card: 'Album Cleaner: fix an album that Navidrome shows in pieces',
    // The table of scanned cases.
    caseId: 'Case',
    caseDiffers: 'What differed between the two tracks',
    caseAlbums: 'Navidrome made',
    albums: (n) => (n === 1 ? '1 album' : `${n} albums`),
    byRule: 'by the rule, not scanned'
  },
  zh: {
    app: '专辑整理',
    guide: 'Navidrome 为什么拆专辑',
    menu: '站内',
    language: '语言',
    source: '源代码和自托管版',
    tags: '标签读写',
    taglib: 'TagLib，LGPL 许可',
    licences: '许可',
    notice: 'TagLib 声明',
    lgpl: 'LGPL 2.1',
    all: '全部许可',
    independent: '个人项目，与 Navidrome 官方无关。',
    card: '专辑整理：修好被 Navidrome 拆散的专辑',
    caseId: '编号',
    caseDiffers: '两首歌差在哪里',
    caseAlbums: 'Navidrome 认成',
    albums: (n) => `${n} 张专辑`,
    byRule: '按规则推出，没有实测'
  }
};
