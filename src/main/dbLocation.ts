// Where the SQLite file lives (KVG_Standards db-location-versioning.md):
// a user-chosen path in app-config.json, or the default in userData.
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

interface AppConfig {
  dbPath?: string;
}

// A dev run (npm run dev) and an installed build must never share a userData
// folder, so dev gets its own. Must run before anything reads
// app.getPath('userData'), and before 'ready'.
export function pinUserDataPath(): void {
  const dirName = app.isPackaged ? 'playtime-roi' : 'playtime-roi-dev';
  app.setPath('userData', path.join(app.getPath('appData'), dirName));
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'app-config.json');
}

function readConfig(): AppConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: AppConfig): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export function getDefaultDbPath(): string {
  return path.join(app.getPath('userData'), 'playtime-roi.db');
}

/** The raw configured override, if any. Does NOT fall back to the default. */
export function getConfiguredDbPath(): string | undefined {
  const configured = readConfig().dbPath;
  return configured && configured.trim() !== '' ? configured : undefined;
}

export function getEffectiveDbPath(): string {
  return getConfiguredDbPath() ?? getDefaultDbPath();
}

export function isUsingDefaultLocation(): boolean {
  return !getConfiguredDbPath();
}

export function getDbFileSize(): number | null {
  try {
    return fs.statSync(getEffectiveDbPath()).size;
  } catch {
    return null;
  }
}

/**
 * Point the app at a different SQLite file. If nothing exists there yet, the
 * current database is copied there first. The caller must close the database
 * before calling this: in WAL mode recent writes sit in the -wal file until
 * it is closed, and a copy taken while it is open can miss them.
 */
export function setDbPath(newPath: string): void {
  const currentPath = getEffectiveDbPath();
  if (!fs.existsSync(newPath) && fs.existsSync(currentPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.copyFileSync(currentPath, newPath);
  }
  writeConfig({ ...readConfig(), dbPath: newPath });
}

export function resetToDefaultDbPath(): void {
  const config = readConfig();
  delete config.dbPath;
  writeConfig(config);
}
