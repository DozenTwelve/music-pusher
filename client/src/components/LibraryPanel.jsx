import { useState } from 'react';
import { getLibraryHealth, errorMessage } from '../api.js';
import { CheckIcon, AlertIcon } from './icons.jsx';
import { Button } from './ui/button.jsx';
import { useToast } from './Toast.jsx';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent
} from './ui/accordion.jsx';

// The imported library, as beets sees it. This first pass only reconciles the
// beets database against the filesystem — it reports, it never repairs, because
// each repair (beet update / beet remove / re-import) destroys something
// different and has to be picked per album.
export default function LibraryPanel() {
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function runCheck() {
    setBusy(true);
    try {
      setHealth(await getLibraryHealth());
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  const totals = health?.totals;
  const healthy = totals && totals.missing === 0 && totals.orphans === 0;

  return (
    <section className="library panel">
      <div className="section-header">
        <div className="card-heading">
          <h2>Library</h2>
          <span className="card-eyebrow">
            {totals
              ? `${totals.items} tracks tracked by beets · ${totals.filesOnDisk} audio files on disk`
              : 'Imported albums, as beets sees them'}
          </span>
        </div>
        <Button type="button" size="sm" onClick={runCheck} disabled={busy}>
          {busy ? 'Checking…' : health ? 'Re-check' : 'Check library'}
        </Button>
      </div>

      {!health ? (
        <p className="muted">
          Compares every track in the beets database against the files actually on disk, in both
          directions. Read-only — nothing is changed.
        </p>
      ) : (
        <div className="report">
          <div className={`report-banner ${healthy ? 'good' : 'bad'}`}>
            {healthy ? <CheckIcon /> : <AlertIcon />}
            <span>
              {healthy
                ? `Database and disk agree — all ${totals.items} tracks accounted for.`
                : `${totals.missing} of ${totals.items} tracks point at files that no longer exist, across ${totals.albumsAffected} album${totals.albumsAffected === 1 ? '' : 's'}.`}
            </span>
          </div>

          {totals.missingOutside > 0 ? (
            <div className="report-banner warn">
              <AlertIcon />
              <span>
                {totals.missingOutside} of those sit outside the current library folder (
                <code>{health.libraryDir}</code>) — they predate a move of the beets{' '}
                <code>directory:</code> setting, so their whole tree is gone rather than the
                individual files. These rows can only be re-imported or removed from the database.
              </span>
            </div>
          ) : null}

          {totals.missingInside > 0 ? (
            <div className="report-banner warn">
              <AlertIcon />
              <span>
                {totals.missingInside} sit inside the current library folder but are gone from disk —
                renamed, moved or deleted behind beets' back. <code>beet update</code> can re-find
                these if the files still exist somewhere under the library.
              </span>
            </div>
          ) : null}

          {totals.orphans > 0 ? (
            <div className="report-banner warn">
              <AlertIcon />
              <span>
                {totals.orphans} audio file{totals.orphans === 1 ? '' : 's'} on disk that no beets
                record points at. Navidrome may well be showing these; beets cannot manage them
                until they are imported.
              </span>
            </div>
          ) : null}

          {health.albums.length ? (
            <Accordion type="single" collapsible className="border-t border-border">
              <AccordionItem value="missing">
                <AccordionTrigger>
                  Albums with missing files ({totals.albumsAffected})
                </AccordionTrigger>
                <AccordionContent>
                  <table className="field-table">
                    <thead>
                      <tr>
                        <th>Album</th>
                        <th>Album artist</th>
                        <th>Missing</th>
                        <th>Where</th>
                      </tr>
                    </thead>
                    <tbody>
                      {health.albums.map((entry) => (
                        <tr key={entry.albumId ?? entry.album} className="row-bad">
                          <td>{entry.album}</td>
                          <td>{entry.albumartist || '—'}</td>
                          <td>{entry.missing}</td>
                          <td>{entry.outside ? 'old library path' : 'current library'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {health.albumsTruncated ? (
                    <p className="muted small">…and {health.albumsTruncated} more.</p>
                  ) : null}
                </AccordionContent>
              </AccordionItem>

              {health.orphans.length ? (
                <AccordionItem value="orphans" className="border-b-0">
                  <AccordionTrigger>Files beets does not know ({totals.orphans})</AccordionTrigger>
                  <AccordionContent>
                    <ul className="list-disc space-y-1 pl-5">
                      {health.orphans.map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                    {health.orphansTruncated ? (
                      <p className="muted small">…and {health.orphansTruncated} more.</p>
                    ) : null}
                  </AccordionContent>
                </AccordionItem>
              ) : null}
            </Accordion>
          ) : null}

          <p className="muted small">
            beets database: <code>{health.dbPath}</code> · library: <code>{health.libraryDir}</code>
          </p>
        </div>
      )}
    </section>
  );
}
