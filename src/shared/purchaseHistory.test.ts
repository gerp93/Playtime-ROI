import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currencyFromSymbol,
  cursorFrom,
  normalizeName,
  parseHistoryCursor,
  parseHistoryDate,
  parseHistoryPage,
  parseHistoryRows,
  parseMoneyText,
  priceFromReceipts,
  ReceiptGame,
} from './purchaseHistory';
import { historyPage as page, historyRow as row } from '../main/testing/fakes';

const D = (s: string) => Date.parse(`${s}T00:00:00Z`) / 1000;

test('a plain purchase, a discounted one and a multi-item one are read', () => {
  const rows = parseHistoryRows(
    page([
      row({ id: '111', date: 'Oct 2, 2026', items: ['STAR WARS: Galactic Racer&trade;'], base: '$59.99', tax: '$5.02', total: '$65.01' }),
      row({ id: '222', date: 'Sep 29, 2026', items: ['Wreckfest 2'], base: ['-32%', '$34.99', '$23.62'], tax: '$1.98', total: '$25.60' }),
      row({ id: '333', date: 'Nov 29, 2025', items: ['L.A. Noire', "Just Cause 3"], base: ['-78%', '$39.98', '$8.98'], tax: '$0.75', total: '$9.73' }),
    ])
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    transId: '111',
    date: D('2026-10-02'),
    kind: 'purchase',
    typeLabel: 'Purchase',
    items: ['STAR WARS: Galactic Racer™'],
    listCents: 5999,
    discountPct: null,
    taxCents: 502,
    totalCents: 6501,
    symbol: '$',
  });
  assert.equal(rows[1].listCents, 3499, 'the price before the discount');
  assert.equal(rows[1].discountPct, 32);
  assert.equal(rows[1].totalCents, 2560);
  assert.deepEqual(rows[2].items, ['L.A. Noire', 'Just Cause 3']);
  assert.equal(rows[2].listCents, 3998);
});

test('refunds, in-game purchases and wallet credit are told apart', () => {
  const html = page([
    row({ id: '1', date: 'Dec 7, 2024', items: ['Detroit: Become Human', 'Refund'], type: 'Refund', total: '$12.99' }),
    `<tr class="wallet_table_row wallet_table_row_amt_change" onclick="location.href='https://help.steampowered.com/en/wizard/HelpWithItemPurchase?transid=2&amp;appid=1'">
       <td class="wht_date">Apr 25, 2026</td>
       <td class="wht_items "><div>Halo Infinite</div><div class="wth_payment"> 2,000 Halo Credits +200 Bonus</div></td>
       <td class="wht_type "><div>In-Game Purchase</div><div class="wth_payment">Wallet</div></td>
       <td class="wht_base_price">$19.99</td><td class="wht_tax">$1.67</td><td class="wht_total ">$21.66</td></tr>`,
    `<tr class="wallet_table_row wallet_table_row_amt_change" onclick="location.href='https://help.steampowered.com/en/wizard/HelpWithMyPurchase?transid=3'">
       <td class="wht_date">Apr 25, 2026</td>
       <td class="wht_items ">Purchased $21.66 Wallet Credit</td>
       <td class="wht_type "><div>Purchase</div></td>
       <td class="wht_base_price">$21.66</td><td class="wht_tax"></td><td class="wht_total ">$21.66</td></tr>`,
  ]);
  const [refund, inGame, credit] = parseHistoryRows(html);
  assert.equal(refund.kind, 'refund');
  assert.deepEqual(refund.items, ['Detroit: Become Human'], 'the "Refund" line is not an item');
  assert.equal(refund.totalCents, 1299);
  assert.equal(inGame.kind, 'other');
  assert.deepEqual(inGame.items, ['Halo Infinite'], 'the credits line is not an item');
  assert.deepEqual(credit.items, ['Purchased $21.66 Wallet Credit']);
  assert.equal(credit.kind, 'purchase');
});

test('a row with no help link or no date is skipped, not guessed', () => {
  const html = `<tr class="wallet_table_row "><td class="wht_date">Oct 2, 2026</td><td class="wht_total ">$1.00</td></tr>
    <tr class="wallet_table_row " onclick="location.href='x?transid=9'"><td class="wht_date">someday</td><td class="wht_total ">$1.00</td></tr>`;
  assert.deepEqual(parseHistoryRows(html), []);
});

test('the page says whether the table is there and where to continue', () => {
  assert.equal(parseHistoryPage('<html>Sign in to Steam</html>').hasTable, false);
  const empty = parseHistoryPage(page([]));
  assert.equal(empty.hasTable, true);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.cursor, null);
  assert.deepEqual(parseHistoryCursor('var g_historyCursor = {"wcnt":50,"wtime":1700000000,"wtimeusec":5};'), {
    wcnt: '50',
    wtime: '1700000000',
    wtimeusec: '5',
  });
  assert.equal(cursorFrom([1]), null);
  assert.equal(cursorFrom({ nested: { a: 1 } }), null);
});

