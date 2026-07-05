import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../format.js';
import { uploadAlbum, uploadArchive, errorMessage } from '../api.js';
import { useToast } from './Toast.jsx';
import { UploadIcon } from './icons.jsx';
import { Button } from './ui/button.jsx';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose
} from './ui/dialog.jsx';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent
} from './ui/accordion.jsx';

// Mirrors AUDIO_EXTENSIONS in server/upload.js. Art/sidecar files (cover, lrc,
// cue, log, txt...) are ignored so they don't count as "mixed formats".
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.alac']);

function audioExtension(name) {
  const dot = (name || '').lastIndexOf('.');
  if (dot < 0) {
    return '';
  }
  const extension = name.slice(dot).toLowerCase();
  return AUDIO_EXTENSIONS.has(extension) ? extension : '';
}

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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef(null);
  const archiveInputRef = useRef(null);
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

  // A single root-level .zip is an archive upload; anything else is a folder.
  const isArchive =
    entries.length === 1 &&
    !entries[0].path.includes('/') &&
    /\.zip$/i.test(entries[0].path);

  const audioFormats = useMemo(() => {
    if (isArchive) {
      return [];
    }
    const formats = new Set();
    for (const entry of entries) {
      const extension = audioExtension(entry.path);
      if (extension) {
        formats.add(extension);
      }
    }
    return Array.from(formats);
  }, [entries, isArchive]);

  const mixedFormats = audioFormats.length > 1;
  const formatLabel = audioFormats.map((ext) => ext.slice(1)).join(', ');

  async function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    const dropped = await entriesFromDataTransfer(event.dataTransfer);
    if (dropped.length === 0) {
      toast.error('Nothing usable in that drop — pick an album folder or a .zip.');
      return;
    }
    setResult(null);
    setEntries(dropped);
  }

  function handleUpload() {
    if (entries.length === 0 || isUploading) {
      return;
    }
    // Mixed audio formats are unusual for a single album — confirm first.
    if (mixedFormats) {
      setConfirmOpen(true);
      return;
    }
    performUpload();
  }

  async function performUpload() {
    setConfirmOpen(false);

    const body = new FormData();
    if (isArchive) {
      body.append('archive', entries[0].file, entries[0].path);
    } else {
      for (const { file, path } of entries) {
        body.append('files', file, path);
      }
    }

    setResult(null);
    setIsUploading(true);
    setUploadProgress(0);
    setProgressKnown(true);

    try {
      const onProgress = (event) => {
        if (!event.total) {
          setProgressKnown(false);
          return;
        }
        setProgressKnown(true);
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      };

      const data = isArchive
        ? await uploadArchive(body, onProgress)
        : await uploadAlbum(body, onProgress);

      setResult(data);
      setProgressKnown(true);
      setUploadProgress(100);
      setEntries([]);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      if (archiveInputRef.current) {
        archiveInputRef.current.value = '';
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

  const label = isArchive
    ? entries[0].path
    : entries.length > 0
      ? `${entries.length} files${rootFolders.size === 1 ? ` · ${[...rootFolders][0]}` : ''}`
      : 'Drag an album folder or .zip here';

  return (
    <div className="upload-block">
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
          onChange={(event) => {
            setResult(null);
            setEntries(
              Array.from(event.target.files || []).map((file) => ({
                file,
                path: file.webkitRelativePath || file.name
              }))
            );
          }}
        />
      </div>

      <input
        ref={archiveInputRef}
        type="file"
        className="visually-hidden"
        accept=".zip,application/zip,application/x-zip-compressed"
        aria-label="Choose album zip archive"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }
          setResult(null);
          setEntries([{ file, path: file.name }]);
        }}
      />

      <div className="upload-side">
        <div className="stats-row">
        <span>{isArchive ? '1 archive' : `${entries.length} files`}</span>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() => archiveInputRef.current?.click()}
        >
          Choose .zip
        </Button>
      </div>

      {mixedFormats ? (
        <p className="warning small">
          Mixed audio formats: {formatLabel}. An album is usually one format.
        </p>
      ) : null}

      <Button
        type="button"
        className="w-full"
        onClick={handleUpload}
        disabled={entries.length === 0 || isUploading}
      >
        {isUploading ? 'Uploading…' : isArchive ? 'Upload Zip' : 'Upload Folder'}
      </Button>

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
            <Accordion type="single" collapsible>
              <AccordionItem value="skipped" className="border-b-0">
                <AccordionTrigger className="py-2">
                  View skipped files ({result.skippedCount})
                </AccordionTrigger>
                <AccordionContent>
                  <ul className="list-disc space-y-1 pl-5">
                    {(result.skipped || []).map((entry) => (
                      <li key={`${entry.path}-${entry.reason}`}>
                        {entry.path} — {entry.reason}
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ) : null}
        </div>
      ) : null}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mixed audio formats</DialogTitle>
            <DialogDescription>
              This folder mixes audio formats ({formatLabel}). An album is usually a single format.
              Upload anyway?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={performUpload}>
              Upload anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
