import { useEffect, useState } from 'react';
import { getAlbums, errorMessage } from './api.js';
import UploadPanel from './components/UploadPanel.jsx';
import AlbumList from './components/AlbumList.jsx';
import ConsolePanel from './components/ConsolePanel.jsx';

export default function App() {
  const [albums, setAlbums] = useState([]);
  const [selectedAlbum, setSelectedAlbum] = useState('');
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [albumsError, setAlbumsError] = useState('');

  async function loadAlbums() {
    setLoadingAlbums(true);
    setAlbumsError('');
    try {
      const list = await getAlbums();
      setAlbums(list);

      if (list.length === 0) {
        setSelectedAlbum('');
        return;
      }

      if (!list.some((item) => item.album === selectedAlbum)) {
        setSelectedAlbum(list[0].album);
      }
    } catch (loadError) {
      setAlbumsError(errorMessage(loadError));
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
        <p>Upload album folders to RAW, analyze tags, then import with live logs.</p>
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