test('dates, amounts and currencies', () => {
  assert.equal(parseHistoryDate('Oct 30, 2010'), D('2010-10-30'));
  assert.equal(parseHistoryDate('30 Oct, 2010'), D('2010-10-30'));
  assert.equal(parseHistoryDate('Sept 3, 2012'), D('2012-09-03'));
  assert.equal(parseHistoryDate('whenever'), null);

  assert.deepEqual(parseMoneyText('$59.99'), { cents: 5999, symbol: '$' });
  assert.deepEqual(parseMoneyText('$1,234.56'), { cents: 123456, symbol: '$' });
  assert.deepEqual(parseMoneyText('1.234,56€'), { cents: 123456, symbol: '€' });
  assert.deepEqual(parseMoneyText('12,99€'), { cents: 1299, symbol: '€' });
  assert.deepEqual(parseMoneyText('CDN$ 4.00'), { cents: 400, symbol: 'CDN$' });
  assert.deepEqual(parseMoneyText('-$5.00'), { cents: -500, symbol: '$' });
  assert.equal(parseMoneyText('Free'), null);
  assert.equal(parseMoneyText(''), null);

  assert.equal(currencyFromSymbol('$', 'US'), 'USD');
  assert.equal(currencyFromSymbol('$', 'AU'), 'AUD');
  assert.equal(currencyFromSymbol('€', 'DE'), 'EUR');
  assert.equal(currencyFromSymbol('kr', 'SE'), 'SEK');
  assert.equal(currencyFromSymbol('kr', 'US'), null, 'unsure is null, not a guess');
  assert.equal(currencyFromSymbol('zł', 'PL'), 'PLN');
  assert.equal(currencyFromSymbol('CHF', 'CH'), 'CHF');
  assert.equal(currencyFromSymbol(null, 'US'), null);
});

test('names agree across trademark signs, case and punctuation', () => {
  assert.equal(normalizeName('STAR WARS&trade;: Squadrons'), normalizeName('Star Wars: Squadrons'));
  assert.equal(normalizeName('Tony Hawk’s™ Pro Skater™ 1 + 2'), 'tony hawk s pro skater 1 2');
});

function game(appId: number, name: string, acquired: string | null, regularCents: number | null = null): ReceiptGame {
  return { appId, name, acquiredAt: acquired ? D(acquired) + 3600 : null, regularCents };
}

const prices = (rows: string[], games: ReceiptGame[], country = 'US') =>
  new Map(priceFromReceipts(parseHistoryRows(page(rows)), games, country).map((p) => [p.appId, p]));

test('a one-game purchase costs what was charged, tax included', () => {
  const p = prices(
    [row({ id: '1', date: 'Oct 2, 2026', items: ['STAR WARS: Galactic Racer&trade;'], base: '$59.99', tax: '$5.02', total: '$65.01' })],
    [game(1, 'STAR WARS: Galactic Racer™', '2026-10-02')]
  ).get(1);
  assert.deepEqual(p?.price, { cents: 6501, currency: 'USD' });
  assert.equal(p?.split, false);
  assert.equal(p?.transId, '1');
});

test('a later game with a similar name is not given the earlier game’s receipt', () => {
  const rows = [
    row({ id: '1', date: 'Sep 29, 2026', items: ['Wreckfest 2'], total: '$25.60' }),
    row({ id: '2', date: 'Dec 30, 2022', items: ['Wreckfest'], total: '$10.00' }),
  ];
  const p = prices(rows, [game(1, 'Wreckfest', '2022-12-30'), game(2, 'Wreckfest 2', '2026-09-29')]);
  assert.equal(p.get(1)?.price.cents, 1000);
  assert.equal(p.get(2)?.price.cents, 2560);
  // Only one of them owned: the name that merely starts the same must still be near in date.
  assert.equal(prices(rows, [game(1, 'Wreckfest', '2022-12-30')]).get(1)?.price.cents, 1000);
  assert.equal(prices([rows[0]], [game(1, 'Wreckfest', '2022-12-30')]).size, 0);
});

test('add-ons bought the next day do not take the game’s place', () => {
  const rows = [
    row({ id: '1', date: 'Mar 7, 2024', items: ['SnowRunner'], total: '$16.25' }),
    row({ id: '2', date: 'Mar 8, 2024', items: ['SnowRunner - Year 1 Pass', 'SnowRunner - Year 2 Pass'], total: '$46.29' }),
  ];
  const p = prices(rows, [game(1, 'SnowRunner', '2024-03-07')]);
  assert.equal(p.get(1)?.price.cents, 1625);
  assert.equal(p.get(1)?.transId, '1');
});

