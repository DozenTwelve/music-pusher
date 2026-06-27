import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../format.js';
import { uploadAlbum, errorMessage } from '../api.js';

export default function UploadPanel({ onUploadDone }) {
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
      setFiles([]);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      onUploadDone();
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="upload-block">
      <h3>Add album</h3>
      <p className="muted small">Pick a folder — music, art, cue/log/txt/lrc.</p>

      <label htmlFor="folder-input" className="muted small">
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
    </div>
  );
}
