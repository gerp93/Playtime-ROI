// Types shared by the main process and the renderer. Nothing in here may
// import Electron or Node modules: the renderer bundles it too.

/** How a game came into the library, worked out from its Steam license. */
export type AcquisitionKind =
  | 'purchase' // bought on Steam (card, PayPal, wallet, ...)
  | 'key' // activated with a product key (a bundle, a retail box, a key site)
  | 'gift' // a gift or guest pass from someone else
  | 'free' // free to play, a free promotion, a complimentary copy
  | 'family' // borrowed through Steam Family sharing
  | 'unknown'; // no license found for it, or a payment method we can't place

/** A price as whole minor units (cents) plus its ISO currency code. */
export interface Money {
  cents: number;
  currency: string;
}

/** Where a game's price on its purchase date came from in IsThereAnyDeal's history. */
export type PriceMatch =
  | 'before' // the last recorded Steam price on or before the purchase date (the normal case)
  | 'after'; // ITAD's history starts after the purchase date, so its first record was used

export type PriceStatus =
  | 'ok'
  | 'not_found' // ITAD doesn't know this Steam app
  | 'no_history' // ITAD knows it but has no Steam price history for it
  | 'error'; // the lookup failed; it is tried again on a later sync

export interface PriceEstimate {
  status: PriceStatus;
  /** The Steam price ITAD recorded for that day, after any discount. */
  price: Money | null;
  /** The regular (undiscounted) Steam price at that time. */
  regular: Money | null;
  /** Discount percent at that time (0 when full price). */
  cut: number | null;
  /** Unix seconds of the ITAD price record that was used. */
  recordedAt: number | null;
  match: PriceMatch | null;
  /** Unix seconds when the lookup ran. */
  lookedUpAt: number;
  error: string | null;
}

/** What Steam's purchase history says a game cost: the amount actually charged. */
export interface ReceiptInfo {
  /** What was paid for this game, tax included. */
  price: Money;
  /** Unix seconds (00:00 UTC) of the receipt's day. */
  date: number;
  /** The receipt also paid for other things, so this is the game's share of it. */
  split: boolean;
  /** How many items that share was divided over. */
  itemCount: number;
}

/** One game as the dashboard sees it. */
export interface GameRow {
  appId: number;
  name: string;
  playtimeMinutes: number;
  /** Unix seconds, or null when Steam has no record of it being played. */
  lastPlayed: number | null;
  /** Unix seconds of the earliest license that contains this game. */
  acquiredAt: number | null;
  acquisition: AcquisitionKind;
  /** The Steam payment method's name for that license, e.g. "CreditCard". */
  paymentMethod: string | null;
  packageId: number | null;
  /** True when the license that brought it in also brought in other games. */
  bundle: boolean;
  /** How many games of the library that license brought in. */
  bundleSize: number;
  estimate: PriceEstimate | null;
  /** What the account's purchase history says was paid; wins over the estimate. */
  receipt: ReceiptInfo | null;
  /** A price the user typed in, which always wins over everything else. */
  manualPrice: Money | null;
  /** True when the game is fully installed in a Steam library on this computer. */
  installed: boolean;
  /** The drive ("D:") of the library it is installed in, or the library's path off Windows. */
  installDrive: string | null;
  sizeOnDiskBytes: number | null;
  /** True when it is in the user's Favourites collection in Steam. */
  favorite: boolean;
}

export type CountedPriceBasis =
  | 'manual' // the user's own figure
  | 'receipt' // what Steam's purchase history says was charged
  | 'estimate' // ITAD's price on the purchase date
  | 'zero' // free, gift or family: counted as costing nothing
  | 'unknown'; // no figure at all, left out of totals

export interface ValuedGame extends GameRow {
  /** The price used for cost per hour and the totals. */
  counted: Money | null;
  basis: CountedPriceBasis;
  hours: number;
  /** Counted price per hour played; null when never played or price unknown. */
  costPerHour: number | null;
  /** Short reasons a figure should be read with care. */
  flags: string[];
}

export interface DashboardSummary {
  currency: string;
  /** Sum of counted prices in `currency` (cents). */
  totalSpentCents: number;
  /** Games whose price is unknown and so are not in the total. */
  unknownPriceCount: number;
  /** Games counted in another currency, left out of the total. */
  otherCurrencyCount: number;
  totalHours: number;
  /** Total counted spend over total hours of the games that have a price. */
  overallCostPerHour: number | null;
  gameCount: number;
  playedCount: number;
  neverPlayed: ValuedGame[];
  /** Played games with a cost per hour, cheapest per hour first. */
  ranked: ValuedGame[];
  /** Cents of counted spend on games never played. */
  neverPlayedSpentCents: number;
  /** Games whose price is what Steam's purchase history says was charged. */
  receiptCount: number;
  /** Games whose price is an ITAD estimate. */
  estimateCount: number;
  /** Games installed on this computer, and their size together; 0 without a Steam folder. */
  installedCount: number;
  installedBytes: number;
}

export type SyncPhase =
  | 'idle'
  | 'signing-in'
  | 'reading-licenses'
  | 'reading-receipts'
  | 'reading-library'
  | 'pricing'
  | 'done'
  | 'needs-login'
  | 'needs-keys'
  | 'error';

export interface SyncProgress {
  phase: SyncPhase;
  message: string;
  done?: number;
  total?: number;
}

export interface SyncResult {
  ok: boolean;
  phase: SyncPhase;
  message: string;
  games: number;
  pricesLookedUp: number;
  finishedAt: number;
}

export interface CredentialStatus {
  steamWebApiKey: boolean;
  itadApiKey: boolean;
  steamSignedIn: boolean;
  /** False when the OS can't encrypt secrets; nothing can be saved then. */
  encryptionAvailable: boolean;
}

export interface AppSettings {
  /** Two-letter country ITAD prices are looked up for. */
  country: string;
}

export interface SteamGuardRequest {
  /** The email domain a code was sent to, or null for the Steam Mobile app. */
  domain: string | null;
  lastCodeWrong: boolean;
}

export interface SteamFolderInfo {
  /** The folder in use, or null when none is set and no usual place has Steam. */
  path: string | null;
  isDefault: boolean;
  /** What the last sync found, e.g. "Found 2 libraries and 143 installed games." */
  status: string | null;
}

export interface DbLocationInfo {
  path: string;
  isDefault: boolean;
  defaultPath: string;
  sizeBytes: number | null;
}

export interface UpdateCheckResult {
  status: 'available' | 'not-available' | 'error' | 'unsupported';
  version?: string;
  message?: string;
}
