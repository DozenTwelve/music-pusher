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

    try {
      const response = await axios.post('/api/upload', body, {
        onUploadProgress(event) {
          if (!event.total) {
            return;
          }
          setUploadProgress(Math.round((event.loaded / event.total) * 100));
        }
      });

      setResult(response.data);
      setUploadProgress(100);
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

      <input
        ref={inputRef}
        type="file"
        multiple
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
        <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
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

function ConsolePanel({ selectedAlbum, onImportDone }) {
  const [auditOutput, setAuditOutput] = useState('');
  const [importLogs, setImportLogs] = useState([]);
  const [importStatus, setImportStatus] = useState('idle');
  const [error, setError] = useState('');

  async function runAuditAction() {
    if (!selectedAlbum) {
      return;
    }

    setError('');
    setAuditOutput('Running exiftool...\n');

    try {
      const response = await axios.post('/api/audit', { album: selectedAlbum });
      const stdout = response.data.stdout || '';
      const stderr = response.data.stderr || '';
      setAuditOutput([stdout, stderr].filter(Boolean).join('\n'));
    } catch (requestError) {
      setError(requestError?.response?.data?.message || requestError.message);
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
      const events = new EventSource(`/api/import/${jobId}/stream`);

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
        <button type="button" disabled={!selectedAlbum} onClick={runAuditAction}>
          Audit
        </button>
        <button type="button" disabled={!selectedAlbum || importStatus === 'running'} onClick={importAlbum}>
          {importStatus === 'running' ? 'Importing...' : 'Import to Library'}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="terminal-wrap">
        <h3>Audit Output</h3>
        <pre className="terminal">{auditOutput || 'No audit run yet.'}</pre>
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

  async function loadAlbums() {
    setLoadingAlbums(true);
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
        <AlbumList albums={albums} selectedAlbum={selectedAlbum} onSelect={setSelectedAlbum} />
      </section>

      <ConsolePanel selectedAlbum={selectedAlbum} onImportDone={loadAlbums} />
    </main>
  );
}
