import { useEffect, useRef, useState } from 'react';
import { FIELD_LABELS } from '../format.js';
import {
  inspectAlbum,
  fixAlbum,
  startImport,
  importStreamUrl,
  errorMessage
} from '../api.js';
import MetadataReport from './MetadataReport.jsx';

export default function ConsolePanel({ selectedAlbum, onImportDone }) {
  const [report, setReport] = useState(null);
  const [draft, setDraft] = useState({ normalizeTracks: false, fixFilenames: false, repairText: false });
  const [busy, setBusy] = useState('');
  const [fixSummary, setFixSummary] = useState('');
  const [importLogs, setImportLogs] = useState([]);
  const [importStatus, setImportStatus] = useState('idle');
  const [error, setError] = useState('');
  const eventSourceRef = useRef(null);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  // Reset analysis when the selected album changes.
  useEffect(() => {
    setReport(null);
    setDraft({ normalizeTracks: false, fixFilenames: false, repairText: false });
    setFixSummary('');
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
    setError('');
    setFixSummary('');
    setBusy('analyze');
    try {
      const data = await inspectAlbum(selectedAlbum);
      applyReport(data);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy('');
    }
  }

  async function applyFixes() {
    if (!selectedAlbum || !report) {
      return;
    }
    setError('');
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
        setError(data.errors.map((e) => `${e.file}: ${e.message}`).join('\n'));
      }
      if (data.after) {
        applyReport(data.after);
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy('');
    }
  }

  async function importAlbum() {
    if (!selectedAlbum || importStatus === 'running') {
      return;
    }

    setError('');
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
        setImportStatus(payload.status || 'done');
        if (payload?.cleanup?.ok) {
          setImportLogs((previous) => [
            ...previous,
            {
              stream: 'stdout',
              line: `Cleanup complete: removed ${payload.cleanup.removedPath}`
            }
          ]);
        }
        events.close();
        onImportDone();
      });

      events.onerror = () => {
        events.close();
        setImportStatus('failed');
        setError('Lost connection to import log stream.');
      };
    } catch (requestError) {
      setImportStatus('failed');
      setError(errorMessage(requestError));
    }
  }

  return (
    <section className="panel">
      <h2>3. Analyze + Import Console</h2>
      <p className="muted">Selected album: {selectedAlbum || 'none'}</p>

      <div className="button-row">
        <button type="button" disabled={!selectedAlbum || busy === 'analyze'} onClick={runAnalyze}>
          {busy === 'analyze' ? 'Analyzing...' : 'Analyze Metadata'}
        </button>
        <button type="button" disabled={!report || busy === 'fix'} onClick={applyFixes}>
          {busy === 'fix' ? 'Applying...' : 'Apply Fixes'}
        </button>
        <button type="button" disabled={!selectedAlbum || importStatus === 'running'} onClick={importAlbum}>
          {importStatus === 'running' ? 'Importing...' : 'Import to Library'}
        </button>
      </div>

      {error ? <pre className="error">{error}</pre> : null}
      {fixSummary ? <p className="muted">{fixSummary}</p> : null}

      <div className="terminal-wrap">
        <h3>Metadata Analysis</h3>
        {report ? (
          <MetadataReport report={report} draft={draft} onDraftChange={updateDraft} />
        ) : (
          <p className="muted">No analysis yet. Pick an album and click Analyze Metadata.</p>
        )}
      </div>

      <div className="terminal-wrap">
        <h3>Import Logs ({importStatus})</h3>
        <pre className="terminal">
          {importLogs.length === 0
            ? 'No import logs yet.'
            : importLogs.map((entry) => `[${entry.stream}] ${entry.line}`).join('\n')}
        </pre>
      </div>
    </section>
  );
}
