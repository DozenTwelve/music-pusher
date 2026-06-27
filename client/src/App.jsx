import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const size = Math.floor(Math.log(value) / Math.log(1024));
  const amount = value / 1024 ** size;
  return `${amount.toFixed(amount < 10 && size > 0 ? 1 : 0)} ${units[size]}`;
}

function UploadPanel({ onUploadDone }) {
  const [files, setFiles] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressKnown, setProgressKnown] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.setAttribute('webkitdirectory', 'true');
      inputRef.current.setAttribute('directory', 'true');
    }
  }, []);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + (file.size || 0), 0),
    [files]
  );

  async function handleUpload() {
    if (files.length === 0 || isUploading) {
      return;
    }

    const body = new FormData();
    for (const file of files) {
      const relativePath = file.webkitRelativePath || file.name;
      body.append('files', file, relativePath);
    }

    setError('');
    setResult(null);
    setIsUploading(true);
    setUploadProgress(0);
    setProgressKnown(true);

    try {
      const response = await axios.post('/api/upload', body, {
        onUploadProgress(event) {
          if (!event.total) {
            setProgressKnown(false);
            return;
          }
          setProgressKnown(true);
          setUploadProgress(Math.round((event.loaded / event.total) * 100));
        }
      });

      setResult(response.data);
      setProgressKnown(true);
      setUploadProgress(100);
      setFiles([]);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      onUploadDone();
    } catch (uploadError) {
      const message = uploadError?.response?.data?.message || uploadError.message;
      setError(message);
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="panel">
      <h2>1. Upload Album Folder</h2>
      <p className="muted">Pick one folder. Supported: music files, cover images, cue/log/txt.</p>

      <label htmlFor="folder-input" className="muted">
        Album folder
      </label>
      <input
        id="folder-input"
        ref={inputRef}
        type="file"
        multiple
        aria-label="Choose album folder"
        onChange={(event) => setFiles(Array.from(event.target.files || []))}
      />

      <div className="stats-row">
        <span>{files.length} files</span>
        <span>{formatBytes(totalSize)}</span>
      </div>

      <button type="button" onClick={handleUpload} disabled={files.length === 0 || isUploading}>
        {isUploading ? 'Uploading...' : 'Upload Folder'}
      </button>

      <div className="progress-shell">
        <div
          className={`progress-bar${isUploading && !progressKnown ? ' indeterminate' : ''}`}
          style={isUploading && !progressKnown ? undefined : { width: `${uploadProgress}%` }}
        />
      </div>

      {error ? <p className="error">{error}</p> : null}

      {result ? (
        <div className="result-box">
          <p>Album: {result.album || 'Multiple / unknown'}</p>
          <p>
            Accepted: {result.acceptedCount} files ({formatBytes(result.totalBytes)})
          </p>
          <p>Skipped: {result.skippedCount}</p>
          {result.skippedCount > 0 ? (
            <details>
              <summary>View skipped files</summary>
              <ul>
                {(result.skipped || []).map((entry) => (
                  <li key={`${entry.path}-${entry.reason}`}>
                    {entry.path} - {entry.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AlbumList({ albums, selectedAlbum, onSelect }) {
  return (
    <section className="panel">
      <h2>2. Staging Area (RAW)</h2>
      {albums.length === 0 ? <p className="muted">No staged albums yet.</p> : null}

      <div className="album-grid">
        {albums.map((album) => (
          <button
            key={album.album}
            className={`album-card ${selectedAlbum === album.album ? 'selected' : ''}`}
            onClick={() => onSelect(album.album)}
            type="button"
          >
            <strong>{album.album}</strong>
            <span>{album.fileCount} files</span>
            <span>{formatBytes(album.totalBytes)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const FIELD_LABELS = {
  date: 'Date / Year',
  album: 'Album',
  album_artist: 'Album Artist',
  disc: 'Disc'
};

function MetadataReport({ report, draft, onDraftChange }) {
  const splitDanger = report.groupCount > 1;

  return (
    <div className="report">
      <div className={`report-banner ${splitDanger ? 'bad' : 'good'}`}>
        {splitDanger
          ? `⚠ This album would split into ${report.groupCount} albums. Cause: ${report.splitFields
              .map((f) => FIELD_LABELS[f] || f)
              .join(', ')}.`
          : `✓ Consistent — this album stays as 1 album (${report.trackCount} tracks).`}
      </div>

      {report.multiDisc ? (
        <p className="muted">
          Multi-disc set ({report.discs.length} discs):{' '}
          {report.discs
            .map((d) => `disc ${d.disc} = ${d.trackCount} tracks${d.contiguous ? '' : ' ⚠ gaps'}`)
            .join(', ')}
          . Leave Disc blank below — do not unify it.
        </p>
      ) : null}

      {report.formats.length > 1 ? (
        <p className="muted">Mixed formats present: {report.formats.join(', ')}</p>
      ) : null}

      <table className="field-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Status</th>
            <th>Distinct values</th>
            <th>Unify to</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(FIELD_LABELS).map((field) => {
            const info = report.fields[field];
            if (!info) {
              return null;
            }
            const valueSummary = info.distinct.length
              ? info.distinct.map((d) => `${d.value} ×${d.count}`).join('  |  ')
              : '(empty)';
            return (
              <tr key={field} className={info.consistent ? '' : 'row-bad'}>
                <td>{FIELD_LABELS[field]}</td>
                <td>{info.consistent ? 'OK' : `${info.distinct.length || 0} values${info.missing ? `, ${info.missing} missing` : ''}`}</td>
                <td className="value-cell">{valueSummary}</td>
                <td>
                  <input
                    type="text"
                    value={draft[field] ?? ''}
                    placeholder={info.proposed || '(leave blank to skip)'}
                    onChange={(event) => onDraftChange(field, event.target.value)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="report-extras">
        <label>
          <input
            type="checkbox"
            checked={draft.normalizeTracks}
            onChange={(event) => onDraftChange('normalizeTracks', event.target.checked)}
          />
          Normalize track numbering (set totals to {report.trackCount})
          {report.track.needsNormalize ? ' — needed' : ' — already OK'}
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.fixFilenames}
            onChange={(event) => onDraftChange('fixFilenames', event.target.checked)}
          />
          Fix apostrophes in filenames
          {report.filenameIssues.length ? ` (${report.filenameIssues.length})` : ' — none found'}
        </label>
      </div>

      {report.filenameIssues.length ? (
        <details>
          <summary>Filename fixes ({report.filenameIssues.length})</summary>
          <ul>
            {report.filenameIssues.map((issue) => (
              <li key={issue.file}>
                {issue.file} → {issue.suggested}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ConsolePanel({ selectedAlbum, onImportDone }) {
  const [report, setReport] = useState(null);
  const [draft, setDraft] = useState({ normalizeTracks: false, fixFilenames: false });
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
    setDraft({ normalizeTracks: false, fixFilenames: false });
    setFixSummary('');
  }, [selectedAlbum]);

  function applyReport(data) {
    setReport(data);
    // Pre-fill drafts with the mode for each inconsistent field (override-able).
    const next = { normalizeTracks: data.track.needsNormalize, fixFilenames: data.filenameIssues.length > 0 };
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
      const response = await axios.post('/api/inspect', { album: selectedAlbum });
      applyReport(response.data);
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError.message);
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
      const response = await axios.post('/api/fix', {
        album: selectedAlbum,
        set,
        normalizeTracks: Boolean(draft.normalizeTracks),
        fixFilenames: Boolean(draft.fixFilenames)
      });
      const data = response.data;
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
      setError(requestError?.response?.data?.message || requestError.message);
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
      const response = await axios.post('/api/import', { album: selectedAlbum });
      const jobId = response.data?.job?.id;
      if (!jobId) {
        throw new Error('Missing job id from server.');
      }

      setImportStatus('running');
      eventSourceRef.current?.close();
      const events = new EventSource(`/api/import/${jobId}/stream`);
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
      setError(requestError?.response?.data?.message || requestError.message);
    }
  }

  return (
    <section className="panel">
      <h2>3. Audit + Import Console</h2>
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

export default function App() {
  const [albums, setAlbums] = useState([]);
  const [selectedAlbum, setSelectedAlbum] = useState('');
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [albumsError, setAlbumsError] = useState('');

  async function loadAlbums() {
    setLoadingAlbums(true);
    setAlbumsError('');
    try {
      const response = await axios.get('/api/albums');
      const list = response.data?.albums || [];
      setAlbums(list);

      if (list.length === 0) {
        setSelectedAlbum('');
        return;
      }

      if (list.length > 0 && !list.some((item) => item.album === selectedAlbum)) {
        setSelectedAlbum(list[0].album);
      }
    } catch (loadError) {
      setAlbumsError(loadError?.response?.data?.message || loadError.message);
    } finally {
      setLoadingAlbums(false);
    }
  }

  useEffect(() => {
    loadAlbums();
  }, []);

  return (
    <main className="app-shell">
      <header>
        <h1>Music Pusher</h1>
        <p>Upload album folders to RAW, audit tags, then import with live logs.</p>
      </header>

      <UploadPanel onUploadDone={loadAlbums} />

      <section className="panel">
        <div className="section-header">
          <h2>Album Queue</h2>
          <button type="button" onClick={loadAlbums} disabled={loadingAlbums}>
            {loadingAlbums ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        {albumsError ? <p className="error">Could not load albums: {albumsError}</p> : null}
        <AlbumList albums={albums} selectedAlbum={selectedAlbum} onSelect={setSelectedAlbum} />
      </section>

      <ConsolePanel selectedAlbum={selectedAlbum} onImportDone={loadAlbums} />
    </main>
  );
}
