import { useEffect, useRef, useState } from 'react';
import { FIELD_LABELS } from '../format.js';
import {
  inspectAlbum,
  fixAlbum,
  embedCover,
  startImport,
  importStreamUrl,
  errorMessage
} from '../api.js';
import { Diagnosis, FixForm, CoverArtFix } from './MetadataReport.jsx';
import { useToast } from './Toast.jsx';
import { Button } from './ui/button.jsx';

// Count the things "Fix" can still act on, for the step-2 status line.
function countFixable(report) {
  if (!report) {
    return 0;
  }
  return (
    report.splitFields.length +
    report.textIssues.length +
    report.filenameIssues.length +
    (report.track.needsNormalize ? 1 : 0) +
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
  }, [selectedAlbum]);

  function applyReport(data) {
    setReport(data);
    // Pre-fill drafts with the mode for each inconsistent field (override-able).
    const hasConfidentText = (data.textIssues || []).some((i) => i.confident);
    const next = {
      // Renumbering rewrites every file, so leave it opt-in even when needed.
      normalizeTracks: false,
      fixFilenames: data.filenameIssues.length > 0,
      repairText: hasConfidentText
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
        repairText: Boolean(draft.repairText)
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

  async function importAlbum() {
    if (!selectedAlbum || importStatus === 'running') {
      return;
    }

    setImportLogs([]);
    setImportStatus('starting');

    try {
      const data = await startImport(selectedAlbum);
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
          toast.success(`Import finished for “${selectedAlbum}”.`);
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
        ? `Mixed formats (${report.formats.join(', ')}) — would split · ${report.trackCount} tracks`
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
      : importStatus === 'failed'
        ? 'failed'
        : importStatus === 'running' || importStatus === 'starting'
          ? 'active'
          : 'todo';

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
              <Button type="button" size="sm" onClick={importAlbum} disabled={importStatus === 'running'}>
                {importStatus === 'running' ? 'Importing…' : 'Import'}
              </Button>
            </div>
            <p className="step-status">Status: {importStatus}</p>
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
