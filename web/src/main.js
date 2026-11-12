// The entry of every page. Most of a page is its HTML and needs none of this;
// what is left is remembering a language link that was followed and, on a page
// with the tool on it, starting the tool. A phone or tablet gets the page to
// read and nothing more is fetched — not React, not the tag code, not the wasm.

import './styles.css';
import { saveLanguage } from './language.js';

for (const link of document.querySelectorAll('a[data-language]')) {
  link.addEventListener('click', () => saveLanguage(link.dataset.language));
}

// The stylesheet decides who is on a phone (a coarse pointer and a narrow
// screen, never the user-agent string): there it shows the sentence that sends
// the visitor to a computer, and this only asks whether it did.
// Asked again when the window changes, so a page that opened narrow gets its
// tool once it no longer is.
const app = document.getElementById('app');
let started = false;
async function start() {
  const sentToComputer = app.querySelector('.drop__phone');
  if (!started && sentToComputer && getComputedStyle(sentToComputer).display === 'none') {
    started = true;
    const { mount } = await import('./app.jsx');
    mount(app, app.dataset.language);
  }
}
if (app) {
  start();
  addEventListener('resize', start);
}
