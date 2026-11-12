// The tool: arrive, read, plan, clean, download. All the deciding is done in
// shared/ and album.js; this file collects the files, shows what those say, and
// keeps the user's choices.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import wasmUrl from '../node_modules/taglib-wasm/dist/taglib-web.wasm?url';
import { basename } from '../../shared/paths.js';
import { planWrites } from '../../shared/plan.js';
import { normalizeTagValue } from '../../shared/text.js';
import { asAlbum, cleanAlbum, inspect, loadCover, readAlbum, recheck, refusal, shelf, LIMITS } from './album.js';
import { Arrive, FilePicker, Square, Tool } from './arrive.js';
import { translator } from './i18n.js';
import { initTagLib } from './tags.js';
import { openZip } from './zip.js';

// An error the page has a sentence for: `code` is an `error.*` key.
class Refusal extends Error {
  constructor(code, values = {}) {
    super(code);
    this.code = code;
    this.values = values;
  }
}

// One TagLib for the visit, fetched once. Its heap only grows, so the largest
// track ever opened sets what the tab holds on to (see LIMITS).
let taglibLoading = null;
function loadTagLib() {
  taglibLoading ||= fetch(wasmUrl)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(response.statusText))))
    .then(initTagLib)
    .catch(() => {
      taglibLoading = null;
      throw new Refusal('load_failed');
    });
  return taglibLoading;
}

// --- Collecting what was dropped or picked --------------------------------------

const entryOf = (path, file) => ({
  path,
  size: file.size,
  mtime: file.lastModified,
  read: async () => new Uint8Array(await file.arrayBuffer())
});
const isZip = (file) => /\.zip$/i.test(file.name);
const isImage = (file) => /^image\//.test(file.type);

