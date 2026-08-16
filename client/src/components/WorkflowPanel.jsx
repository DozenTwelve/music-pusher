import { useEffect, useRef, useState } from 'react';
import { FIELD_LABELS } from '../format.js';
import {
  inspectAlbum,
  fixAlbum,
  embedCover,
  startImport,
  searchReleases,
  retryImport,
  importStreamUrl,
  errorMessage
} from '../api.js';
import { Diagnosis, FixForm, CoverArtFix, ReleasePicker } from './MetadataReport.jsx';
import { useToast } from './Toast.jsx';
import { Button } from './ui/button.jsx';

// Count the things "Fix" can still act on, for the step-2 status line.
function countFixable(report) {
  if (!report) {
    return 0;
  }
  // Every field the Fix form offers to unify, not just the ones that would
  // split the album. Since dbda359 dropped `date` from the split causes, an
  // album whose only problem is drifting release dates has no split fields —
  // but the form right below this line still shows Date as a red row with a
  // pre-filled value, so counting split fields made the status contradict it.
  const inconsistentFields = Object.keys(FIELD_LABELS).filter(
    (field) => report.fields[field] && !report.fields[field].consistent
  ).length;

  return (
    inconsistentFields +
    report.textIssues.length +
    report.filenameIssues.length +
    (report.track.needsNormalize ? 1 : 0) +
    (report.durationRepairable?.length ? 1 : 0) +
    (report.art?.hasMissing ? 1 : 0)
  );
}

