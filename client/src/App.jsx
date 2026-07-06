import { useEffect, useState } from 'react';
import { getAlbums, deleteAlbum, errorMessage } from './api.js';
import UploadPanel from './components/UploadPanel.jsx';
import AlbumList from './components/AlbumList.jsx';
import WorkflowPanel from './components/WorkflowPanel.jsx';
import { useToast } from './components/Toast.jsx';
import { SunIcon, MoonIcon } from './components/icons.jsx';
import { Button } from './components/ui/button.jsx';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose
} from './components/ui/dialog.jsx';

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
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const toast = useToast();

  async function confirmDelete() {
    if (!pendingDelete) {
      return;
    }
    setDeleting(true);
    try {
      await deleteAlbum(pendingDelete);
      toast.success(`Removed “${pendingDelete}” from staging.`);
      await loadAlbums();
    } catch (deleteError) {
      toast.error(errorMessage(deleteError));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

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
        <section className="staging panel">
          <div className="section-header">
            <div className="card-heading">
              <h2>Staging</h2>
              <span className="card-eyebrow">
                {albums.length
                  ? `${albums.length} album${albums.length === 1 ? '' : 's'} ready`
                  : 'Nothing staged'}
              </span>
            </div>
          </div>
          <AlbumList
            albums={albums}
            selectedAlbum={selectedAlbum}
            onSelect={setSelectedAlbum}
            onRequestDelete={setPendingDelete}
          />
        </section>

        <section className="add-album panel">
          <div className="section-header">
            <div className="card-heading">
              <h2>Add album</h2>
              <span className="card-eyebrow">Folder or .zip — music, art, and sidecars</span>
            </div>
          </div>
          <UploadPanel onUploadDone={loadAlbums} />
        </section>

        <WorkflowPanel selectedAlbum={selectedAlbum} onImportDone={loadAlbums} />
      </div>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from staging?</DialogTitle>
            <DialogDescription>
              This permanently deletes “{pendingDelete}” and all its uploaded files from the staging
              area. It does not touch anything already imported into your library.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={deleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