test('a game only in a name-prefix match still counts when its receipt names an edition', () => {
  const p = prices(
    [row({ id: '1', date: 'Nov 20, 2025', items: ['Transport Fever 2 - Deluxe Edition'], total: '$20.00' })],
    [game(1, 'Transport Fever 2', '2025-11-20')]
  );
  assert.equal(p.get(1)?.price.cents, 2000);
});

test('a receipt for several games is shared by regular price, or equally when that is unknown', () => {
  const rows = [row({ id: '1', date: 'Nov 29, 2025', items: ['L.A. Noire', 'Just Cause 3'], base: ['-78%', '$39.98', '$8.98'], tax: '$0.75', total: '$10.00' })];
  const byPrice = prices(rows, [game(1, 'L.A. Noire', '2025-11-29', 3000), game(2, 'Just Cause 3', '2025-11-29', 1000)]);
  assert.equal(byPrice.get(1)?.price.cents, 750);
  assert.equal(byPrice.get(2)?.price.cents, 250);
  assert.equal(byPrice.get(1)?.split, true);
  assert.equal(byPrice.get(1)?.itemCount, 2);

  const equal = prices(rows, [game(1, 'L.A. Noire', '2025-11-29'), game(2, 'Just Cause 3', '2025-11-29')]);
  assert.equal(equal.get(1)?.price.cents, 500);
  assert.equal(equal.get(2)?.price.cents, 500);

  // Only one of the two is a game in the library (the other may be an add-on): it gets its share, not the whole.
  const half = prices(rows, [game(1, 'L.A. Noire', '2025-11-29')]);
  assert.equal(half.get(1)?.price.cents, 500);
});

test('a refund of one item leaves the other item with what was really paid', () => {
  const rows = [
    row({ id: '1', date: 'Dec 1, 2024', items: ['Assassin’s Creed Odyssey - Ultimate Edition', 'Detroit: Become Human'], base: ['-85%', '$159.98', '$23.98'], total: '$25.98' }),
    row({ id: '2', date: 'Dec 7, 2024', items: ['Detroit: Become Human', 'Refund'], type: 'Refund', total: '$12.99' }),
  ];
  const p = prices(rows, [game(1, 'Assassin’s Creed Odyssey', '2024-12-01'), game(2, 'Detroit: Become Human', '2024-12-01')]);
  assert.equal(p.get(1)?.price.cents, 1299);
  assert.equal(p.get(1)?.split, false, 'the refunded item no longer shares it');
  assert.equal(p.has(2), false, 'the refunded game is not charged to anyone');
});

test('a refunded purchase bought again counts the second, whatever order the page lists them', () => {
  const rows = [
    row({ id: '3', date: 'Mar 18, 2022', items: ['The Sims 4 Digital Deluxe Edition'], total: '$6.43' }),
    row({ id: '2', date: 'Mar 12, 2022', items: ['The Sims 4 Digital Deluxe Edition', 'Refund'], type: 'Refund', total: '$44.99' }),
    row({ id: '1', date: 'Mar 10, 2022', items: ['The Sims 4 Digital Deluxe Edition'], total: '$44.99' }),
  ];
  const p = prices(rows, [game(1, 'The Sims 4', '2022-03-18')]);
  assert.equal(p.get(1)?.transId, '3');
  assert.equal(p.get(1)?.price.cents, 643);
  // The same game, refunded and never bought again, is not charged to anyone.
  assert.equal(prices(rows.slice(1), [game(1, 'The Sims 4', '2022-03-10')]).size, 0);
});

test('wallet credit, in-game purchases and unknown currencies never price a game', () => {
  const wallet = row({ id: '1', date: 'Apr 25, 2026', items: ['Halo Infinite'], type: 'In-Game Purchase', total: '$21.66' });
  assert.equal(prices([wallet], [game(1, 'Halo Infinite', '2026-04-25')]).size, 0);
  const credit = row({ id: '2', date: 'Apr 25, 2026', items: ['Purchased $21.66 Wallet Credit'], total: '$21.66' });
  assert.equal(prices([credit], [game(1, 'Purchased 21 66 Wallet Credit', '2026-04-25')]).size, 0);
  const krona = row({ id: '3', date: 'Apr 25, 2026', items: ['Some Game'], total: '99,00 kr' });
  assert.equal(prices([krona], [game(1, 'Some Game', '2026-04-25')], 'US').size, 0);
  assert.equal(prices([krona], [game(1, 'Some Game', '2026-04-25')], 'SE').get(1)?.price.currency, 'SEK');
});

test('a game with no license date is matched only by its exact name', () => {
  const rows = [row({ id: '1', date: 'Oct 2, 2026', items: ['Game Deluxe Edition'], total: '$10.00' })];
  assert.equal(prices(rows, [game(1, 'Game', null)]).size, 0);
  assert.equal(prices([row({ id: '1', date: 'Oct 2, 2026', items: ['Game'], total: '$10.00' })], [game(1, 'Game', null)]).get(1)?.price.cents, 1000);
});
