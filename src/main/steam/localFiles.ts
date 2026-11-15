// Reads what Steam keeps on this computer: which games are installed, where
// and how big, and the user's collections. Read-only: nothing here ever
// writes to the Steam folder, and no file's contents are logged. Every read
// tolerates a missing, locked or malformed file and reports it as "could not
// read" (null) instead of throwing, so a sync never fails because of it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseVdf, vdfGet, vdfObject, vdfPath, vdfString, VdfObject } from '../../shared/vdf';

/** What a sync learned from the Steam folder. null means that part could not be read. */
export interface LocalSteamInfo {
  found: boolean;
  /** The library folders that exist, the Steam folder itself first. */
  libraries: string[];
  installs: Map<number, { libraryPath: string; sizeOnDisk: number }>;
  hidden: Set<number> | null;
  favorites: Set<number> | null;
}

export interface FsLike {
  readText(file: string): string;
  listDir(dir: string): string[];
  isDir(p: string): boolean;
  exists(p: string): boolean;
}

export const realFs: FsLike = {
  readText: (file) => fs.readFileSync(file, 'utf-8'),
  listDir: (dir) => fs.readdirSync(dir),
  isDir: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  exists: (p) => fs.existsSync(p),
};

const STEAM_ID64_BASE = 76561197960265728n;
/** StateFlags bit 4: the game is fully installed. */
const STATE_FULLY_INSTALLED = 4;

export const NOT_FOUND: LocalSteamInfo = { found: false, libraries: [], installs: new Map(), hidden: null, favorites: null };

export interface ReadOptions {
  /** The folder the user chose, or null for the platform default. */
  folder: string | null;
  steamId64: string | null;
  fs?: FsLike;
  platform?: NodeJS.Platform;
  home?: string;
}

/** Where Steam usually lives, or null when it is not in any usual place. */
export function defaultSteamFolder(platform: NodeJS.Platform = process.platform, home: string = os.homedir(), f: FsLike = realFs): string | null {
  if (platform === 'win32') return 'C:\\Program Files (x86)\\Steam';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Steam');
  for (const candidate of [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam')]) {
    if (f.isDir(candidate)) return candidate;
  }
  return null;
}

/** The drive of a Windows library path ("D:"), else the library path itself. */
export function installDriveOf(libraryPath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(libraryPath) || /^[A-Za-z]:$/.test(libraryPath)) return libraryPath.slice(0, 2).toUpperCase();
  return libraryPath;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, '');
    return /^[A-Za-z]:/.test(trimmed) ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

function readVdf(f: FsLike, file: string): VdfObject | null {
  try {
    return parseVdf(f.readText(file));
  } catch {
    return null;
  }
}

/** Library folder paths from libraryfolders.vdf, in both the new and the old layout. */
function libraryPaths(f: FsLike, steamFolder: string): string[] {
  const out: string[] = [];
  const doc = readVdf(f, path.join(steamFolder, 'steamapps', 'libraryfolders.vdf'));
  const root = vdfObject(doc ?? undefined, 'libraryfolders');
  if (root) {
    for (const [key, value] of root) {
      if (!/^\d+$/.test(key)) continue;
      const p = typeof value === 'string' ? value : vdfString(value, 'path');
      if (p && p.trim() !== '') out.push(p);
    }
  }
  return out;
}

function readInstalls(f: FsLike, library: string, into: LocalSteamInfo['installs']): void {
  let names: string[];
  try {
    names = f.listDir(path.join(library, 'steamapps'));
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^appmanifest_(\d+)\.acf$/i.exec(name);
    if (!m) continue;
    const state = vdfObject(readVdf(f, path.join(library, 'steamapps', name)) ?? undefined, 'AppState');
    if (!state) continue;
    const appId = Number(vdfString(state, 'appid') ?? m[1]);
    const flags = Number(vdfString(state, 'StateFlags') ?? 0);
    if (!Number.isInteger(appId) || appId <= 0 || !Number.isFinite(flags)) continue;
    if ((flags & STATE_FULLY_INSTALLED) === 0) continue;
    if (into.has(appId)) continue;
    const size = Number(vdfString(state, 'SizeOnDisk') ?? 0);
    into.set(appId, { libraryPath: library, sizeOnDisk: Number.isFinite(size) && size > 0 ? size : 0 });
  }
}

