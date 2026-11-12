// The start screen, and the frame the tool stands in. Written without JSX so
// that the build can render it too (site/render.js): the HTML file carries
// exactly this markup from its first byte, and when the app mounts it draws the
// same thing over it, so nothing on the page moves.

import { createElement as h, Fragment, useRef } from 'react';

// The tool's frame. `over` is a drag in progress: the whole page is the target.
export function Tool({ step, over, children }) {
  return h('div', { className: 'tool', 'data-over': over ? '' : undefined }, h('div', { className: 'container stage', 'data-step': step }, children));
}

// A sleeve: the album's cover, or whatever stands in the square without one.
export function Square({ t, cover, children }) {
  return h(
    'div',
    { className: 'square' },
    cover ? h('img', { src: cover.url, alt: t('cover.alt'), width: '360', height: '360' }) : children ?? h('p', { className: 'square__empty' }, t('cover.none'))
  );
}

export function FilePicker({ label, onFiles, className = 'button', ...input }) {
  const ref = useRef(null);
  return h(
    Fragment,
    null,
    h('button', { type: 'button', className, onClick: () => ref.current.click() }, label),
    h('input', {
      ref,
      type: 'file',
      hidden: true,
      tabIndex: -1,
      ...input,
      onChange: (event) => {
        const files = [...event.target.files];
        event.target.value = '';
        if (files.length > 0) {
          onFiles(files);
        }
      }
    })
  );
}

// `limit` is the album ceiling in bytes; `alert` whatever went wrong last time.
export function Arrive({ t, limit, over = false, alert = null, onFiles = () => {}, titleRef }) {
  return h(
    Fragment,
    null,
    h('h1', { className: 'headline', ref: titleRef, tabIndex: -1 }, t('arrive.title')),
    h(
      'div',
      { className: 'row', 'data-tiles': 'one' },
      h(
        'section',
        { className: 'rack', 'aria-label': t('arrive.drop') },
        h(
          'div',
          { className: 'tile' },
          h(
            Square,
            { t },
            h(
              'div',
              { className: 'drop' },
              h('p', { className: 'drop__title' }, t(over ? 'arrive.release' : 'arrive.drop')),
              h(
                'div',
                { className: 'pickers' },
                h(FilePicker, { className: 'link', label: t('arrive.folder'), onFiles, webkitdirectory: '' }),
                h(FilePicker, { className: 'link', label: t('arrive.zip'), onFiles, accept: '.zip,application/zip' })
              ),
              // Where the tool does not run (a phone, or no JavaScript), the
              // stylesheet shows one of these two in place of the lines above.
              h('p', { className: 'drop__phone' }, t('phone')),
              h('p', { className: 'drop__noscript' }, t('noscript'))
            )
          ),
          h('span', null, t('arrive.formats', { album: t.size(limit) }))
        )
      ),
      h(
        'div',
        { className: 'body' },
        h('ol', { className: 'steps' }, h('li', null, t('arrive.in')), h('li', null, t('arrive.fix')), h('li', null, t('arrive.out'))),
        alert,
        h('p', { className: 'promise' }, h('strong', null, t('arrive.private')), ' ', h('span', null, t('arrive.local')))
      )
    )
  );
}
