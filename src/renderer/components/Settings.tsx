import { useEffect, useState } from 'react';
import type { CredentialStatus, DbLocationInfo, SteamFolderInfo, SyncResult, UpdateCheckResult } from '../../shared/types';
import type { ApiKeyName, LinkName } from '../global';
import { applyTheme, AVAILABLE_THEMES, DEFAULT_THEME, getStoredTheme, saveTheme, Theme, THEME_LABELS } from '../utils/themes';

interface Props {
  credentials: CredentialStatus;
  syncing: boolean;
  onChanged: () => Promise<void>;
  onSignIn: (accountName: string, password: string) => Promise<SyncResult>;
  onSync: () => Promise<void>;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function KeyField({ name, label, saved, link, linkLabel, onChanged }: { name: ApiKeyName; label: string; saved: boolean; link: LinkName; linkLabel: string; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const api = window.playtimeRoi;
  return (
    <div className="field">
      <label>
        {label} <span className={saved ? 'ok-text' : 'muted'}>{saved ? 'Saved' : 'Not set'}</span>
      </label>
      <div className="row-actions">
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={saved ? 'Type a new key to replace it' : 'API key'} autoComplete="off" spellCheck={false} />
        <button
          className="primary"
          disabled={!value.trim()}
          onClick={async () => {
            try {
              setError(null);
              await api.credentials.setKey(name, value);
              setValue('');
              await onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Not saved.');
            }
          }}
        >
          Save
        </button>
        {saved && (
          <button
            onClick={async () => {
              await api.credentials.removeKey(name);
              await onChanged();
            }}
          >
            Remove
          </button>
        )}
      </div>
      <button className="link" onClick={() => void api.app.openLink(link)}>
        {linkLabel}
      </button>
      {error && <p className="warn-text">{error}</p>}
    </div>
  );
}

export default function Settings({ credentials, syncing, onChanged, onSignIn, onSync }: Props) {
  const api = window.playtimeRoi;
  const [accountName, setAccountName] = useState('');
  const [password, setPassword] = useState('');
  const [signInMessage, setSignInMessage] = useState<string | null>(null);
  const [country, setCountry] = useState('');
  const [countryMessage, setCountryMessage] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getStoredTheme() ?? DEFAULT_THEME);
  const [db, setDb] = useState<DbLocationInfo | null>(null);
  const [steamFolder, setSteamFolder] = useState<SteamFolderInfo | null>(null);
  const [steamFolderError, setSteamFolderError] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    void api.settings.get().then((s) => setCountry(s.country));
    void api.dbLocation.get().then(setDb);
    void api.app.getVersion().then(setVersion);
  }, [api]);

  // The status line comes from the last sync, so read it again when one finishes.
  useEffect(() => {
    if (!syncing) void api.steamFolder.get().then(setSteamFolder);
  }, [api, syncing]);

  const changeSteamFolder = async (folder: string | null) => {
    try {
      setSteamFolderError(null);
      await api.steamFolder.set(folder);
      setSteamFolder(await api.steamFolder.get());
    } catch (err) {
      setSteamFolderError(err instanceof Error ? err.message : 'Not saved.');
    }
  };

  const moveDb = async (pick: () => Promise<string | null>) => {
    const chosen = await pick();
    if (chosen) await api.dbLocation.set(chosen);
  };

  return (
    <div className="settings">
      <section className="panel">
        <h2>Keys</h2>
        <p className="muted">Both are free. They are saved encrypted on this computer only and never shown again.</p>
        {!credentials.encryptionAvailable && <p className="warn-text">This computer can't encrypt saved secrets right now, so nothing can be saved.</p>}
        <KeyField name="steamWebApiKey" label="Steam Web API key" saved={credentials.steamWebApiKey} link="steamKey" linkLabel="Get a Steam Web API key" onChanged={onChanged} />
        <KeyField name="itadApiKey" label="IsThereAnyDeal API key" saved={credentials.itadApiKey} link="itadKey" linkLabel="Get an IsThereAnyDeal key" onChanged={onChanged} />
      </section>

      <section className="panel">
        <h2>Steam sign-in</h2>
        <p className="muted">
          Used once to read when each game came into your library. Your password is not saved: only the sign-in token Steam gives back, encrypted on this computer.
          Your profile's Game details must be public for playtime.{' '}
          <button className="link" onClick={() => void api.app.openLink('steamPrivacy')}>
            Steam privacy settings
          </button>
        </p>
        {credentials.steamSignedIn ? (
          <div className="row-actions">
            <span className="ok-text">Signed in</span>
            <button
              onClick={async () => {
                await api.steam.signOut();
                await onChanged();
              }}
            >
              Sign out
            </button>
          </div>
        ) : (
          <form
            className="sign-in"
            onSubmit={async (e) => {
              e.preventDefault();
              setSignInMessage(null);
              const result = await onSignIn(accountName, password);
              setPassword('');
              setSignInMessage(result.ok ? null : result.message);
            }}
          >
            <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Steam account name" autoComplete="username" spellCheck={false} />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
            <button type="submit" className="primary" disabled={syncing || !accountName.trim() || !password || !credentials.encryptionAvailable}>
              Sign in and sync
            </button>
          </form>
        )}
        {signInMessage && <p className="warn-text">{signInMessage}</p>}
      </section>

      <section className="panel">
        <h2>Prices</h2>
        <div className="field">
          <label>Store country (two letters, for the Steam price region)</label>
          <div className="row-actions">
            <input className="short" value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
            <button
              onClick={async () => {
                try {
                  await api.settings.setCountry(country);
                  setCountryMessage('Saved. Prices will be looked up again on the next sync.');
                } catch (err) {
                  setCountryMessage(err instanceof Error ? err.message : 'Not saved.');
                }
              }}
            >
              Save
            </button>
            <button disabled={syncing} onClick={() => void onSync()}>
              Sync now
            </button>
          </div>
          {countryMessage && <p className="muted">{countryMessage}</p>}
        </div>
      </section>

      <section className="panel">
        <h2>Steam folder</h2>
        <p className="muted">Read-only. Used to show which games are installed, where, and how big. It is optional and read again on every sync.</p>
        {steamFolder && (
          <>
            <p className="mono">{steamFolder.path ?? 'No Steam folder found'}</p>
            <p className="muted">
              {steamFolder.isDefault ? 'Default location' : 'Custom location'}
              {steamFolder.status ? ` · ${steamFolder.status}` : ''}
            </p>
          </>
        )}
        <div className="row-actions">
          <button
            onClick={async () => {
              const chosen = await api.steamFolder.browse();
              if (chosen) await changeSteamFolder(chosen);
            }}
          >
            Browse…
          </button>
          {steamFolder && !steamFolder.isDefault && <button onClick={() => void changeSteamFolder(null)}>Use default</button>}
          <button disabled={syncing} onClick={() => void onSync()}>
            Sync now
          </button>
        </div>
        {steamFolderError && <p className="warn-text">{steamFolderError}</p>}
      </section>

      <section className="panel">
        <h2>Theme</h2>
        <select
          value={theme}
          onChange={(e) => {
            const t = e.target.value as Theme;
            setTheme(t);
            saveTheme(t);
            applyTheme(t);
          }}
        >
          {AVAILABLE_THEMES.map((t) => (
            <option key={t} value={t}>
              {THEME_LABELS[t]}
            </option>
          ))}
        </select>
      </section>

      <section className="panel">
        <h2>Database location</h2>
        {db && (
          <>
            <p className="mono">{db.path}</p>
            <p className="muted">
              {db.isDefault ? 'Default location' : 'Custom location'}
              {db.sizeBytes != null ? ` · ${formatSize(db.sizeBytes)}` : ''}
            </p>
          </>
        )}
        <div className="row-actions">
          <button onClick={() => void moveDb(api.dbLocation.browseExisting)}>Use an existing file…</button>
          <button onClick={() => void moveDb(api.dbLocation.browseNew)}>Move to a new file…</button>
          {db && !db.isDefault && <button onClick={() => void api.dbLocation.resetToDefault()}>Back to the default</button>}
        </div>
        <p className="muted">The app restarts after a change.</p>
      </section>

      <section className="panel">
        <h2>About</h2>
        <p>Playtime ROI {version}</p>
        <div className="row-actions">
          <button onClick={async () => setUpdate(await api.updates.check())}>Check for updates</button>
          {update && (
            <span className="muted">
              {update.status === 'available'
                ? `Version ${update.version} is downloading.`
                : update.status === 'not-available'
                  ? 'Up to date.'
                  : update.message ?? 'Could not check.'}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
