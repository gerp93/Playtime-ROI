import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { EncryptionUnavailableError, SecretStore } from './secrets';
import { fakeSafeStorage, tempDir } from './testing/fakes';

test('secrets are saved encrypted, read back, and removed', () => {
  const dir = tempDir();
  const store = SecretStore.inDirectory(dir, fakeSafeStorage());
  store.set('steamWebApiKey', '  ABCDEF123  ');
  assert.equal(store.get('steamWebApiKey'), 'ABCDEF123');
  assert.equal(store.has('itadApiKey'), false);
  const onDisk = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf-8');
  assert.equal(onDisk.includes('ABCDEF123'), false, 'the key is not stored in plain text');
  store.set('steamWebApiKey', '');
  assert.equal(store.get('steamWebApiKey'), null);
});

test('nothing is saved when encryption is unavailable', () => {
  const dir = tempDir();
  const store = SecretStore.inDirectory(dir, fakeSafeStorage(false));
  assert.throws(() => store.set('itadApiKey', 'x'), EncryptionUnavailableError);
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false);
});

test('a value that cannot be decrypted reads as missing', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ itadApiKey: Buffer.from('garbage').toString('base64') }));
  assert.equal(SecretStore.inDirectory(dir, fakeSafeStorage()).get('itadApiKey'), null);
});
