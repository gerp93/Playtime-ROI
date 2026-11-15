// The local SQLite database, through Node's built-in node:sqlite (no native
// module to rebuild, real incremental writes in WAL mode). All money is kept
// as whole cents.
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import type { AcquisitionKind, GameRow, Money, PriceEstimate, PriceMatch, PriceStatus } from '../../shared/types';
import type { AppAcquisition } from '../../shared/licenses';

export interface OwnedGame {
  appId: number;
  name: string;
  playtimeMinutes: number;
  lastPlayed: number | null;
}

/** A price estimate plus what it was looked up for, so a change of date or country prices it again. */
export interface StoredEstimate extends PriceEstimate {
  appId: number;
  forDate: number;
  country: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  app_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  playtime_minutes INTEGER NOT NULL DEFAULT 0,
  last_played INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS acquisitions (
  app_id INTEGER PRIMARY KEY,
  acquired_at INTEGER,
  kind TEXT NOT NULL,
  payment_method TEXT,
  package_id INTEGER NOT NULL,
  bundle INTEGER NOT NULL DEFAULT 0,
  bundle_size INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS price_estimates (
  app_id INTEGER PRIMARY KEY,
  for_date INTEGER NOT NULL,
  country TEXT NOT NULL,
  status TEXT NOT NULL,
  price_cents INTEGER,
  price_currency TEXT,
  regular_cents INTEGER,
  regular_currency TEXT,
  cut INTEGER,
  recorded_at INTEGER,
  match TEXT,
  looked_up_at INTEGER NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS manual_prices (
  app_id INTEGER PRIMARY KEY,
  cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(cents: unknown, currency: unknown): Money | null {
  const c = num(cents);
  return c != null && typeof currency === 'string' ? { cents: c, currency } : null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly filePath: string) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // A checkpoint only shrinks the -wal file; closing still writes everything.
    }
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string | null): void {
    if (value == null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Replaces the library with Steam's current list. Manual prices and estimates are kept. */
  replaceGames(games: OwnedGame[], now: number): void {
    this.transaction(() => {
      const keep = new Set(games.map((g) => g.appId));
      const existing = this.db.prepare('SELECT app_id FROM games').all() as Row[];
      const remove = this.db.prepare('DELETE FROM games WHERE app_id = ?');
      for (const row of existing) {
        const id = Number(row.app_id);
        if (!keep.has(id)) remove.run(id);
      }
      const upsert = this.db.prepare(
        `INSERT INTO games (app_id, name, playtime_minutes, last_played, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, playtime_minutes = excluded.playtime_minutes,
           last_played = excluded.last_played, updated_at = excluded.updated_at`
      );
      for (const g of games) upsert.run(g.appId, g.name, Math.max(0, Math.round(g.playtimeMinutes)), g.lastPlayed, now);
    });
  }

  replaceAcquisitions(items: Iterable<AppAcquisition>): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM acquisitions');
      const insert = this.db.prepare(
        'INSERT INTO acquisitions (app_id, acquired_at, kind, payment_method, package_id, bundle, bundle_size) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const a of items) {
        insert.run(a.appId, a.acquiredAt, a.acquisition, a.paymentMethod, a.packageId, a.bundle ? 1 : 0, a.bundleSize);
      }
    });
  }

  hasAcquisitions(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM acquisitions').get() as Row;
    return Number(row.n) > 0;
  }

  getEstimate(appId: number): StoredEstimate | null {
    const row = this.db.prepare('SELECT * FROM price_estimates WHERE app_id = ?').get(appId) as Row | undefined;
    return row ? this.toEstimate(row) : null;
  }

  saveEstimate(e: StoredEstimate): void {
    this.db
      .prepare(
        `INSERT INTO price_estimates (app_id, for_date, country, status, price_cents, price_currency, regular_cents,
           regular_currency, cut, recorded_at, match, looked_up_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET for_date = excluded.for_date, country = excluded.country, status = excluded.status,
           price_cents = excluded.price_cents, price_currency = excluded.price_currency, regular_cents = excluded.regular_cents,
           regular_currency = excluded.regular_currency, cut = excluded.cut, recorded_at = excluded.recorded_at,
           match = excluded.match, looked_up_at = excluded.looked_up_at, error = excluded.error`
      )
      .run(
        e.appId,
        e.forDate,
        e.country,
        e.status,
        e.price?.cents ?? null,
        e.price?.currency ?? null,
        e.regular?.cents ?? null,
        e.regular?.currency ?? null,
        e.cut,
        e.recordedAt,
        e.match,
        e.lookedUpAt,
        e.error
      );
  }

  setManualPrice(appId: number, price: Money | null, now: number): void {
    if (!price) {
      this.db.prepare('DELETE FROM manual_prices WHERE app_id = ?').run(appId);
      return;
    }
    if (!Number.isInteger(price.cents) || price.cents < 0) throw new Error('A price must be a whole, non-negative number of cents.');
    if (!/^[A-Z]{3}$/.test(price.currency)) throw new Error('A currency must be a three-letter code like USD.');
    this.db
      .prepare(
        `INSERT INTO manual_prices (app_id, cents, currency, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET cents = excluded.cents, currency = excluded.currency, updated_at = excluded.updated_at`
      )
      .run(appId, price.cents, price.currency, now);
  }

  listGames(): GameRow[] {
    const rows = this.db
      .prepare(
        `SELECT g.app_id, g.name, g.playtime_minutes, g.last_played,
           a.acquired_at, a.kind, a.payment_method, a.package_id, a.bundle, a.bundle_size,
           m.cents AS manual_cents, m.currency AS manual_currency,
           p.app_id AS p_app_id, p.for_date, p.country, p.status, p.price_cents, p.price_currency, p.regular_cents,
           p.regular_currency, p.cut, p.recorded_at, p.match, p.looked_up_at, p.error
         FROM games g
         LEFT JOIN acquisitions a ON a.app_id = g.app_id
         LEFT JOIN manual_prices m ON m.app_id = g.app_id
         LEFT JOIN price_estimates p ON p.app_id = g.app_id
         ORDER BY g.name COLLATE NOCASE`
      )
      .all() as Row[];
    return rows.map((row) => ({
      appId: Number(row.app_id),
      name: String(row.name),
      playtimeMinutes: Number(row.playtime_minutes),
      lastPlayed: num(row.last_played) || null,
      acquiredAt: num(row.acquired_at),
      acquisition: (row.kind as AcquisitionKind | null) ?? 'unknown',
      paymentMethod: (row.payment_method as string | null) ?? null,
      packageId: num(row.package_id),
      bundle: Number(row.bundle ?? 0) === 1,
      bundleSize: Number(row.bundle_size ?? 1),
      estimate: row.p_app_id == null ? null : this.toEstimate(row),
      manualPrice: money(row.manual_cents, row.manual_currency),
    }));
  }

  private toEstimate(row: Row): StoredEstimate {
    return {
      appId: Number(row.p_app_id ?? row.app_id),
      forDate: Number(row.for_date),
      country: String(row.country),
      status: row.status as PriceStatus,
      price: money(row.price_cents, row.price_currency),
      regular: money(row.regular_cents, row.regular_currency),
      cut: num(row.cut),
      recordedAt: num(row.recorded_at),
      match: (row.match as PriceMatch | null) ?? null,
      lookedUpAt: Number(row.looked_up_at),
      error: (row.error as string | null) ?? null,
    };
  }
}
