import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import {
  pinUserDataPath,
  getConfiguredDbPath,
  getEffectiveDbPath,
  getDefaultDbPath,
  getDbFileSize,
  isUsingDefaultLocation,
  setDbPath,
  resetToDefaultDbPath,
} from './dbLocation';
import { setupApplicationMenu, attachContextMenu } from './menu';
import { Store } from './database/store';
import { SecretStore } from './secrets';
import { SteamSession, createRealSteamUser, paymentMethodNames, SteamAuthError, SteamCancelledError } from './steam/steamClient';
import { runSync, getCountry, META_COUNTRY, META_LAST_SYNC, SyncDeps } from './sync';
import type { FetchLike } from './http';
import type { CredentialStatus, SteamGuardRequest, SyncResult, UpdateCheckResult } from '../shared/types';

pinUserDataPath();
app.setName('playtime-roi');

let mainWindow: BrowserWindow | null = null;
let store: Store | null = null;
let secrets: SecretStore;
let appInitialized = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  // app.quit() on the losing instance has been seen leaving the process
  // alive (KVG_Standards db-location-versioning.md), so force it.
  setTimeout(() => process.exit(0), 1000);
} else {
  app.on('second-instance', () => {
    if (!appInitialized) return; // startup still in progress
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

const DEV_URL = 'http://localhost:5173';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    icon: path.join(__dirname, '../../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    backgroundColor: '#1e1e1e',
  });

  if (!app.isPackaged) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  // The window only ever shows the app itself; links go to the browser.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  attachContextMenu(mainWindow);
}

function isAppUrl(url: string): boolean {
  if (!app.isPackaged && url.startsWith(DEV_URL)) return true;
  return url.startsWith('file://');
}

/** Only the app's own window may call the handlers. */
function trusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return mainWindow != null && event.sender === mainWindow.webContents && isAppUrl(url);
}

function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Refused.');
    return fn(...args);
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update ready',
        message: `Playtime ROI ${info.version} has been downloaded.`,
        detail: 'Restart now to install it, or it will install the next time you quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0) autoUpdater.quitAndInstall();
      });
  });
  autoUpdater.on('error', (err) => console.error('Auto-update error:', err?.message ?? err));
  autoUpdater.checkForUpdates().catch((err) => console.error('Failed to check for updates:', err?.message ?? err));
}

function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return Promise.resolve({ status: 'unsupported' });
  return new Promise((resolve) => {
    const cleanup = () => {
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('error', onError);
    };
    const onAvailable = (info: { version: string }) => {
      cleanup();
      resolve({ status: 'available', version: info.version });
    };
    const onNotAvailable = () => {
      cleanup();
      resolve({ status: 'not-available' });
    };
    const onError = (err: Error) => {
      cleanup();
      resolve({ status: 'error', message: err?.message ?? String(err) });
    };
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);
    autoUpdater.checkForUpdates().catch(onError);
  });
}

// ---------------------------------------------------------------------------
// Steam Guard: the main process asks the window for a code and waits.

let pendingGuard: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null;

function askForSteamGuard(request: SteamGuardRequest): Promise<string> {
  pendingGuard?.reject(new SteamCancelledError());
  return new Promise<string>((resolve, reject) => {
    pendingGuard = { resolve, reject };
    mainWindow?.webContents.send('steam:guard', request);
  });
}

function openSteamSession(): SteamSession {
  return new SteamSession(createRealSteamUser, {
    onRefreshToken: (token) => secrets.set('steamRefreshToken', token),
    onSteamGuard: askForSteamGuard,
  });
}

// ---------------------------------------------------------------------------
// Sync: one at a time; a second request gets the one already running.

let running: Promise<SyncResult> | null = null;

function syncDeps(): SyncDeps {
  if (!store) throw new Error('The database is not open.');
  return {
    store,
    secrets,
    fetch: globalThis.fetch as unknown as FetchLike,
    openSteam: openSteamSession,
    now: () => Math.floor(Date.now() / 1000),
    onProgress: (p) => mainWindow?.webContents.send('sync:progress', p),
    paymentNames: paymentMethodNames(),
  };
}

function startSync(run: (deps: SyncDeps) => Promise<SyncResult>): Promise<SyncResult> {
  if (running) return running;
  running = run(syncDeps())
    .catch((err): SyncResult => ({
      ok: false,
      phase: 'error',
      message: err instanceof Error ? err.message : 'The sync failed.',
      games: 0,
      pricesLookedUp: 0,
      finishedAt: Math.floor(Date.now() / 1000),
    }))
    .finally(() => {
      running = null;
    });
  return running;
}

async function signInAndSync(accountName: string, password: string): Promise<SyncResult> {
  if (running) await running.catch(() => undefined);
  if (!secrets.encryptionAvailable()) {
    return { ok: false, phase: 'error', message: "This computer can't encrypt the saved sign-in, so it was not started.", games: 0, pricesLookedUp: 0, finishedAt: Math.floor(Date.now() / 1000) };
  }
  const session = openSteamSession();
  try {
    const account = await session.signIn({ accountName: accountName.trim(), password });
    secrets.set('steamAccountName', accountName.trim());
    return await startSync((deps) => runSync(deps, { session, account }));
  } catch (err) {
    session.close();
    const message =
      err instanceof SteamAuthError || err instanceof SteamCancelledError ? err.message : err instanceof Error ? err.message : 'Sign-in failed.';
    return { ok: false, phase: 'needs-login', message, games: 0, pricesLookedUp: 0, finishedAt: Math.floor(Date.now() / 1000) };
  }
}

