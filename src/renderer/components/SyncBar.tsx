import type { SyncProgress, SyncResult } from '../../shared/types';

interface Props {
  syncing: boolean;
  progress: SyncProgress | null;
  result: SyncResult | null;
  lastSyncedAt: number | null;
}

export default function SyncBar({ syncing, progress, result, lastSyncedAt }: Props) {
  if (syncing) {
    const pct = progress?.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : null;
    return (
      <div className="sync-bar">
        <span>{progress?.message ?? 'Starting the sync…'}</span>
        {pct != null && (
          <span className="progress" aria-label={`${pct}%`}>
            <span className="progress-fill" style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
    );
  }
  if (result) {
    return <div className={result.ok ? 'sync-bar' : 'sync-bar warn'}>{result.message}</div>;
  }
  return (
    <div className="sync-bar muted">
      {lastSyncedAt ? `Last synced ${new Date(lastSyncedAt * 1000).toLocaleString()}` : 'Not synced yet.'}
    </div>
  );
}
