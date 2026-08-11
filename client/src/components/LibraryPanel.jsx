import { useState } from 'react';
import { getLibraryHealth, repairLibrary, errorMessage } from '../api.js';
import { CheckIcon, AlertIcon } from './icons.jsx';
import { Button } from './ui/button.jsx';
import { useToast } from './Toast.jsx';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent
} from './ui/accordion.jsx';

// The imported library, as beets sees it: reconcile the beets database against
// the filesystem, then repair it with `beet update`.
//
// Applying is gated behind a preview rather than a confirm dialog. The repair
// renames files — beets runs with `move: yes`, so it relocates everything onto
// its path template — and a yes/no prompt cannot say which files. The preview
// is the same command with `--pretend`, so it lists exactly that.
export default function LibraryPanel() {
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const toast = useToast();

  async function runCheck() {
    setBusy(true);
    try {
      setHealth(await getLibraryHealth());
      // A fresh reading of disk invalidates any change list taken against the
      // old one; never leave a stale preview arming the apply button.
      setPreview(null);
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function runRepair(pretend) {
    setBusy(true);
    try {
      const result = await repairLibrary(pretend);
      if (pretend) {
        setPreview(result);
        if (!result.output) {
          toast.success('Nothing to repair — beets and disk already agree.');
        }
      } else {
        setPreview(null);
        toast.success(
          `Repaired: ${result.deleted} stale row${result.deleted === 1 ? '' : 's'} dropped, surviving files moved onto the beets path template.`
        );
        setHealth(await getLibraryHealth());
      }
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

          {/* Gated on missing rows, not on `healthy`. `beet update` never imports
              files beets has not seen, so on an orphans-only library it has
              nothing to do: the preview would come back empty and report that
              database and disk agree, directly under a banner counting orphans. */}
          {totals.missing > 0 ? (
            <div>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button type="button" size="sm" onClick={() => runRepair(true)} disabled={busy}>
                  {busy ? 'Working…' : preview ? 'Refresh preview' : 'Preview repair'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => runRepair(false)}
                  disabled={busy || !preview?.output}
                >
                  Apply repair
                </Button>
                <span className="muted small flex-1 basis-full">
                  {preview?.output
                    ? 'Applying runs the same command for real: stale rows are dropped and surviving files are renamed onto the beets path template.'
                    : 'Preview first — the repair renames files, and the preview is the only place that lists which.'}
                </span>
              </div>

              {preview?.output ? (
                <Accordion type="single" collapsible className="border-t border-border">
                  <AccordionItem value="preview" className="border-b-0">
                    <AccordionTrigger>
                      Preview — {preview.deleted} row{preview.deleted === 1 ? '' : 's'} to drop
                    </AccordionTrigger>
                    <AccordionContent>
                      <pre className="terminal">{preview.output}</pre>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : null}
            </div>
          ) : null}

          <p className="muted small">
            beets database: <code>{health.dbPath}</code> · library: <code>{health.libraryDir}</code>
          </p>
        </div>
      )}
    </section>
  );
}
