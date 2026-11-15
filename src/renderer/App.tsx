import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CredentialStatus, GameRow, SteamGuardRequest, SyncProgress, SyncResult } from '../shared/types';
import { summarize } from '../shared/value';
import Dashboard from './components/Dashboard';
import Library from './components/Library';
import Settings from './components/Settings';
import SteamGuardDialog from './components/SteamGuardDialog';
import SyncBar from './components/SyncBar';

type Tab = 'dashboard' | 'library' | 'settings';

export default function App() {
  const api = window.playtimeRoi;
  const [tab, setTab] = useState<Tab>('dashboard');
  const [games, setGames] = useState<GameRow[]>([]);
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [guard, setGuard] = useState<SteamGuardRequest | null>(null);
  const startedOnOpen = useRef(false);

  const reload = useCallback(async () => {
    const [list, creds, last] = await Promise.all([api.games.list(), api.credentials.status(), api.sync.lastSyncedAt()]);
    setGames(list);
    setCredentials(creds);
    setLastSyncedAt(last);
  }, [api]);

  const finish = useCallback(
    async (result: SyncResult) => {
      setLastResult(result);
      setSyncing(false);
      setProgress(null);
      await reload();
      if (result.phase === 'needs-keys' || result.phase === 'needs-login') setTab('settings');
    },
    [reload]
  );

  const sync = useCallback(async () => {
    setSyncing(true);
    setLastResult(null);
    await finish(await api.sync.run());
  }, [api, finish]);

  const signIn = useCallback(
    async (accountName: string, password: string) => {
      setSyncing(true);
      setLastResult(null);
      const result = await api.steam.signIn(accountName, password);
      await finish(result);
      return result;
    },
    [api, finish]
  );

  useEffect(() => api.sync.onProgress((p) => setProgress(p)), [api]);
  useEffect(() => api.steam.onGuard((r) => setGuard(r)), [api]);

  // Sync once when the app opens; it catches up on everything since the last sync.
  useEffect(() => {
    if (startedOnOpen.current) return;
    startedOnOpen.current = true;
    void reload().then(sync);
  }, [reload, sync]);

  const summary = useMemo(() => summarize(games), [games]);

  const setManualPrice = useCallback(
    async (appId: number, cents: number | null) => {
      await api.games.setManualPrice(appId, cents, summary.currency);
      setGames(await api.games.list());
    },
    [api, summary.currency]
  );

  return (
    <div className="app">
      <header className="top-bar">
        <h1 className="brand">Playtime ROI</h1>
        <nav className="tabs">
          {(['dashboard', 'library', 'settings'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t === 'dashboard' ? 'Dashboard' : t === 'library' ? 'Library' : 'Settings'}
            </button>
          ))}
        </nav>
        <button className="primary" onClick={() => void sync()} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </header>
      <SyncBar syncing={syncing} progress={progress} result={lastResult} lastSyncedAt={lastSyncedAt} />
      <main className="content">
        {tab === 'dashboard' && <Dashboard summary={summary} hasGames={games.length > 0} onOpenLibrary={() => setTab('library')} />}
        {tab === 'library' && <Library games={games} currency={summary.currency} onSetManualPrice={setManualPrice} />}
        {tab === 'settings' && credentials && (
          <Settings credentials={credentials} syncing={syncing} onChanged={reload} onSignIn={signIn} onSync={sync} />
        )}
      </main>
      {guard && (
        <SteamGuardDialog
          request={guard}
          onSubmit={async (code) => {
            setGuard(null);
            await api.steam.sendGuardCode(code);
          }}
          onCancel={async () => {
            setGuard(null);
            await api.steam.cancelGuard();
          }}
        />
      )}
    </div>
  );
}