export default function WorkflowPanel({ selectedAlbum, onImportDone }) {
  const [report, setReport] = useState(null);
  const [draft, setDraft] = useState({ normalizeTracks: false, fixFilenames: false, repairText: false });
  const [busy, setBusy] = useState('');
  const [fixSummary, setFixSummary] = useState('');
  const [importLogs, setImportLogs] = useState([]);
  const [importStatus, setImportStatus] = useState('idle');
  // Split fields the server refused the import on, or null when not blocked.
  // Non-null also arms the next Import press to send `force`.
  const [splitBlock, setSplitBlock] = useState(null);
  // beets albums matching this one, when the server refused as a duplicate.
  // Arms `force` the same way — one override for both guards, because from
  // here it is the same press: "I have read the warning, import anyway."
  const [duplicateBlock, setDuplicateBlock] = useState(null);
  // MusicBrainz candidates, and the one the user picked to import as. Kept
  // across a re-analyze on purpose: which release this *is* does not change
  // because its tags were tidied up.
  const [releases, setReleases] = useState(null);
  const [chosenRelease, setChosenRelease] = useState(null);
  // What to search MusicBrainz for, when the album's own tags are not it. Blank
  // means "use the tags", which is the common case; an album that arrived with
  // no tags at all has nothing to search on, and this is the only way in.
  const [releaseQuery, setReleaseQuery] = useState({ artist: '', album: '' });
  const eventSourceRef = useRef(null);
  const toast = useToast();

  useEffect(() => () => eventSourceRef.current?.close(), []);

  // Reset everything when the selected album changes.
  useEffect(() => {
    setReport(null);
    setDraft({ normalizeTracks: false, fixFilenames: false, repairText: false });
    setFixSummary('');
    setImportLogs([]);
    setImportStatus('idle');
    setSplitBlock(null);
    setDuplicateBlock(null);
    setReleases(null);
    setChosenRelease(null);
    setReleaseQuery({ artist: '', album: '' });
  }, [selectedAlbum]);

  function applyReport(data) {
    setReport(data);
    // A fresh report supersedes any earlier refusal, so the next Import goes
    // back through the guard instead of silently carrying `force` along.
    setSplitBlock(null);
    setDuplicateBlock(null);
    // Pre-fill drafts with the mode for each inconsistent field (override-able).
    const hasConfidentText = (data.textIssues || []).some((i) => i.confident);
    const next = {
      // Renumbering rewrites every file, so default it on only when track
      // numbers are actually missing (the later-download case) — a plain
      // total-mismatch stays opt-in.
      normalizeTracks: (data.track?.missingNumbers || 0) > 0,
      fixFilenames: data.filenameIssues.length > 0,
      repairText: hasConfidentText,
      // Default on: the re-encode is lossless, and a track with no length is
      // broken in both directions — beets cannot match it and no player can
      // seek it.
      repairDuration: (data.durationRepairable?.length || 0) > 0
    };
    for (const field of Object.keys(FIELD_LABELS)) {
      const info = data.fields[field];
      next[field] = info && !info.consistent ? info.proposed : '';
    }
    setDraft(next);
  }

  function updateDraft(key, value) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  async function runAnalyze() {
    if (!selectedAlbum) {
      return;
    }
    setFixSummary('');
    setBusy('analyze');
    try {
      const data = await inspectAlbum(selectedAlbum);
      applyReport(data);
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy('');
    }
  }

  async function applyFixes() {
    if (!selectedAlbum || !report) {
      return;
    }
    setBusy('fix');
    const set = {};
    for (const field of Object.keys(FIELD_LABELS)) {
      const value = (draft[field] ?? '').trim();
      if (value) {
        set[field] = value;
      }
    }
    try {
      const data = await fixAlbum(selectedAlbum, {
        set,
        normalizeTracks: Boolean(draft.normalizeTracks),
        fixFilenames: Boolean(draft.fixFilenames),
        repairText: Boolean(draft.repairText),
        repairDuration: Boolean(draft.repairDuration)
      });
      const parts = [
        `Tagged ${data.changes.length} files`,
        data.renames.length ? `renamed ${data.renames.length}` : null,
        data.errors.length ? `${data.errors.length} errors` : null,
        data.after ? `now ${data.after.groupCount} album(s)` : null
      ].filter(Boolean);
      setFixSummary(parts.join(' · '));
      if (data.errors.length) {
        toast.error(data.errors.map((e) => `${e.file}: ${e.message}`).join('\n'));
      } else {
        toast.success(parts.join(' · '));
      }
      if (data.after) {
        applyReport(data.after);
      }
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy('');
    }
  }

  async function handleEmbedCover(file) {
    if (!selectedAlbum || !file) {
      return;
    }
    setBusy('cover');
    try {
      const data = await embedCover(selectedAlbum, file);
      const parts = [
        `Embedded cover into ${data.embedded} file${data.embedded === 1 ? '' : 's'}`,
        data.errors.length ? `${data.errors.length} errors` : null
      ].filter(Boolean);
      setFixSummary(parts.join(' · '));
      if (data.errors.length) {
        toast.error(data.errors.map((e) => `${e.file}: ${e.message}`).join('\n'));
      } else {
        toast.success(parts.join(' · '));
      }
      if (data.after) {
        applyReport(data.after);
      }
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy('');
    }
  }

  async function findReleases() {
    if (!selectedAlbum) {
      return;
    }
    setBusy('releases');
    try {
      const data = await searchReleases(selectedAlbum, releaseQuery);
      setReleases(data.candidates || []);
      if (!data.candidates?.length) {
        toast.error('No MusicBrainz release matched. Try typing the artist and album above.');
      }
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    } finally {
      setBusy('');
    }
  }

  function importAlbum(force = false) {
    // Both entry points follow the same job stream; only the request differs.
    return runImport(() => startImport(selectedAlbum, { force, releaseId: chosenRelease }));
  }

  function retryPartialImport() {
    return runImport(() => retryImport(selectedAlbum));
  }

  async function runImport(start) {
    if (!selectedAlbum || importStatus === 'running') {
      return;
    }

    setImportLogs([]);
    setImportStatus('starting');

    try {
      const data = await start();
      const jobId = data?.job?.id;
      if (!jobId) {
        throw new Error('Missing job id from server.');
      }

      setImportStatus('running');
      eventSourceRef.current?.close();
      const events = new EventSource(importStreamUrl(jobId));
      eventSourceRef.current = events;

      events.addEventListener('log', (event) => {
        const payload = JSON.parse(event.data);
        setImportLogs((previous) => [...previous, payload]);
      });

      events.addEventListener('end', (event) => {
        const payload = JSON.parse(event.data);
        const status = payload.status || 'done';
        setImportStatus(status);
        if (payload?.cleanup?.ok) {
          setImportLogs((previous) => [
            ...previous,
            {
              stream: 'stdout',
              line: `Cleanup complete: removed ${payload.cleanup.removedPath}`
            }
          ]);
        }
        if (status === 'done') {
          const v = payload.verification;
          // A `done` import can still be the bad kind: every track landed, and
          // beets wrote back nothing because it never matched the album. That
          // is the outcome this whole screen exists to prevent, so it does not
          // get to look like a plain success. `toast.error` is reused for its
          // stickiness (duration 0) rather than a third variant — the import
          // did succeed, but the result needs a decision.
          const blank = [
            v?.untitled ? `${v.untitled} track${v.untitled > 1 ? 's' : ''} have no title` : null,
            v && v.matched === false ? 'no MusicBrainz release matched' : null
          ].filter(Boolean);
          if (blank.length) {
            toast.error(
              `Imported “${selectedAlbum}”, but ${blank.join(' and ')}. The tags are unchanged ` +
                'from the files — pick the release in step 3 and import again to correct them.'
            );
          } else {
            toast.success(`Import finished for “${selectedAlbum}”.`);
          }
        } else if (status === 'partial') {
          const v = payload.verification;
          toast.error(
            v
              ? `Only ${v.imported} of ${v.expected} tracks reached the library. The RAW folder was kept — see the log.`
              : `Could not verify the import for “${selectedAlbum}” — the RAW folder was kept.`
          );
        } else {
          toast.error(`Import failed for “${selectedAlbum}” — see the log.`);
        }
        events.close();
        onImportDone();
      });

      events.onerror = () => {
        events.close();
        setImportStatus('failed');
        toast.error('Lost connection to import log stream.');
      };
    } catch (requestError) {
      const refusal = requestError?.response?.data;
      if (refusal?.code === 'already_imported') {
        if (refusal.report) {
          applyReport(refusal.report);
        }
        setDuplicateBlock(refusal.existing || []);
        // applyReport just cleared the split state, but `force` waives every
        // guard at once — so an album that is both a duplicate and a split has
        // to show both, or Import anyway silently accepts the unseen one.
        if (refusal.report?.groupCount > 1) {
          setSplitBlock(refusal.report.splitFields || []);
        }
        setImportStatus('blocked');
        toast.error(refusal.message);
        return;
      }
      if (refusal?.code === 'would_split') {
        // The server ran a full inspect to reach this verdict and sent it back.
        // Use it, so steps 1 and 2 show the cause and the pre-filled fix rather
        // than the user having to press Analyze again to see what happened.
        if (refusal.report) {
          applyReport(refusal.report);
        }
        setSplitBlock(refusal.report?.splitFields || []);
        setImportStatus('blocked');
        toast.error(refusal.message);
        return;
      }
      setImportStatus('failed');
      toast.error(errorMessage(requestError));
    }
  }

  if (!selectedAlbum) {
    return (
      <section className="workflow panel">
        <div className="workflow-head">
          <h2>Workflow</h2>
          <span className="muted album-chip">No album selected</span>
        </div>
        <p className="muted">Select an album from Staging to analyze, clean up, and import it.</p>
      </section>
    );
  }

  const analyzeStatus = !report
    ? 'Not analyzed yet.'
    : report.groupCount > 1
      ? `Would split into ${report.groupCount} albums · ${report.trackCount} tracks`
      : report.mixedFormats
        ? `Mixed formats (${report.formats.join(', ')}) — may split, import allowed · ${report.trackCount} tracks`
        : report.mixedQuality
          ? `Mixed audio quality — may split, import allowed · ${report.trackCount} tracks`
          : `Stays as 1 album · ${report.trackCount} tracks`;

  const fixableCount = countFixable(report);
  const fixStatus = !report
    ? 'Run Analyze first.'
    : fixableCount > 0
      ? `${fixableCount} issue${fixableCount > 1 ? 's' : ''} to review.`
      : 'Nothing to fix — looks clean.';

  const importStepState =
    importStatus === 'done'
      ? 'done'
      : importStatus === 'failed' || importStatus === 'blocked' || importStatus === 'partial'
        ? 'failed'
        : importStatus === 'running' || importStatus === 'starting'
          ? 'active'
          : 'todo';

  // Both reasons, not the first one: Import anyway waives every guard, so the
  // status line has to list everything it is about to waive.
  const blockReasons = [
    duplicateBlock?.length
      ? `beets already has ${duplicateBlock
          .map((a) => `${a.albumartist || '(no album artist)'} — ${a.album}`)
          .join('; ')}, and importing again adds another copy`
      : null,
    splitBlock
      ? splitBlock.length
        ? `it would split on ${splitBlock.map((f) => FIELD_LABELS[f] || f).join(', ')} (fix in step 2)`
        : 'it would split in the library (fix in step 2)'
      : null
  ].filter(Boolean);
  const importBlockReason = blockReasons.length
    ? ` — ${blockReasons.join('; and ')}. Press Import anyway to accept ${blockReasons.length > 1 ? 'both' : 'it'}.`
    : '';

  return (
    <section className="workflow panel">
      <div className="workflow-head">
        <h2>Workflow</h2>
        <span className="album-chip">{selectedAlbum}</span>
      </div>

      <ol className="steps">
        <li className={`step${report ? ' done' : ''}`}>
          <span className="step-badge">1</span>
          <div className="step-body">
            <div className="step-head">
              <strong>Analyze metadata</strong>
              <Button type="button" size="sm" onClick={runAnalyze} disabled={Boolean(busy)}>
                {busy === 'analyze' ? 'Analyzing…' : report ? 'Re-analyze' : 'Analyze'}
              </Button>
            </div>
            <p className="step-status">{analyzeStatus}</p>
            {report ? (
              <div className="step-detail">
                <Diagnosis report={report} />
              </div>
            ) : null}
          </div>
        </li>

        <li className={`step${report ? '' : ' todo'}`}>
          <span className="step-badge">2</span>
          <div className="step-body">
            <div className="step-head">
              <strong>Fix issues</strong>
              <Button type="button" size="sm" onClick={applyFixes} disabled={!report || Boolean(busy)}>
                {busy === 'fix' ? 'Applying…' : 'Apply Fixes'}
              </Button>
            </div>
            <p className="step-status">{fixStatus}</p>
            {fixSummary ? <p className="step-status ok">{fixSummary}</p> : null}
            {report ? (
              <div className="step-detail">
                <FixForm report={report} draft={draft} onDraftChange={updateDraft} />
                <CoverArtFix report={report} onEmbed={handleEmbedCover} busy={busy} />
              </div>
            ) : null}
          </div>
        </li>

        <li className={`step ${importStepState}`}>
          <span className="step-badge">3</span>
          <div className="step-body">
            <div className="step-head">
              <strong>Import to library</strong>
              <Button
                type="button"
                size="sm"
                onClick={() => importAlbum(Boolean(splitBlock || duplicateBlock))}
                disabled={importStatus === 'running'}
              >
                {importStatus === 'running'
                  ? 'Importing…'
                  : splitBlock || duplicateBlock
                    ? 'Import anyway'
                    : 'Import'}
              </Button>
              {/* Only after a verification failure. The RAW folder was kept
                  precisely so this is possible, and the retry undoes the half
                  that landed before running again. */}
              {importStatus === 'partial' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={retryPartialImport}
                  disabled={importStatus === 'running'}
                >
                  Undo and retry
                </Button>
              ) : null}
            </div>
            <p className="step-status">
              Status: {importStatus}
              {importBlockReason}
            </p>

            <ReleasePicker
              report={report}
              releases={releases}
              chosen={chosenRelease}
              onSearch={findReleases}
              query={releaseQuery}
              onQueryChange={(key, value) => setReleaseQuery((q) => ({ ...q, [key]: value }))}
              onChoose={setChosenRelease}
              busy={busy}
            />
            <div className="step-detail">
              <pre className="terminal">
                {importLogs.length === 0
                  ? 'No import logs yet.'
                  : importLogs.map((entry) => `[${entry.stream}] ${entry.line}`).join('\n')}
              </pre>
            </div>
          </div>
        </li>
      </ol>
    </section>
  );
}
