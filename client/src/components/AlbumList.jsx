import { formatBytes } from '../format.js';

export default function AlbumList({ albums, selectedAlbum, onSelect }) {
  if (albums.length === 0) {
    return <p className="muted empty">No staged albums yet. Upload one to get started.</p>;
  }

  return (
    <ul className="album-list">
      {albums.map((album) => (
        <li key={album.album}>
          <button
            type="button"
            className={`album-row${selectedAlbum === album.album ? ' selected' : ''}`}
            onClick={() => onSelect(album.album)}
          >
            <span className="album-name">{album.album}</span>
            <span className="album-meta">
              {album.fileCount} files · {formatBytes(album.totalBytes)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
