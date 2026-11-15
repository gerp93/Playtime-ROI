// Keeps the API keys and the Steam sign-in token on this computer only,
// encrypted with the operating system's own key store through Electron's
// safeStorage (DPAPI on Windows, the Keychain on macOS, the secret service
// on Linux). The Steam password is never stored: only the refresh token
// Steam hands back after sign-in. Nothing in here is ever logged.
import * as fs from 'fs';
import * as path from 'path';

/** The part of Electron's safeStorage this uses, injected so tests can supply a fake. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type SecretName = 'steamWebApiKey' | 'itadApiKey' | 'steamRefreshToken' | 'steamAccountName';

const NAMES: SecretName[] = ['steamWebApiKey', 'itadApiKey', 'steamRefreshToken', 'steamAccountName'];

export class EncryptionUnavailableError extends Error {
  constructor() {
    super("This computer can't encrypt saved secrets right now, so nothing was saved.");
    this.name = 'EncryptionUnavailableError';
  }
}

export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  static inDirectory(dir: string, safeStorage: SafeStorageLike): SecretStore {
    return new SecretStore(path.join(dir, 'secrets.json'), safeStorage);
  }

  encryptionAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private readFile(): Partial<Record<SecretName, string>> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>;
      const out: Partial<Record<SecretName, string>> = {};
      for (const name of NAMES) {
        if (typeof parsed[name] === 'string') out[name] = parsed[name] as string;
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeFile(data: Partial<Record<SecretName, string>>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  has(name: SecretName): boolean {
    return this.get(name) != null;
  }

  /** The decrypted value, or null when none is saved or it can't be decrypted (e.g. copied from another computer). */
  get(name: SecretName): string | null {
    const stored = this.readFile()[name];
    if (!stored || !this.encryptionAvailable()) return null;
    try {
      const value = this.safeStorage.decryptString(Buffer.from(stored, 'base64'));
      return value === '' ? null : value;
    } catch {
      return null;
    }
  }

  set(name: SecretName, value: string): void {
    const trimmed = value.trim();
    if (trimmed === '') {
      this.remove(name);
      return;
    }
    if (!this.encryptionAvailable()) throw new EncryptionUnavailableError();
    const data = this.readFile();
    data[name] = this.safeStorage.encryptString(trimmed).toString('base64');
    this.writeFile(data);
  }

  remove(name: SecretName): void {
    const data = this.readFile();
    if (!(name in data)) return;
    delete data[name];
    this.writeFile(data);
  }
}
