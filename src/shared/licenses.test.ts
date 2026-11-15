import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquisitionsByApp,
  classifyLicense,
  packageDetailsFromInfo,
  PackageDetails,
  SteamLicense,
  toUnixSeconds,
  PaymentMethod,
  LicenseFlags,
  BillingType,
} from './licenses';

const ME = 1000;
const CARD = 2;

test('packageinfo app ids are read from an array or a VDF-style object', () => {
  assert.deepEqual(packageDetailsFromInfo({ appids: [10, 20, 20] }).appIds, [10, 20]);
  assert.deepEqual(packageDetailsFromInfo({ appids: { '0': 10, '1': '30' }, billingtype: 6 }), {
    appIds: [10, 30],
    billingType: 6,
    freePromotion: false,
  });
  assert.equal(packageDetailsFromInfo({ appids: [1], extended: { freepromotion: 1 } }).freePromotion, true);
  assert.deepEqual(packageDetailsFromInfo(undefined).appIds, []);
});

test('time_created is accepted as seconds or a Date', () => {
  assert.equal(toUnixSeconds(1600000000), 1600000000);
  assert.equal(toUnixSeconds(new Date(1600000000 * 1000)), 1600000000);
  assert.equal(toUnixSeconds(0), null);
  assert.equal(toUnixSeconds(null), null);
});

test('licenses are classified by how they were paid for', () => {
  const pkg: PackageDetails = { appIds: [1], billingType: 1 };
  const lic = (over: Partial<SteamLicense>): SteamLicense => ({ package_id: 5, time_created: 1, owner_id: ME, ...over });
  assert.equal(classifyLicense(lic({ payment_method: CARD }), pkg, ME), 'purchase');
  assert.equal(classifyLicense(lic({ payment_method: PaymentMethod.Wallet }), pkg, ME), 'purchase');
  assert.equal(classifyLicense(lic({ payment_method: PaymentMethod.ActivationCode }), pkg, ME), 'key');
  assert.equal(classifyLicense(lic({ payment_method: PaymentMethod.GuestPass }), pkg, ME), 'gift');
  assert.equal(classifyLicense(lic({ payment_method: PaymentMethod.Complimentary }), pkg, ME), 'free');
  assert.equal(classifyLicense(lic({ payment_method: CARD }), { appIds: [1], billingType: BillingType.FreeOnDemand }, ME), 'free');
  assert.equal(classifyLicense(lic({ payment_method: CARD }), { appIds: [1], billingType: BillingType.Gift }, ME), 'gift');
  assert.equal(classifyLicense(lic({ payment_method: CARD, flags: LicenseFlags.Borrowed }), pkg, ME), 'family');
  assert.equal(classifyLicense(lic({ payment_method: CARD, owner_id: 2222 }), pkg, ME), 'family');
  assert.equal(classifyLicense(lic({ package_id: 0, payment_method: 0 }), pkg, ME), 'free');
  assert.equal(classifyLicense(lic({ payment_method: 0 }), pkg, ME), 'unknown');
  assert.equal(classifyLicense(lic({ payment_method: CARD }), { appIds: [1], freePromotion: true }, ME), 'free');
});

test('each game takes its earliest live license, and bundles count library games only', () => {
  const licenses: SteamLicense[] = [
    // A later key for a game already bought does not move its purchase date.
    { package_id: 30, time_created: 1700000000, payment_method: PaymentMethod.ActivationCode, owner_id: ME },
    { package_id: 10, time_created: 1500000000, payment_method: CARD, owner_id: ME },
    // A bundle with two library games and a soundtrack.
    { package_id: 20, time_created: 1600000000, payment_method: CARD, owner_id: ME },
    // An expired free weekend gives nothing.
    { package_id: 40, time_created: 1400000000, payment_method: 0, flags: LicenseFlags.Expired, owner_id: ME },
    // A pending refund gives nothing.
    { package_id: 50, time_created: 1450000000, payment_method: CARD, flags: LicenseFlags.PendingRefund, owner_id: ME },
  ];
  const packages = new Map<number, PackageDetails>([
    [10, { appIds: [100, 101] }], // the game and its dedicated server
    [20, { appIds: [200, 201, 999] }],
    [30, { appIds: [100] }],
    [40, { appIds: [400] }],
    [50, { appIds: [500] }],
  ]);
  const library = new Set([100, 200, 201, 400, 500]);
  const byApp = acquisitionsByApp(licenses, packages, ME, library);

  assert.equal(byApp.get(100)?.acquiredAt, 1500000000);
  assert.equal(byApp.get(100)?.acquisition, 'purchase');
  assert.equal(byApp.get(100)?.paymentMethod, 'Method 2');
  assert.equal(byApp.get(100)?.bundle, false, 'a server app does not make a bundle');
  assert.equal(byApp.get(200)?.bundle, true);
  assert.equal(byApp.get(201)?.bundleSize, 2);
  assert.equal(byApp.has(400), false);
  assert.equal(byApp.has(500), false);
});

test('payment method names come from the enum handed in', () => {
  const byApp = acquisitionsByApp(
    [{ package_id: 1, time_created: 10, payment_method: 2, owner_id: ME }],
    new Map([[1, { appIds: [7] }]]),
    ME,
    undefined,
    { CreditCard: 2 }
  );
  assert.equal(byApp.get(7)?.paymentMethod, 'CreditCard');
});
