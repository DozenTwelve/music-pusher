import { useState } from 'react';
import {
  getLibraryHealth,
  getLibraryAlbums,
  restageLibraryAlbum,
  repairLibrary,
  errorMessage
} from '../api.js';
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
// the filesystem, then repair it with `beet update` followed by `beet move`.
//
// Applying is gated behind a preview rather than a confirm dialog. The repair
// renames files — beets runs with `move: yes`, so it relocates everything onto
// its path template — and a yes/no prompt cannot say which files. The preview
// is the same command with `--pretend`, so it lists exactly that.
export default function LibraryPanel({ onRestaged }) {
  const [health, setHealth] = useState(null);
  const [albums, setAlbums] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const toast = useToast();

  async function runCheck() {
    setBusy(true);
    try {
      // Both readings come off the same press: they answer the same question in
      // two directions, and a user who wants one has no reason to want the
      // other a click later.
      const [nextHealth, nextAlbums] = await Promise.all([getLibraryHealth(), getLibraryAlbums()]);
      setHealth(nextHealth);
      setAlbums(nextAlbums);
      // A fresh reading of disk invalidates any change list taken against the
      // old one; never leave a stale preview arming the apply button.
      setPreview(null);
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  // Moving an album back to RAW is the way out for one that imported as-is:
  // from there the ordinary analyze → fix → pick a release → import path runs
  // over it like any freshly uploaded folder.
  async function restage(entry) {
    setBusy(true);
    try {
      const result = await restageLibraryAlbum(entry.id);
      toast.success(
        `“${result.albumTitle}” (${result.tracks} tracks) is back in RAW as “${result.album}”. ` +
          'Select it above to analyze and import it again.'
      );
      const [nextHealth, nextAlbums] = await Promise.all([getLibraryHealth(), getLibraryAlbums()]);
      setHealth(nextHealth);
      setAlbums(nextAlbums);
      setPreview(null);
      onRestaged?.();
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
        // Judged on the counts, not on whether beets printed anything: `beet
        // move` always reports, even when it is "Moving 0 items".
        if (!result.deleted && !result.moved) {
          toast.success('Nothing to repair — beets and disk already agree.');
        }
      } else {
        setPreview(null);
        toast.success(
          `Repaired: ${result.deleted} stale row${result.deleted === 1 ? '' : 's'} dropped, ${result.moved} file${result.moved === 1 ? '' : 's'} moved onto the beets path template.`
        );
        setHealth(await getLibraryHealth());
      }
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  // An album beets matched has already been corrected against a real release,
  // so it is not what this section is for — only the ones it gave up on and
  // filed as they arrived.
  const unmatched = (albums || []).filter((entry) => !entry.matched);
  const untitledAlbums = unmatched.filter((entry) => entry.untitled > 0);

  const totals = health?.totals;
  const healthy = totals && totals.missing === 0 && totals.orphans === 0;
  // A preview that found nothing must not arm Apply. beets still prints a line
  // in that case ("Moving 0 items"), so the counts are the only honest signal.
  const hasRepairWork = Boolean(preview && (preview.deleted || preview.moved));

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
          {/* Three states, not two. Orphans alone used to fall through to the
              "missing files" wording and render it with zeroes: "0 of 478 tracks
              point at files that no longer exist, across 0 albums." */}
          <div className={`report-banner ${totals.missing > 0 ? 'bad' : healthy ? 'good' : 'warn'}`}>
            {healthy ? <CheckIcon /> : <AlertIcon />}
            <span>
              {totals.missing > 0
                ? `${totals.missing} of ${totals.items} tracks point at files that no longer exist, across ${totals.albumsAffected} album${totals.albumsAffected === 1 ? '' : 's'}.`
                : healthy
                  ? `Database and disk agree — all ${totals.items} tracks accounted for.`
                  : `Every one of the ${totals.items} tracks beets knows about is present. What is left is the other direction: audio on disk beets has never seen.`}
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

          {/* The other kind of unhealthy: every file present and accounted for,
              and nothing in the album corrected. Kept separate from the
              missing-file sections because the repair is different — these need
              re-importing against a named release, not `beet update`. */}
          {unmatched.length ? (
            <>
              <div className="report-banner warn">
                <AlertIcon />
                <span>
                  {unmatched.length} of {albums.length} albums were imported without a MusicBrainz
                  match, so their tags are still whatever the files arrived with.
                  {untitledAlbums.length
                    ? ` ${untitledAlbums.length} of those also have tracks with no title at all.`
                    : ''}{' '}
                  Restaging moves an album back to RAW so it can be analyzed, fixed and imported
                  again against a release you pick. Files are moved, never copied or deleted.
                </span>
              </div>

              <Accordion type="single" collapsible className="border-t border-border">
                <AccordionItem value="unmatched">
                  <AccordionTrigger>Albums beets never matched ({unmatched.length})</AccordionTrigger>
                  <AccordionContent>
                    <table className="field-table">
                      <thead>
                        <tr>
                          <th>Album</th>
                          <th>Album artist</th>
                          <th>Tracks</th>
                          <th>Untitled</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {unmatched.map((entry) => (
                          <tr key={entry.id} className={entry.untitled ? 'row-bad' : ''}>
                            <td>{entry.album || '(no album)'}</td>
                            <td>{entry.albumartist || '—'}</td>
                            <td>{entry.tracks}</td>
                            <td>{entry.untitled || '—'}</td>
                            <td>
                              {/* An album whose files are spread over several
                                  folders cannot be moved as one, and the server
                                  refuses it. Say so here rather than offering a
                                  button that only reports the refusal. */}
                              {entry.dir ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => restage(entry)}
                                  disabled={busy}
                                >
                                  Restage to RAW
                                </Button>
                              ) : (
                                <span className="muted small">spread across folders</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </>
          ) : null}

          {/* Both sections are independent: a library can have orphans and no
              missing rows, which used to hide the orphan list entirely because
              the whole accordion hung off `albums.length`. */}
          {health.albums.length || health.orphans.length ? (
            <Accordion type="single" collapsible className="border-t border-border">
              {health.albums.length ? (
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
              ) : null}

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

          {/* Always offered, because only the preview can tell whether there is
              work to do. Gating on `totals.missing` was wrong in both
              directions: the repair also relocates files whose path no longer
              matches the template, which happens with zero missing rows — an
              album left holding a stale `%aunique{}` suffix after the duplicate
              it was disambiguating against was dropped. The preview is
              read-only and Apply stays disabled until it comes back with
              something, so an empty one costs a click. */}
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
                  disabled={busy || !hasRepairWork}
                >
                  Apply repair
                </Button>
                <span className="muted small flex-1 basis-full">
                  {hasRepairWork
                    ? 'Applying runs the same two commands for real: `beet update` drops rows whose file is gone, then `beet move` renames what no longer matches the beets path template.'
                    : 'Preview first — the repair renames files, and the preview is the only place that lists which.'}
                </span>
              </div>

              {preview?.output ? (
                <Accordion type="single" collapsible className="border-t border-border">
                  <AccordionItem value="preview" className="border-b-0">
                    {/* Both numbers. Labelling this with the drop count alone hid
                        the only pending work whenever a library had files to
                        relocate and no dead rows left — which is the state a
                        library lands in after its first repair. */}
                    <AccordionTrigger>
                      Preview — {preview.deleted} row{preview.deleted === 1 ? '' : 's'} to drop,{' '}
                      {preview.moved} file{preview.moved === 1 ? '' : 's'} to move
                    </AccordionTrigger>
                    <AccordionContent>
                      <pre className="terminal">{preview.output}</pre>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : null}
          </div>

          <p className="muted small">
            beets database: <code>{health.dbPath}</code> · library: <code>{health.libraryDir}</code>
          </p>
        </div>
      )}
    </section>
  );
}
