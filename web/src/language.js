// The two languages and the visitor's remembered choice between them. Each
// language has its own address (English at the root, Chinese under /zh/); the
// choice is remembered when a language link is followed, and the root address
// alone acts on it (see site/render.js). Kept apart from the sentences in
// i18n.js so that a page with no tool on it loads none of them.

export const STORAGE_KEY = 'album-cleaner-language';

// English first: it is what most visitors read, and the fallback.
export const LANGUAGES = [
  { code: 'en', tag: 'en', label: 'English', root: '/' },
  { code: 'zh', tag: 'zh-Hans', label: '中文', root: '/zh/' }
];

export function saveLanguage(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Not remembered, then.
  }
}
