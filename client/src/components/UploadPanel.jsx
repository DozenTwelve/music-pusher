import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../format.js';
import { uploadAlbum, errorMessage } from '../api.js';
import { useToast } from './Toast.jsx';
import { UploadIcon } from './icons.jsx';

// Recursively read a dropped file-system entry into `out` as { file, path },
// preserving the folder structure (webkitGetAsEntry gives fullPath like
// "/Album/01.mp3"); the leading slash is stripped so it matches the server's
// expected relative path.
function readEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push({ file, path: entry.fullPath.replace(/^\//, '') });
          resolve();
        },
        () => resolve()
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];
      const readBatch = () => {
        // readEntries returns in chunks; keep calling until it drains.
        reader.readEntries(
          async (batch) => {
            if (batch.length === 0) {
              await Promise.all(collected.map((child) => readEntry(child, out)));
              resolve();
              return;
            }
            collected.push(...batch);
            readBatch();
          },
          () => resolve()
        );
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

async function entriesFromDataTransfer(dataTransfer) {
  const roots = Array.from(dataTransfer.items || [])
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  const out = [];
  if (roots.length > 0) {
    await Promise.all(roots.map((entry) => readEntry(entry, out)));
    return out;
  }
  // Browsers without the entries API: fall back to a flat file list.
  return Array.from(dataTransfer.files || []).map((file) => ({ file, path: file.name }));
}

export default function UploadPanel({ onUploadDone }) {
  const [entries, setEntries] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressKnown, setProgressKnown] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.setAttribute('webkitdirectory', 'true');
      inputRef.current.setAttribute('directory', 'true');
    }
  }, []);

  const totalSize = useMemo(
    () => entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0),
    [entries]
  );

  const rootFolders = useMemo(
    () => new Set(entries.map((entry) => entry.path.split('/')[0]).filter(Boolean)),
    [entries]
  );

  async function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    const dropped = await entriesFromDataTransfer(event.dataTransfer);
    if (dropped.length === 0) {
      toast.error('Nothing usable in that drop — pick an album folder.');
      return;
    }
    setResult(null);
    setEntries(dropped);
  }

  async function handleUpload() {
    if (entries.length === 0 || isUploading) {
      return;
    }

    const body = new FormData();
    for (const { file, path } of entries) {
      body.append('files', file, path);
    }

    setResult(null);
    setIsUploading(true);
    setUploadProgress(0);
    setProgressKnown(true);

    try {
      const data = await uploadAlbum(body, (event) => {
        if (!event.total) {
          setProgressKnown(false);
          return;
        }
        setProgressKnown(true);
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      });

      setResult(data);
      setProgressKnown(true);
      setUploadProgress(100);
      setEntries([]);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      toast.success(
        `Uploaded ${data.acceptedCount} file${data.acceptedCount === 1 ? '' : 's'} to “${
          data.album || 'staging'
        }”.`
      );
      onUploadDone();
    } catch (uploadError) {
      toast.error(errorMessage(uploadError));
    } finally {
      setIsUploading(false);
    }
  }

  const label =
    entries.length > 0
      ? `${entries.length} files${rootFolders.size === 1 ? ` · ${[...rootFolders][0]}` : ''}`
      : 'Drag an album folder here';

  return (
    <div className="upload-block">
      <h3>Add album</h3>
      <p className="muted small">Music, art, and cue/log/txt/lrc sidecars.</p>

      <div
        className={`dropzone${isDragging ? ' dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <div className="dropzone-icon">
          <UploadIcon size={26} />
        </div>
        <span className="dropzone-title">{label}</span>
        <span className="dropzone-hint">
          {entries.length > 0 ? formatBytes(totalSize) : 'or click to browse'}
        </span>
        <input
          id="folder-input"
          ref={inputRef}
          type="file"
          multiple
          className="visually-hidden"
          aria-label="Choose album folder"
          onChange={(event) =>
            setEntries(
              Array.from(event.target.files || []).map((file) => ({
                file,
                path: file.webkitRelativePath || file.name
              }))
            )
          }
        />
      </div>

      <div className="stats-row">
        <span>{entries.length} files</span>
        <span>{formatBytes(totalSize)}</span>
      </div>

      <button type="button" onClick={handleUpload} disabled={entries.length === 0 || isUploading}>
        {isUploading ? 'Uploading…' : 'Upload Folder'}
      </button>

      <div className="progress-shell">
        <div
          className={`progress-bar${isUploading && !progressKnown ? ' indeterminate' : ''}`}
          style={isUploading && !progressKnown ? undefined : { width: `${uploadProgress}%` }}
        />
      </div>

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
    </div>
  );
}
