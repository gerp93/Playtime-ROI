import { useMemo, useState } from 'react';
import type { GameRow, ValuedGame } from '../../shared/types';
import { formatHours, formatMoney, formatPerHour, parsePriceInput, valueGame } from '../../shared/value';

type SortKey = 'name' | 'hours' | 'price' | 'perHour' | 'acquired';

interface Props {
  games: GameRow[];
  currency: string;
  onSetManualPrice: (appId: number, cents: number | null) => Promise<void>;
}

const KIND_LABEL: Record<string, string> = {
  purchase: 'Bought',
  key: 'Key',
  gift: 'Gift',
  free: 'Free',
  family: 'Family',
  unknown: '—',
};

function priceLabel(g: ValuedGame): string {
  if (!g.counted) return '—';
  const money = formatMoney(g.counted.cents, g.counted.currency);
  if (g.basis === 'manual') return `${money} (yours)`;
  if (g.basis === 'estimate') return `${money} (est.)`;
  return money;
}

function PriceEditor({ game, currency, onSave, onClose }: { game: ValuedGame; currency: string; onSave: (cents: number | null) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState(game.manualPrice ? (game.manualPrice.cents / 100).toFixed(2) : '');
  const cents = parsePriceInput(text);
  return (
    <form
      className="price-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (cents == null) return;
        await onSave(cents);
        onClose();
      }}
    >
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={`Price in ${currency}`} aria-label="Your price" />
      <button type="submit" className="primary" disabled={cents == null}>
        Save
      </button>
      {game.manualPrice && (
        <button
          type="button"
          onClick={async () => {
            await onSave(null);
            onClose();
          }}
        >
          Use estimate
        </button>
      )}
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </form>
  );
}

export default function Library({ games, currency, onSetManualPrice }: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('perHour');
  const [descending, setDescending] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  // Every game, valued the same way as the dashboard.
  const all = useMemo(() => games.map((g) => valueGame(g, currency)), [games, currency]);

  const rows = useMemo(() => {
    const list = [...all];
    const q = query.trim().toLowerCase();
    const filtered = q ? list.filter((g) => g.name.toLowerCase().includes(q)) : list;
    const val = (g: ValuedGame): number | string => {
      switch (sort) {
        case 'name':
          return g.name.toLowerCase();
        case 'hours':
          return g.hours;
        case 'price':
          return g.counted?.cents ?? -1;
        case 'acquired':
          return g.acquiredAt ?? 0;
        default:
          return g.costPerHour ?? Number.POSITIVE_INFINITY;
      }
    };
    filtered.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const cmp = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return descending ? -cmp : cmp;
    });
    return filtered;
  }, [all, query, sort, descending]);

  const header = (key: SortKey, label: string) => (
    <th>
      <button
        className="sort"
        onClick={() => {
          if (sort === key) setDescending(!descending);
          else {
            setSort(key);
            setDescending(key === 'hours' || key === 'price');
          }
        }}
      >
        {label}
        {sort === key ? (descending ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  );

  return (
    <section className="panel">
      <div className="toolbar">
        <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games" aria-label="Search games" />
        <span className="muted">{rows.length} games</span>
      </div>
      <table className="library">
        <thead>
          <tr>
            {header('name', 'Game')}
            {header('hours', 'Played')}
            {header('price', 'Price')}
            {header('perHour', 'Per hour')}
            {header('acquired', 'Got it')}
            <th>Notes</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.appId}>
              <td>
                <button className="link" onClick={() => void window.playtimeRoi.app.openLink('store', g.appId)} title="Open on the Steam store">
                  {g.name}
                </button>
              </td>
              <td>{formatHours(g.hours)}</td>
              <td>{priceLabel(g)}</td>
              <td>{formatPerHour(g.costPerHour, g.counted?.currency ?? currency)}</td>
              <td>
                {g.acquiredAt ? new Date(g.acquiredAt * 1000).toLocaleDateString() : '—'} <span className="muted">{KIND_LABEL[g.acquisition]}</span>
              </td>
              <td className="flags">
                {g.flags.map((f) => (
                  <span key={f} className="flag">
                    {f}
                  </span>
                ))}
              </td>
              <td>
                {editing === g.appId ? (
                  <PriceEditor game={g} currency={currency} onSave={(cents) => onSetManualPrice(g.appId, cents)} onClose={() => setEditing(null)} />
                ) : (
                  <button onClick={() => setEditing(g.appId)}>Set price</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
