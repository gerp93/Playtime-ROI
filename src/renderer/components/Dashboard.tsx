import type { DashboardSummary, ValuedGame } from '../../shared/types';
import { formatBytes, formatDate, formatHours, formatMoney, formatPerHour } from '../../shared/value';

interface Props {
  summary: DashboardSummary;
  hasGames: boolean;
  onOpenLibrary: () => void;
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

function GameList({ games, currency, empty }: { games: ValuedGame[]; currency: string; empty: string }) {
  if (games.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ol className="game-list">
      {games.map((g) => (
        <li key={g.appId}>
          <span className="name">{g.name}</span>
          <span className="figure">{formatPerHour(g.costPerHour, currency)}</span>
          <span className="sub">
            {formatHours(g.hours)} · {g.counted ? formatMoney(g.counted.cents, g.counted.currency) : 'price unknown'}
            {g.basis === 'estimate' ? ' (est.)' : ''}
            {g.acquiredAt ? ` · Got it ${formatDate(g.acquiredAt)}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function Dashboard({ summary, hasGames, onOpenLibrary }: Props) {
  const c = summary.currency;
  if (!hasGames) {
    return (
      <section className="panel">
        <h2>No games yet</h2>
        <p>Add your Steam Web API key and sign in to Steam in Settings, then sync.</p>
      </section>
    );
  }
  const paid = summary.ranked.filter((g) => (g.counted?.cents ?? 0) > 0);
  const best = paid.slice(0, 10);
  const worst = paid.slice(-10).reverse();
  const notes: string[] = [];
  if (summary.unknownPriceCount) notes.push(`${summary.unknownPriceCount} with no price`);
  if (summary.otherCurrencyCount) notes.push(`${summary.otherCurrencyCount} in another currency`);

  return (
    <>
      <section className="tiles">
        <Tile label="Total spent" value={formatMoney(summary.totalSpentCents, c)} note={notes.length ? `Leaves out ${notes.join(' and ')}` : 'Mostly estimates'} />
        <Tile label="Cost per hour" value={formatPerHour(summary.overallCostPerHour, c)} note={`${formatHours(summary.totalHours)} played`} />
        <Tile label="Games" value={String(summary.gameCount)} note={`${summary.playedCount} played`} />
        <Tile
          label="Never played"
          value={String(summary.neverPlayed.length)}
          note={summary.neverPlayedSpentCents ? `${formatMoney(summary.neverPlayedSpentCents, c)} spent on them` : undefined}
        />
        {summary.installedCount > 0 && <Tile label="Installed" value={String(summary.installedCount)} note={`${formatBytes(summary.installedBytes)} on disk`} />}
      </section>
      <p className="estimate-note">
        Prices are estimates: the Steam price on the day each game came into your library, from IsThereAnyDeal. Free games, gifts and
        family sharing count as nothing. Set your own price for any game in the Library.
      </p>
      <div className="columns">
        <section className="panel">
          <h2>Best value</h2>
          <GameList games={best} currency={c} empty="Nothing paid for has been played yet." />
        </section>
        <section className="panel">
          <h2>Worst value</h2>
          <GameList games={worst} currency={c} empty="Nothing paid for has been played yet." />
        </section>
        <section className="panel">
          <h2>Never played</h2>
          {summary.neverPlayed.length === 0 ? (
            <p className="muted">You've played everything.</p>
          ) : (
            <ol className="game-list">
              {summary.neverPlayed.slice(0, 15).map((g) => (
                <li key={g.appId}>
                  <span className="name">{g.name}</span>
                  <span className="figure">{g.counted ? formatMoney(g.counted.cents, g.counted.currency) : '—'}</span>
                  {g.acquiredAt ? <span className="sub">Got it {formatDate(g.acquiredAt)}</span> : null}
                </li>
              ))}
            </ol>
          )}
          {summary.neverPlayed.length > 15 && (
            <button className="link" onClick={onOpenLibrary}>
              See all {summary.neverPlayed.length} in the Library
            </button>
          )}
        </section>
      </div>
    </>
  );
}
