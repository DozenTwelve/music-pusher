import { useEffect, useState } from 'react';
import { getAlbums, errorMessage } from './api.js';
import UploadPanel from './components/UploadPanel.jsx';
import AlbumList from './components/AlbumList.jsx';
import WorkflowPanel from './components/WorkflowPanel.jsx';

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
        <p>Push album folders into your beets library — upload, clean up tags, then import.</p>
      </header>

      <div className="layout">
        <aside className="staging panel">
          <div className="section-header">
            <h2>Staging</h2>
            <button type="button" className="ghost" onClick={loadAlbums} disabled={loadingAlbums}>
              {loadingAlbums ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {albumsError ? <p className="error">Could not load albums: {albumsError}</p> : null}
          <AlbumList albums={albums} selectedAlbum={selectedAlbum} onSelect={setSelectedAlbum} />
          <UploadPanel onUploadDone={loadAlbums} />
        </aside>

        <WorkflowPanel selectedAlbum={selectedAlbum} onImportDone={loadAlbums} />
      </div>
    </main>
  );
}
