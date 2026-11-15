// Works out, for every game in the library, when and how it came in, from
// the account's Steam licenses. Pure: the Steam client hands in plain data.
import type { AcquisitionKind } from './types';

/** The fields of a Steam license (CMsgClientLicenseList.License) this uses. */
export interface SteamLicense {
  package_id: number;
  /** Unix seconds. steam-user passes the protobuf number through; a Date is accepted too. */
  time_created: number | Date | null | undefined;
  payment_method?: number | null;
  flags?: number | null;
  owner_id?: number | null;
}

/** What Steam's package info says about one package. */
export interface PackageDetails {
  appIds: number[];
  /** EBillingType, when known. */
  billingType?: number | null;
  /** The package was given away for free for a limited time ("free to keep"). */
  freePromotion?: boolean;
}

export interface AppAcquisition {
  appId: number;
  acquiredAt: number | null;
  acquisition: AcquisitionKind;
  paymentMethod: string | null;
  packageId: number;
  /** The package brought in more than one game of the library. */
  bundle: boolean;
  /** How many games of the library came in with that package. */
  bundleSize: number;
}

// Values from steam-user's enums (SteamUser.EPaymentMethod, EBillingType,
// ELicenseFlags). Copied rather than imported so this file stays pure and
// the renderer and tests can use it without the Steam client.
export const PaymentMethod = {
  None: 0,
  ActivationCode: 1,
  GuestPass: 8,
  HardwarePromo: 16,
  AutoGrant: 64,
  Wallet: 128,
  Valve: 129,
  MasterComp: 130,
  Promotional: 131,
  OEMTicket: 256,
  Split: 512,
  Complimentary: 1024,
  FamilyGroup: 1025,
} as const;

export const BillingType = {
  NoCost: 0,
  GuestPass: 4,
  HardwarePromo: 5,
  Gift: 6,
  AutoGrant: 7,
  OEMTicket: 8,
  FreeOnDemand: 12,
  FreeCommercialLicense: 15,
} as const;

export const LicenseFlags = {
  Expired: 8,
  PendingRefund: 8192,
  Borrowed: 16384,
} as const;

/** Package 0 is the default free package every account has (free-to-play games, tools). */
const FREE_PACKAGE_ID = 0;

const FREE_BILLING = new Set<number>([
  BillingType.NoCost,
  BillingType.FreeOnDemand,
  BillingType.FreeCommercialLicense,
  BillingType.AutoGrant,
]);

const FREE_PAYMENT = new Set<number>([
  PaymentMethod.AutoGrant,
  PaymentMethod.Valve,
  PaymentMethod.MasterComp,
  PaymentMethod.Promotional,
  PaymentMethod.Complimentary,
]);

const KEY_PAYMENT = new Set<number>([
  PaymentMethod.ActivationCode,
  PaymentMethod.OEMTicket,
  PaymentMethod.HardwarePromo,
]);

export function toUnixSeconds(value: number | Date | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && t > 0 ? Math.floor(t / 1000) : null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Turns Steam's packageinfo into the few fields used here. `appids` is an
 * array in steam-user's own cache code, but a raw VDF parse gives an object
 * keyed "0", "1", ...; both are accepted.
 */
export function packageDetailsFromInfo(packageinfo: unknown): PackageDetails {
  const info = (packageinfo ?? {}) as Record<string, unknown>;
  const raw = info.appids;
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  const appIds = [...new Set(values.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
  const billing = info.billingtype;
  const extended = (info.extended ?? {}) as Record<string, unknown>;
  const freePromo = extended.freepromotion;
  return {
    appIds,
    billingType: billing == null || billing === '' ? null : Number(billing),
    freePromotion: freePromo === true || freePromo === 1 || freePromo === '1',
  };
}

export function paymentMethodName(method: number | null | undefined, names: Record<string, unknown>): string | null {
  if (method == null) return null;
  for (const [name, value] of Object.entries(names)) {
    if (value === method) return name;
  }
  return `Method ${method}`;
}

export function classifyLicense(
  license: SteamLicense,
  pkg: PackageDetails | undefined,
  ownAccountId: number | null
): AcquisitionKind {
  const flags = license.flags ?? 0;
  const method = license.payment_method ?? null;

  if (flags & LicenseFlags.Borrowed) return 'family';
  if (method === PaymentMethod.FamilyGroup) return 'family';
  if (ownAccountId != null && license.owner_id != null && license.owner_id !== 0 && license.owner_id !== ownAccountId) {
    return 'family';
  }
  if (license.package_id === FREE_PACKAGE_ID) return 'free';
  if (pkg?.freePromotion) return 'free';
  if (method === PaymentMethod.GuestPass) return 'gift';
  if (pkg?.billingType === BillingType.Gift || pkg?.billingType === BillingType.GuestPass) return 'gift';
  if (method != null && FREE_PAYMENT.has(method)) return 'free';
  if (pkg?.billingType != null && FREE_BILLING.has(pkg.billingType)) return 'free';
  if (method != null && KEY_PAYMENT.has(method)) return 'key';
  if (method === PaymentMethod.None || method == null) return 'unknown';
  // Every other method is a way of paying on the Steam store: cards, PayPal,
  // the wallet, a split payment, and the many regional methods.
  return 'purchase';
}

/** Licenses that no longer give the game: expired free weekends, and refunds in progress. */
export function isLiveLicense(license: SteamLicense): boolean {
  const flags = license.flags ?? 0;
  return (flags & LicenseFlags.Expired) === 0 && (flags & LicenseFlags.PendingRefund) === 0;
}

/**
 * For each app, the license that first brought it into the library. When a
 * game is in several licenses (bought, then also in a bundle later), the
 * earliest one is the purchase date; a later paid license never replaces it.
 */
export function acquisitionsByApp(
  licenses: SteamLicense[],
  packages: Map<number, PackageDetails>,
  ownAccountId: number | null,
  /** The games in the library. A package's other app ids (soundtracks, servers, tools) don't make it a bundle. */
  libraryAppIds?: Set<number>,
  paymentNames: Record<string, unknown> = PaymentMethod
): Map<number, AppAcquisition> {
  const result = new Map<number, AppAcquisition>();
  const ordered = licenses
    .filter(isLiveLicense)
    .map((license) => ({ license, at: toUnixSeconds(license.time_created) }))
    .sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));

  for (const { license, at } of ordered) {
    const pkg = packages.get(license.package_id);
    if (!pkg) continue;
    const kind = classifyLicense(license, pkg, ownAccountId);
    const games = libraryAppIds ? pkg.appIds.filter((id) => libraryAppIds.has(id)) : pkg.appIds;
    const bundleSize = games.length;
    const bundle = bundleSize > 1 && license.package_id !== FREE_PACKAGE_ID;
    for (const appId of pkg.appIds) {
      if (result.has(appId)) continue;
      result.set(appId, {
        appId,
        acquiredAt: at,
        acquisition: kind,
        paymentMethod: paymentMethodName(license.payment_method, paymentNames),
        packageId: license.package_id,
        bundle,
        bundleSize,
      });
    }
  }
  return result;
}