// A dropped folder arrives as a FileSystemEntry tree (webkitGetAsEntry, which
// Chrome, Firefox and Safari all have under that name).
async function walk(node, out) {
  if (node.isFile) {
    out.push(entryOf(node.fullPath.replace(/^\//, ''), await new Promise((resolve, reject) => node.file(resolve, reject))));
    return;
  }
  const reader = node.createReader();
  // readEntries hands back a batch at a time; an empty batch means done.
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) {
      return;
    }
    for (const child of batch) {
      await walk(child, out);
    }
  }
}

// Any image the browser can decode, as the JPEG every container accepts. A
// JPEG is passed through untouched.
async function toJpeg(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return bytes;
  }
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  // JPEG has no transparency; what was clear comes out white, not black.
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}
async function coverFrom(bytes) {
  const jpeg = await toJpeg(bytes);
  return { jpeg, url: URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' })) };
}

// --- Sentences ---------------------------------------------------------------------

// The verdict as its sentences: the first is the headline.
function verdictLines(t, verdict, after = false) {
  const causes = (key) => t(key, { list: t.list(verdict.causes.map((cause) => t(`cause.${cause}`))) });
  if (verdict.code === 'split') {
    return [t(after ? 'after.split' : 'verdict.split', verdict), causes(after ? 'after.causes' : 'verdict.causes')];
  }
  if (verdict.code === 'merged') {
    return verdict.reasons.map((reason) => t(`${after ? 'after' : 'verdict'}.merged.${reason}`));
  }
  if (!after || verdict.code === 'unreadable') {
    return [t(`verdict.${verdict.code}`, verdict)];
  }
  return [t('after.one', verdict), ...(verdict.code === 'no_cover' ? [t('after.no_cover', verdict)] : [])];
}

const quality = ({ sampleRate, bitDepth }) =>
  `${sampleRate / 1000} kHz${bitDepth ? ` ${bitDepth}-bit` : ''}`;

// A headline with its [[number and counted word]] pairs kept from breaking apart.
const unbroken = (line) => line.split(/\[\[(.+?)\]\]/).map((part, index) => (index % 2 ? <span className="nowrap" key={index}>{part}</span> : part));

// One thing that cannot be fixed, as a sentence and the files it is about.
function cannotLine(t, entry) {
  const files = entry.files || [];
  switch (entry.code) {
    case 'gaps':
      return entry.discs.map(({ disc, missing }) =>
        t(entry.multiDisc ? 'cannot.gaps.disc' : 'cannot.gaps', { disc, list: t('numbers', { list: missing }) })
      ).join(' ');
    case 'mixed_formats':
      return t('cannot.mixed_formats', { list: t.list(entry.formats.map((format) => format.toUpperCase())) });
    case 'mixed_quality':
      return t('cannot.mixed_quality', { list: t.list(entry.qualities.map(quality)) });
    default:
      return t(`cannot.${entry.code}`, { n: files.length });
  }
}
function fileNames(t, files) {
  const shown = files.slice(0, 3).map((file) => basename(file));
  return files.length > 3 ? `${shown.join(', ')} ${t('cannot.names', { n: files.length - 3 })}` : shown.join(', ');
}

// The shelf's rows: name, artist, and whatever tells two rows apart — the
// release date or version when those differ, and a word when nothing visible does.
function shelfRows(t, albums) {
  const differ = (key) => new Set(albums.map((album) => album[key])).size > 1;
  const rows = albums.map((album) => ({
    tracks: album.tracks,
    album: album.album ?? t('shelf.unknown_album'),
    detail: [
      album.artist ?? t('shelf.unknown_artist'),
      ...(differ('date') ? [album.date || t('shelf.no_date')] : []),
      ...(differ('version') ? [album.version || t('shelf.no_version')] : [])
    ].join(t('comma'))
  }));
  const seen = (row) => `${normalizeTagValue(row.album)}\n${normalizeTagValue(row.detail)}`.toLowerCase();
  return rows.map((row) => (rows.filter((other) => seen(other) === seen(row)).length > 1 ? { ...row, detail: `${row.detail}${t('comma')}${t('shelf.unseen')}` } : row));
}

// --- Pieces ------------------------------------------------------------------------

function Progress({ t, progress }) {
  const fraction = progress.total ? progress.done / progress.total : 0;
  return (
    <div className="progress">
      <progress aria-label={t('progress.label')} max="1" value={progress.total ? fraction : undefined} />
      <p className="progress__file">{progress.label}</p>
      <p className="visually-hidden" role="status">
        {progress.key === 'cleaning.check' ? progress.label : ''}
      </p>
    </div>
  );
}

// The rack: one sleeve for each album Navidrome would make of these tracks.
const MOST_TILES = 6;
function Rack({ t, cover, albums, caption, picker }) {
  const rows = shelfRows(t, albums);
  return (
    <figure className="rack">
      <figcaption>{caption}</figcaption>
      <ul className="tiles">
        {rows.slice(0, MOST_TILES).map((row, index) => (
          <li className="tile" key={index}>
            <Square t={t} cover={cover}>
              <div className="drop">
                <p className="square__empty">{t('cover.none')}</p>
                {index === 0 && picker}
              </div>
            </Square>
            <strong>{row.album}</strong>
            <span>{row.detail}</span>
            <span className="num">{t('shelf.tracks', { n: row.tracks })}</span>
          </li>
        ))}
      </ul>
      {rows.length > MOST_TILES && <p className="small">{t('shelf.more', { n: rows.length - MOST_TILES })}</p>}
    </figure>
  );
}

// What it was before the fix, small, beside what it is now.
function Was({ t, cover, albums }) {
  return (
    <figure className="was">
      <figcaption>{t('shelf.was', { n: albums.length })}</figcaption>
      <ul>
        {albums.slice(0, MOST_TILES).map((album, index) => (
          <li key={index}>
            <Square t={t} cover={cover}>
              <span />
            </Square>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Fix({ t, fix, coverName, example, onChange }) {
  const id = `fix-${fix.id}`;
  const names = { n: fix.renames?.length, ...fix, example };
  const sample = fix.sample || (fix.renames?.[0] && { from: basename(fix.renames[0].from), to: basename(fix.renames[0].to) });
  const hints = [];
  if (fix.found?.length > 1) {
    // The spellings as the eye tells them apart; a stray space is not one.
    const spellings = [...new Set(fix.found.map(({ value }) => normalizeTagValue(value)))];
    hints.push(
      spellings.length > 1
        ? `${t('fix.found', { n: spellings.length })} ${spellings.slice(0, 4).map((value) => `“${value}”`).join(' ')}`
        : t('fix.spacing')
    );
    if (fix.apart) {
      hints.push({ warning: t('fix.album.apart') });
    }
  }
  if (fix.guess) {
    hints.push(t('fix.album.guess'));
  }
  if ('found' in fix && !String(fix.value).trim()) {
    hints.push(t(`fix.${fix.id}.empty`));
  }
  // Shown only when the eye can tell the two apart: not for a stray space.
  if (sample && normalizeTagValue(sample.from) !== sample.to) {
    hints.push(t('fix.becomes', sample));
  }
  if (fix.id === 'cover_embed' && coverName) {
    hints.push(t('cover.guess', { name: coverName }));
  }
  return (
    <li className="fix">
      <label className="fix__toggle">
        <input type="checkbox" checked={fix.on} onChange={(event) => onChange({ on: event.target.checked })} />
        <span>{t(`fix.${fix.id}`, names)}</span>
      </label>
      {'found' in fix && (
        <label className="field" htmlFor={id}>
          <span>{t(`fix.${fix.id}.field`)}</span>
          <input
            id={id}
            type="text"
            name={fix.id}
            autoComplete="off"
            spellCheck="false"
            value={fix.value}
            disabled={!fix.on}
            aria-describedby={hints.length > 0 ? `${id}-hint` : undefined}
            onChange={(event) => onChange({ value: event.target.value })}
          />
        </label>
      )}
      {fix.options && (
        <label className="field" htmlFor={id}>
          <span>{t(`fix.${fix.id}.field`)}</span>
          <select id={id} name={fix.id} value={fix.value} disabled={!fix.on} onChange={(event) => onChange({ value: event.target.value })}>
            {fix.options.map((option) => (
              <option key={option} value={option}>
                {option || t('fix.album_version.none')}
              </option>
            ))}
          </select>
        </label>
      )}
      {hints.length > 0 && (
        <p className="fix__hint" id={`${id}-hint`}>
          {hints.map((hint) => (hint.warning ? <strong key={hint.warning}>{hint.warning}</strong> : <span key={hint}>{hint}</span>))}
        </p>
      )}
    </li>
  );
}

// A missing cover is not listed: the empty sleeve says it, and takes an image.
function CannotFix({ t, entries }) {
  const listed = entries.filter((entry) => entry.code !== 'no_cover');
  if (listed.length === 0) {
    return null;
  }
  return (
    <section className="block cannot">
      <h2>{t('cannot.title')}</h2>
      <ul className="plain">
        {listed.map((entry) => (
          <li key={entry.code}>
            {cannotLine(t, entry)}
            {entry.files?.length > 0 && <span className="files">{fileNames(t, entry.files)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- The page ----------------------------------------------------------------------

// `language` is the page's own: each language has its address, and the page
// around the tool is already written in it.
function App({ language }) {
  const t = useMemo(() => translator(language), [language]);
  const [step, setStep] = useState('arrive'); // arrive | reading | plan | cleaning | done
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, key: 'reading.start' });
  const [album, setAlbum] = useState(null);
  const [fixes, setFixes] = useState([]);
  const [result, setResult] = useState(null);
  const [over, setOver] = useState(false);
  const title = useRef(null);
  const busy = step === 'reading' || step === 'cleaning';

  // Each step opens on its headline, for a keyboard or a screen reader.
  useEffect(() => {
    if (step !== 'arrive') {
      title.current?.focus();
    }
  }, [step]);
  useEffect(() => {
    loadTagLib().catch(() => {}); // warmed up; a failure is reported when it matters
  }, []);

  const fail = (problem) => {
    setError(problem instanceof Refusal ? { code: problem.code, values: problem.values } : { code: 'unexpected', values: { message: problem.message } });
    setStep((current) => (current === 'reading' ? 'arrive' : current === 'cleaning' ? 'plan' : current));
  };
  const forget = () => {
    for (const url of [album?.cover?.url, result?.url]) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    setAlbum(null);
    setResult(null);
    setFixes([]);
  };
  const startOver = () => {
    forget();
    setError(null);
    setStep('arrive');
  };
  const report = (key) => (done, total, path) => setProgress({ done, total, key, name: basename(path) });

  // `source` is a zip File, or the entries of a dropped or picked folder.
  async function take(source) {
    forget();
    setError(null);
    setProgress({ done: 0, total: 0, key: 'reading.start' });
    setStep('reading');
    try {
      const taglib = await loadTagLib();
      const zip = source instanceof File ? await openZip(source).catch(() => Promise.reject(new Refusal('zip_bad'))) : null;
      const { name, guess, entries } = asAlbum(zip ? zip.entries : source, zip ? source.name.replace(/\.zip$/i, '') : '');
      const refused = refusal(entries);
      if (refused) {
        const { code, ...values } = refused;
        throw new Refusal(code, { ...values, size: t.size(values.size || 0), limit: t.size(values.limit || 0) });
      }
      const read = await readAlbum(taglib, entries, report('reading.file'));
      const inspected = inspect(name, read, entries, { nameGuess: guess });
      const picture = await loadCover(taglib, entries, inspected.cover).catch(() => null);
      const cover = picture ? await coverFrom(picture.data).catch(() => null) : null;
      setAlbum({ name, guess, entries, read, inspected, cover, encoding: zip && zip.encoding !== 'utf-8' ? { name: zip.encoding } : null });
      setFixes(inspected.fixes);
      setStep('plan');
    } catch (problem) {
      fail(problem);
    }
  }

  async function takeFiles(files) {
    if (busy) {
      return;
    }
    if (files.length === 1 && isZip(files[0])) {
      await take(files[0]);
    } else {
      await take(files.map((file) => entryOf(file.webkitRelativePath || file.name, file)));
    }
  }

  // The user's own image, when the album has none: the plan is made again
  // around it, keeping what was already switched and typed.
  async function addCover(file) {
    try {
      const cover = await coverFrom(new Uint8Array(await file.arrayBuffer())).catch(() => Promise.reject(new Refusal('bad_image')));
      const inspected = inspect(album.name, album.read, album.entries, { nameGuess: album.guess, hasUserCover: true });
      setError(null);
      setAlbum({ ...album, inspected, cover });
      setFixes(inspected.fixes.map((fix) => ({ ...fix, ...fixes.find((old) => old.id === fix.id) })));
    } catch (problem) {
      fail(problem);
    }
  }

  async function clean() {
    setError(null);
    setProgress({ done: 0, total: 0, key: 'reading.start' });
    setStep('cleaning');
    try {
      const taglib = await loadTagLib();
      const { blob, changed, failed } = await cleanAlbum(taglib, album.entries, album.inspected, fixes, album.cover?.jpeg, report('cleaning.file'));
      setProgress({ done: 0, total: 0, key: 'cleaning.check' });
      const after = await recheck(taglib, blob, album.name);
      setResult({ url: URL.createObjectURL(blob), size: blob.size, changed, failed, after });
      setStep('done');
    } catch (problem) {
      fail(problem);
    }
  }

  // The whole page takes a drop. Kept in a ref so the listeners, attached once,
  // always act on the present step.
  const onDrop = useRef(null);
  onDrop.current = async (event) => {
    setOver(false);
    if (busy) {
      return;
    }
    // Entries must be taken before the first await: the item list dies with the event.
    const nodes = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    const files = [...event.dataTransfer.files];
    if (step === 'plan' && !album.cover && files.length === 1 && isImage(files[0])) {
      return addCover(files[0]);
    }
    // A zip or loose files: the File objects are all there is to know.
    if (!nodes.some((node) => node.isDirectory)) {
      return takeFiles(files);
    }
    const found = [];
    try {
      for (const node of nodes) {
        await walk(node, found);
      }
    } catch (problem) {
      return fail(problem);
    }
    return take(found);
  };
  useEffect(() => {
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    const enter = (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        setOver(true);
      }
    };
    const leave = (event) => {
      if (!event.relatedTarget) {
        setOver(false);
      }
    };
    const drop = (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        onDrop.current(event);
      }
    };
    document.addEventListener('dragover', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragover', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', drop);
    };
  }, []);

  const change = (id) => (patch) => setFixes(fixes.map((fix) => (fix.id === id ? { ...fix, ...patch } : fix)));
  const alert = error && (
    <p className="alert" role="alert">
      {t(`error.${error.code}`, error.values)}
    </p>
  );
  const running = { ...progress, label: t(progress.key, progress) };

  let main;
  if (step === 'arrive') {
    main = <Arrive t={t} limit={LIMITS.album} over={over} alert={alert} onFiles={takeFiles} titleRef={title} />;
  } else if (busy) {
    main = (
      <>
        <h1 className="headline" ref={title} tabIndex={-1}>
          {t(`${step}.title`)}
        </h1>
        <div className="row" data-tiles="one">
          <div className="rack">
            <Square t={t} cover={album?.cover}>
              <span />
            </Square>
          </div>
          <div className="body">
            <Progress t={t} progress={running} />
          </div>
        </div>
      </>
    );
  } else if (step === 'plan') {
    const { verdict, cannotFix, cover } = album.inspected;
    const [headline, ...rest] = verdictLines(t, { ...verdict, fixes: fixes.length });
    const cannot = [...cannotFix, ...(album.read.unsupported.length > 0 ? [{ code: 'unsupported', files: album.read.unsupported }] : [])];
    const albums = shelf(album.read.tracks);
    const anyOn = fixes.some((fix) => fix.on);
    const listed = cannot.some((entry) => entry.code !== 'no_cover');
    // The example in the track-number row is one this album will really get: its third, where it has one.
    const numbers = planWrites(album.inspected.report, album.read.tracks, [{ id: 'track_numbers', on: true }], album.inspected.context).files;
    const numbered = numbers[Math.min(2, numbers.length - 1)]?.set.TRACKNUMBER;
    main = (
      <>
        <h1 className="headline" ref={title} tabIndex={-1}>
          {unbroken(headline)}
        </h1>
        {rest.map((line) => (
          <p className="lead" key={line}>
            {unbroken(line)}
          </p>
        ))}
        {album.encoding && (
          <p className="warning">
            {album.encoding.name
              ? t('encoding.guessed', { encoding: album.encoding.name.toUpperCase().replace('_', ' '), sample: basename(album.read.tracks[0]?.file || album.entries[0].path) })
              : t('encoding.unknown')}
          </p>
        )}
        {alert}
        <div className="row" data-tiles={albums.length > 1 ? 'many' : 'one'}>
          <Rack
            t={t}
            cover={album.cover}
            albums={albums}
            caption={t('shelf.before')}
            picker={<FilePicker className="link" label={t('cover.add')} onFiles={([file]) => addCover(file)} accept="image/*" />}
          />
          <div className={listed ? 'body' : 'body body--wide'}>
            <div className="actions">
              {fixes.length > 0 && (
                <button type="button" className="button button--primary" disabled={!anyOn} aria-describedby={anyOn ? undefined : 'nothing-on'} onClick={clean}>
                  {t('action.clean')}
                </button>
              )}
              <button type="button" className="button" onClick={startOver}>
                {t('action.another')}
              </button>
            </div>
            {fixes.length > 0 && !anyOn && (
              <p className="small" id="nothing-on">
                {t('plan.none')}
              </p>
            )}
            {fixes.length > 0 && (
              <section className="block">
                <h2>{t('plan.title')}</h2>
                <ul className="fixes">
                  {fixes.map((fix) => (
                    <Fix key={fix.id} t={t} fix={fix} coverName={cover?.guess ? basename(cover.path) : null} example={numbered} onChange={change(fix.id)} />
                  ))}
                </ul>
              </section>
            )}
          </div>
          <CannotFix t={t} entries={cannot} />
        </div>
      </>
    );
  } else {
    const { after, changed, failed } = result;
    const [headline, ...rest] = verdictLines(t, after.verdict, true);
    const hasCover = after.album.tracks.some((track) => track.hasArt) || after.cover;
    const before = shelf(album.read.tracks);
    const albums = shelf(after.album.tracks);
    const left = [...after.cannotFix, ...(after.album.unsupported.length > 0 ? [{ code: 'unsupported', files: after.album.unsupported }] : [])];
    const listed = left.some((entry) => entry.code !== 'no_cover');
    main = (
      <>
        <h1 className="headline" ref={title} tabIndex={-1}>
          {unbroken(headline)}
        </h1>
        {rest.map((line) => (
          <p className="lead" key={line}>
            {unbroken(line)}
          </p>
        ))}
        <div className="row" data-tiles={albums.length > 1 ? 'many' : 'one'}>
          <Rack t={t} cover={hasCover ? album.cover : null} albums={albums} caption={t('shelf.after')} />
          <div className={listed ? 'body' : 'body body--wide'}>
            <div className="actions">
              <a className="button button--primary" href={result.url} download={`${album.name}.zip`}>
                {t('action.download')}
                <span className="button__meta num">{t.size(result.size)}</span>
              </a>
              <button type="button" className="button" onClick={startOver}>
                {t('action.again')}
              </button>
            </div>
            <ul className="plain">
              <li>{t('done.next')}</li>
              <li>{t('after.proof')}</li>
              <li>{t('done.changed', { n: changed })}</li>
              {failed.length > 0 && (
                <li>
                  {t('done.failed', { n: failed.length })}
                  <span className="files">{fileNames(t, failed)}</span>
                </li>
              )}
            </ul>
            {before.length !== albums.length && <Was t={t} cover={album.cover} albums={before} />}
          </div>
          <CannotFix t={t} entries={left} />
        </div>
      </>
    );
  }

  return (
    <Tool step={step} over={over && !busy}>
      {main}
    </Tool>
  );
}

export function mount(element, language) {
  createRoot(element).render(<App language={language} />);
}
