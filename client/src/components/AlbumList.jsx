import { formatBytes } from '../format.js';
import { TrashIcon } from './icons.jsx';

// `disabled`: the workflow has work in flight for the selected album, so
// switching away from it or deleting would pull the files out from under it.
export default function AlbumList({ albums, selectedAlbum, onSelect, onRequestDelete, disabled = false }) {
  if (albums.length === 0) {
    return <p className="muted empty">No staged albums yet. Upload one to get started.</p>;
  }

  return (
    <ul className="album-list">
      {albums.map((album) => (
        <li key={album.album} className="album-row-wrap">
          <button
            type="button"
            className={`album-row${selectedAlbum === album.album ? ' selected' : ''}`}
            onClick={() => onSelect(album.album)}
            disabled={disabled}
          >
            <span className="album-name">{album.album}</span>
            <span className="album-meta">
              {album.fileCount} files · {formatBytes(album.totalBytes)}
            </span>
          </button>
          <button
            type="button"
            className="album-remove"
            onClick={() => onRequestDelete(album.album)}
            disabled={disabled}
            aria-label={`Remove ${album.album} from staging`}
            title="Remove from staging"
          >
            <TrashIcon size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