/** The userdata folder of the account: from the Steam ID, else the only one there is. */
function accountFolder(f: FsLike, steamFolder: string, steamId64: string | null): string | null {
  const userdata = path.join(steamFolder, 'userdata');
  if (steamId64 && /^\d+$/.test(steamId64)) {
    const accountId = BigInt(steamId64) - STEAM_ID64_BASE;
    if (accountId <= 0n) return null;
    const dir = path.join(userdata, accountId.toString());
    return f.isDir(dir) ? dir : null;
  }
  if (steamId64) return null;
  try {
    const numeric = f.listDir(userdata).filter((n) => /^\d+$/.test(n) && n !== '0' && f.isDir(path.join(userdata, n)));
    return numeric.length === 1 ? path.join(userdata, numeric[0]) : null;
  } catch {
    return null;
  }
}

function appIds(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** One collection from the new cloud-storage file; null when its entry is unreadable. */
function jsonCollection(pairs: unknown[], key: string): Set<number> | null {
  const pair = pairs.find((p) => Array.isArray(p) && p[0] === key);
  const entry = pair && (pair as unknown[])[1];
  if (!entry || typeof entry !== 'object') return new Set();
  const e = entry as { is_deleted?: unknown; value?: unknown };
  if (e.is_deleted === true || e.value == null || e.value === '') return new Set();
  try {
    const value = (typeof e.value === 'string' ? JSON.parse(e.value) : e.value) as { added?: unknown; removed?: unknown } | null;
    if (!value || typeof value !== 'object') return null;
    const removed = new Set(appIds(value.removed));
    return new Set(appIds(value.added).filter((id) => !removed.has(id)));
  } catch {
    return null;
  }
}

function readCollections(f: FsLike, account: string): { hidden: Set<number> | null; favorites: Set<number> | null } {
  const json = path.join(account, 'config', 'cloudstorage', 'cloud-storage-namespace-1.json');
  if (f.exists(json)) {
    try {
      const parsed: unknown = JSON.parse(f.readText(json));
      if (!Array.isArray(parsed)) return { hidden: null, favorites: null };
      return { hidden: jsonCollection(parsed, 'user-collections.hidden'), favorites: jsonCollection(parsed, 'user-collections.favorite') };
    } catch {
      return { hidden: null, favorites: null };
    }
  }
  const doc = readVdf(f, path.join(account, '7', 'remote', 'sharedconfig.vdf'));
  if (!doc) return { hidden: null, favorites: null };
  const apps = vdfPath(doc, ['UserRoamingConfigStore', 'Software', 'Valve', 'Steam', 'Apps']);
  const hidden = new Set<number>();
  const favorites = new Set<number>();
  for (const [key, value] of apps ?? []) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0 || typeof value !== 'object') continue;
    if (vdfString(value, 'Hidden') === '1') hidden.add(id);
    const tags = vdfGet(value, 'tags');
    if (tags && typeof tags === 'object') {
      for (const tag of tags.values()) if (typeof tag === 'string' && tag.toLowerCase() === 'favorite') favorites.add(id);
    }
  }
  return { hidden, favorites };
}

/** Reads the Steam folder. Never throws; a folder that is not there answers `found: false`. */
export function readLocalSteam(opts: ReadOptions): LocalSteamInfo {
  try {
    const f = opts.fs ?? realFs;
    const folder = opts.folder ?? defaultSteamFolder(opts.platform, opts.home, f);
    if (!folder || !f.isDir(folder)) return { ...NOT_FOUND, installs: new Map() };
    if (!f.isDir(path.join(folder, 'steamapps')) && !f.isDir(path.join(folder, 'userdata'))) return { ...NOT_FOUND, installs: new Map() };

    const candidates = [folder];
    for (const p of libraryPaths(f, folder)) if (!candidates.some((c) => samePath(c, p))) candidates.push(p);
    const libraries = candidates.filter((c) => f.isDir(path.join(c, 'steamapps')));

    const installs: LocalSteamInfo['installs'] = new Map();
    for (const lib of libraries) readInstalls(f, lib, installs);

    let hidden: Set<number> | null = null;
    let favorites: Set<number> | null = null;
    try {
      const account = accountFolder(f, folder, opts.steamId64);
      if (account) ({ hidden, favorites } = readCollections(f, account));
    } catch {
      // Collections stay unread; installs are still good.
    }
    return { found: true, libraries, installs, hidden, favorites };
  } catch {
    return { ...NOT_FOUND, installs: new Map() };
  }
}
