import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { defaultSteamFolder, installDriveOf, readLocalSteam } from './localFiles';
import { tempDir } from '../testing/fakes';

const STEAM_ID = '76561197960266728'; // account 1000

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function manifest(dir: string, appId: number, flags: number, size: number): void {
  write(path.join(dir, 'steamapps', `appmanifest_${appId}.acf`), `"AppState"\n{\n"appid" "${appId}"\n"name" "G${appId}"\n"StateFlags" "${flags}"\n"SizeOnDisk" "${size}"\n}\n`);
}

/** A Steam folder and a second library, with installs and collections for account 1000. */
function fixture(): { steam: string; lib: string } {
  const root = tempDir();
  const steam = path.join(root, 'Steam');
  const lib = path.join(root, 'Library2');
  write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n"0" { "path" "${steam.replace(/\\/g, '\\\\')}" }\n"1" { "path" "${lib.replace(/\\/g, '\\\\')}" }\n}\n`);
  fs.mkdirSync(path.join(lib, 'steamapps'), { recursive: true });
  manifest(steam, 10, 4, 1000);
  manifest(steam, 11, 1026, 5); // update pending, not fully installed
  manifest(lib, 20, 4, 2000);
  return { steam, lib };
}

function cloud(steam: string, entries: unknown): void {
  write(path.join(steam, 'userdata', '1000', 'config', 'cloudstorage', 'cloud-storage-namespace-1.json'), JSON.stringify(entries));
}

test('libraries and fully installed games come from the manifests', () => {
  const { steam, lib } = fixture();
  const info = readLocalSteam({ folder: steam, steamId64: STEAM_ID });
  assert.equal(info.found, true);
  assert.deepEqual(info.libraries, [steam, lib]);
  assert.deepEqual([...info.installs.keys()].sort(), [10, 20]);
  assert.deepEqual(info.installs.get(20), { libraryPath: lib, sizeOnDisk: 2000 });
  assert.equal(info.hidden, null, 'no userdata folder: collections unread');
  assert.equal(info.favorites, null);
});

test('the old libraryfolders layout is read too', () => {
  const { steam, lib } = fixture();
  write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"LibraryFolders"\n{\n"TimeNextStatsReport" "1"\n"ContentStatsID" "2"\n"1" "${lib.replace(/\\/g, '\\\\')}"\n}\n`);
  const info = readLocalSteam({ folder: steam, steamId64: null });
  assert.deepEqual(info.libraries, [steam, lib]);
  assert.equal(info.installs.size, 2);
});

test('collections come from the cloud storage file', () => {
  const { steam } = fixture();
  cloud(steam, [
    ['user-collections.hidden', { key: 'user-collections.hidden', timestamp: 1, version: '1', value: JSON.stringify({ id: 'hidden', name: '', added: [10, 30, 40], removed: [40] }) }],
    ['user-collections.favorite', { key: 'user-collections.favorite', timestamp: 1, version: '1', value: JSON.stringify({ id: 'favorite', added: [20], removed: [] }) }],
    ['user-collections.other', { key: 'user-collections.other', value: 'not json at all' }],
  ]);
  const info = readLocalSteam({ folder: steam, steamId64: STEAM_ID });
  assert.deepEqual([...(info.hidden ?? [])].sort(), [10, 30]);
  assert.deepEqual([...(info.favorites ?? [])], [20]);
});

test('deleted or missing collection entries are empty, a broken one is unread', () => {
  const { steam } = fixture();
  cloud(steam, [
    ['user-collections.hidden', { key: 'user-collections.hidden', is_deleted: true, value: JSON.stringify({ added: [10] }) }],
    ['user-collections.favorite', { key: 'user-collections.favorite', value: '{broken' }],
  ]);
  const info = readLocalSteam({ folder: steam, steamId64: STEAM_ID });
  assert.equal(info.hidden?.size, 0);
  assert.equal(info.favorites, null);
});

test('a malformed cloud storage file leaves both collections unread', () => {
  const { steam } = fixture();
  write(path.join(steam, 'userdata', '1000', 'config', 'cloudstorage', 'cloud-storage-namespace-1.json'), '{nope');
  const info = readLocalSteam({ folder: steam, steamId64: STEAM_ID });
  assert.equal(info.found, true);
  assert.equal(info.hidden, null);
  assert.equal(info.favorites, null);
  assert.equal(info.installs.size, 2);
});

test('the old sharedconfig.vdf is used when the JSON file is missing', () => {
  const { steam } = fixture();
  write(
    path.join(steam, 'userdata', '1000', '7', 'remote', 'sharedconfig.vdf'),
    `"UserRoamingConfigStore"\n{\n"Software"\n{\n"Valve"\n{\n"Steam"\n{\n"apps"\n{\n"10" { "Hidden" "1" }\n"20" { "tags" { "0" "favorite" "1" "RPG" } }\n"30" { "Hidden" "0" }\n}\n}\n}\n}\n}\n`
  );
  const info = readLocalSteam({ folder: steam, steamId64: STEAM_ID });
  assert.deepEqual([...(info.hidden ?? [])], [10]);
  assert.deepEqual([...(info.favorites ?? [])], [20]);
});

test('with no Steam ID the only numeric userdata folder is used, several are not', () => {
  const { steam } = fixture();
  cloud(steam, [['user-collections.favorite', { value: JSON.stringify({ added: [10] }) }]]);
  assert.deepEqual([...(readLocalSteam({ folder: steam, steamId64: null }).favorites ?? [])], [10]);
  fs.mkdirSync(path.join(steam, 'userdata', '2000'));
  fs.mkdirSync(path.join(steam, 'userdata', '0'));
  assert.equal(readLocalSteam({ folder: steam, steamId64: null }).favorites, null);
  assert.deepEqual([...(readLocalSteam({ folder: steam, steamId64: STEAM_ID }).favorites ?? [])], [10]);
});

test('missing folders and broken manifests never throw', () => {
  const nothing = readLocalSteam({ folder: path.join(tempDir(), 'nope'), steamId64: null });
  assert.equal(nothing.found, false);
  assert.equal(nothing.installs.size, 0);

  const { steam } = fixture();
  write(path.join(steam, 'steamapps', 'appmanifest_99.acf'), '"AppState" {');
  write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'garbage {');
  const info = readLocalSteam({ folder: steam, steamId64: STEAM_ID });
  assert.equal(info.found, true);
  assert.deepEqual(info.libraries, [steam]);
  assert.deepEqual([...info.installs.keys()], [10]);

  const empty = tempDir();
  assert.equal(readLocalSteam({ folder: empty, steamId64: null }).found, false, 'a folder that is not Steam');
});

test('platform defaults and the install drive', () => {
  assert.equal(defaultSteamFolder('win32', 'C:\\Users\\a'), 'C:\\Program Files (x86)\\Steam');
  assert.equal(defaultSteamFolder('darwin', '/Users/a'), path.join('/Users/a', 'Library', 'Application Support', 'Steam'));
  const home = tempDir();
  assert.equal(defaultSteamFolder('linux', home), null);
  fs.mkdirSync(path.join(home, '.local', 'share', 'Steam'), { recursive: true });
  assert.equal(defaultSteamFolder('linux', home), path.join(home, '.local', 'share', 'Steam'));
  fs.mkdirSync(path.join(home, '.steam', 'steam'), { recursive: true });
  assert.equal(defaultSteamFolder('linux', home), path.join(home, '.steam', 'steam'));
  assert.equal(installDriveOf('d:\\SteamLibrary'), 'D:');
  assert.equal(installDriveOf('/mnt/games/Steam'), '/mnt/games/Steam');
});