const LINKS: Record<string, string> = {
  steamKey: 'https://steamcommunity.com/dev/apikey',
  itadKey: 'https://isthereanydeal.com/apps/my/',
  steamPrivacy: 'https://steamcommunity.com/my/edit/settings',
};

function registerIPCHandlers() {
  handle('games:list', () => store?.listGames() ?? []);
  handle('games:setManualPrice', (appId: unknown, cents: unknown, currency: unknown) => {
    const id = Number(appId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Not a game.');
    if (cents == null) store?.setManualPrice(id, null, Math.floor(Date.now() / 1000));
    else store?.setManualPrice(id, { cents: Number(cents), currency: String(currency).toUpperCase() }, Math.floor(Date.now() / 1000));
    return { success: true };
  });

  handle('sync:run', () => startSync((deps) => runSync(deps)));
  handle('sync:lastSyncedAt', () => {
    const v = store?.getMeta(META_LAST_SYNC);
    return v ? Number(v) : null;
  });

  handle('steam:signIn', (accountName: unknown, password: unknown) => {
    if (typeof accountName !== 'string' || typeof password !== 'string' || accountName.trim() === '' || password === '') {
      throw new Error('Enter your Steam account name and password.');
    }
    return signInAndSync(accountName, password);
  });
  handle('steam:signOut', () => {
    secrets.remove('steamRefreshToken');
    secrets.remove('steamAccountName');
    return { success: true };
  });
  handle('steam:guardCode', (code: unknown) => {
    if (typeof code !== 'string' || code.trim() === '') return { success: false };
    const pending = pendingGuard;
    pendingGuard = null;
    pending?.resolve(code);
    return { success: pending != null };
  });
  handle('steam:guardCancel', () => {
    const pending = pendingGuard;
    pendingGuard = null;
    pending?.reject(new SteamCancelledError());
    return { success: true };
  });

  handle('credentials:status', (): CredentialStatus => ({
    steamWebApiKey: secrets.has('steamWebApiKey'),
    itadApiKey: secrets.has('itadApiKey'),
    steamSignedIn: secrets.has('steamRefreshToken'),
    encryptionAvailable: secrets.encryptionAvailable(),
  }));
  handle('credentials:setKey', (name: unknown, value: unknown) => {
    if (name !== 'steamWebApiKey' && name !== 'itadApiKey') throw new Error('Unknown key.');
    if (typeof value !== 'string') throw new Error('A key is text.');
    secrets.set(name, value);
    return { success: true };
  });
  handle('credentials:removeKey', (name: unknown) => {
    if (name !== 'steamWebApiKey' && name !== 'itadApiKey') throw new Error('Unknown key.');
    secrets.remove(name);
    return { success: true };
  });

  handle('settings:get', () => ({ country: store ? getCountry(store) : 'US' }));
  handle('settings:setCountry', (country: unknown) => {
    const c = String(country ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) throw new Error('A country is a two-letter code like US.');
    store?.setMeta(META_COUNTRY, c);
    return { success: true };
  });

  handle('dbLocation:get', () => ({
    path: getEffectiveDbPath(),
    isDefault: isUsingDefaultLocation(),
    defaultPath: getDefaultDbPath(),
    sizeBytes: getDbFileSize(),
  }));
  handle('dbLocation:browseExisting', async () => {
    if (!mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an existing Playtime ROI database file',
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dbLocation:browseNew', async () => {
    if (!mainWindow) return null;
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Choose where to store the Playtime ROI database',
      defaultPath: 'playtime-roi.db',
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return r.canceled ? null : (r.filePath ?? null);
  });
  handle('dbLocation:set', async (newPath: unknown) => {
    if (typeof newPath !== 'string' || newPath.trim() === '') throw new Error('No file chosen.');
    if (running) await running.catch(() => undefined);
    store?.close();
    store = null;
    setDbPath(newPath);
    app.relaunch();
    app.exit();
    return { success: true };
  });
  handle('dbLocation:resetToDefault', async () => {
    if (running) await running.catch(() => undefined);
    store?.close();
    store = null;
    resetToDefaultDbPath();
    app.relaunch();
    app.exit();
    return { success: true };
  });

  handle('app:getVersion', () => app.getVersion());
  handle('app:openLink', (which: unknown, appId: unknown) => {
    let url: string | undefined;
    if (which === 'store') {
      const id = Number(appId);
      if (Number.isInteger(id) && id > 0) url = `https://store.steampowered.com/app/${id}/`;
    } else if (typeof which === 'string') {
      url = LINKS[which];
    }
    if (url) void shell.openExternal(url);
    return { success: Boolean(url) };
  });
  handle('updates:check', () => checkForUpdatesNow());
}

app.whenReady().then(async () => {
  const configuredDbPath = getConfiguredDbPath();
  if (configuredDbPath && !fs.existsSync(configuredDbPath)) {
    const r = await dialog.showMessageBox({
      type: 'error',
      title: 'Database not found',
      message: "Playtime ROI can't find your configured database file.",
      detail: `Expected it at:\n${configuredDbPath}\n\nThis can happen if a drive is disconnected or a synced folder hasn't loaded yet. Reconnect it and relaunch, or switch back to the default location.`,
      buttons: ['Quit', 'Use Default Location'],
      defaultId: 0,
      cancelId: 0,
    });
    if (r.response === 1) {
      resetToDefaultDbPath();
      app.relaunch();
    }
    app.exit();
    return;
  }

  store = new Store(getEffectiveDbPath());
  secrets = SecretStore.inDirectory(app.getPath('userData'), safeStorage);

  registerIPCHandlers();
  setupApplicationMenu();
  createWindow();
  appInitialized = true;
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  try {
    store?.close();
  } catch {
    // already closed
  }
  store = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
