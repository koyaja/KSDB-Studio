import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { Store } from './store';

const isDev = !app.isPackaged && process.argv.includes('--dev');
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'KSDB Studio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7f9',
    icon: path.join(__dirname, '../renderer/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost:5173')) e.preventDefault();
  });
  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // macOS : le premier menu porte le nom de l'application (À propos, Masquer, Quitter ⌘Q)
      process.platform === 'darwin'
        ? {
            label: app.name,
            submenu: [
              { role: 'about', label: 'À propos de KSDB Studio' },
              { type: 'separator' },
              { role: 'hide', label: 'Masquer KSDB Studio' },
              { role: 'hideOthers', label: 'Masquer les autres' },
              { role: 'unhide', label: 'Tout afficher' },
              { type: 'separator' },
              { role: 'quit', label: 'Quitter KSDB Studio' },
            ],
          }
        : { label: 'Fichier', submenu: [{ role: 'quit', label: 'Quitter' }] },
      {
        label: 'Édition',
        submenu: [
          { role: 'undo', label: 'Annuler' },
          { role: 'redo', label: 'Rétablir' },
          { type: 'separator' },
          { role: 'cut', label: 'Couper' },
          { role: 'copy', label: 'Copier' },
          { role: 'paste', label: 'Coller' },
          { role: 'selectAll', label: 'Tout sélectionner' },
        ],
      },
      {
        label: 'Affichage',
        submenu: [
          { role: 'reload', label: 'Recharger' },
          { role: 'toggleDevTools', label: 'Outils de développement' },
          { type: 'separator' },
          { role: 'resetZoom', label: 'Zoom normal' },
          { role: 'zoomIn', label: 'Zoom avant' },
          { role: 'zoomOut', label: 'Zoom arrière' },
          { role: 'togglefullscreen', label: 'Plein écran' },
        ],
      },
      ...(process.platform === 'darwin'
        ? [{ role: 'windowMenu' as const, label: 'Fenêtre' }]
        : []),
    ]),
  );
  const store = new Store();
  const api = registerIpc(store, () => win);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    Promise.race([api.shutdown(), new Promise((r) => setTimeout(r, 60000))]).finally(() => app.quit());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
