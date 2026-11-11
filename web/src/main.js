// The entry: the phone screen, or the app. A phone or tablet gets one sentence
// and nothing else is fetched — not React, not the tag code, not the wasm.

import './styles.css';
import { LANGUAGES, pickLanguage, translator } from './i18n.js';

const language = pickLanguage();
document.documentElement.lang = LANGUAGES.find(({ code }) => code === language).tag;
document.title = translator(language)('app');

// Both languages, the reader's own first.
const phone = document.getElementById('phone');
for (const { code, tag } of [...LANGUAGES].sort((a) => (a.code === language ? -1 : 1))) {
  const line = phone.appendChild(document.createElement('p'));
  line.lang = tag;
  line.textContent = translator(code)('phone');
}

// The stylesheet decides who is on a phone (a coarse pointer and a narrow
// screen, never the user-agent string); this only asks whether it showed the
// phone screen.
// Asked again when the window changes, so a page that opened narrow is not
// left blank once it no longer is.
let started = false;
async function start() {
  if (!started && getComputedStyle(phone).display === 'none') {
    started = true;
    const { mount } = await import('./app.jsx');
    mount(document.getElementById('app'), language);
  }
}
start();
addEventListener('resize', start);
