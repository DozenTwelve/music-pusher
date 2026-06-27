import { formatBytes } from '../format.js';

export default function AlbumList({ albums, selectedAlbum, onSelect }) {
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
