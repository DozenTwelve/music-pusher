import { useEffect, useState } from 'react';
import { getAlbums, errorMessage } from './api.js';
import UploadPanel from './components/UploadPanel.jsx';
import AlbumList from './components/AlbumList.jsx';
import WorkflowPanel from './components/WorkflowPanel.jsx';
import { useToast } from './components/Toast.jsx';
import { SunIcon, MoonIcon, ImageIcon } from './components/icons.jsx';
import { Button } from './components/ui/button.jsx';

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  return [theme, () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))];
}

export default function App() {
  const [albums, setAlbums] = useState([]);
  const [selectedAlbum, setSelectedAlbum] = useState('');
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const toast = useToast();

  async function loadAlbums() {
    setLoadingAlbums(true);
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
      toast.error(`Could not load albums: ${errorMessage(loadError)}`);
    } finally {
      setLoadingAlbums(false);
    }
  }

  useEffect(() => {
    loadAlbums();
  }, []);

  return (
    <main className="app-shell">
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <ImageIcon size={20} />
          </span>
          <header>
            <h1>Music Pusher</h1>
            <p>Upload album folders, clean up tags, then import into beets.</p>
          </header>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>

      <div className="layout">
        <aside className="staging panel">
          <div className="section-header">
            <h2>Staging</h2>
            <Button type="button" variant="outline" size="sm" onClick={loadAlbums} disabled={loadingAlbums}>
              {loadingAlbums ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
          <div className="staging-body">
            <AlbumList albums={albums} selectedAlbum={selectedAlbum} onSelect={setSelectedAlbum} />
            <UploadPanel onUploadDone={loadAlbums} />
          </div>
        </aside>

        <WorkflowPanel selectedAlbum={selectedAlbum} onImportDone={loadAlbums} />
      </div>
    </main>
  );
}
