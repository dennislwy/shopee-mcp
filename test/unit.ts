/**
 * Offline unit tests for pure helpers — no browser, no login, no network.
 * Unlike test/smoke.ts (live), this is safe to run in CI on every push.
 *
 * Run with: npm run test:unit
 */
import assert from 'node:assert/strict';
import { flattenSearchItems, formatPrice } from '../src/tools/search.js';
import { parseProductUrl } from '../src/tools/product.js';
import { shopeeCapture, ShopeeAuthRequiredError } from '../src/api/client.js';
import { cache } from '../src/utils/cache.js';
import { regionFor } from '../src/browser/session.js';
import type { SearchItem, ItemBasic } from '../src/api/types.js';

let failures = 0;
const pending: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  pending.push({ name, fn });
}

async function runTests(): Promise<void> {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (err) {
      failures++;
      console.log(`❌ ${name}`);
      console.log(`   ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function fakeItemBasic(overrides: Partial<ItemBasic> = {}): ItemBasic {
  return {
    itemid: 1,
    shopid: 1,
    name: 'Test Product',
    price: 1000000,
    price_min: 1000000,
    price_max: 1000000,
    price_before_discount: 0,
    currency: 'IDR',
    stock: 10,
    sold: 5,
    historical_sold: 5,
    liked_count: 0,
    item_rating: { rating_star: 4.5, rating_count: [] },
    shop_location: 'Jakarta',
    is_official_shop: false,
    shopee_verified: false,
    image: '',
    ...overrides,
  };
}

/** A newer card-shaped result, as observed live on shopee.com.my. */
function fakeCard(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    itemid: 43174409162,
    shopid: 1432004273,
    item_basic: null as unknown as ItemBasic,
    item_data: {
      item_card_display_price: {
        price: 22555000,
        strikethrough_price: 47806000,
        original_price: 47806000,
        discount: 53,
      },
      item_card_display_sold_count: {
        historical_sold_count: 23758,
        monthly_sold_count: 19370,
        historical_sold_count_text: '20k+ sold',
      },
      item_rating: { rating_star: 4.97, rating_count: [] },
      shop_data: { shop_name: 'Ugreen Official Shop' },
      shopee_verified: false,
    },
    item_card_displayed_asset: {
      name: 'Ugreen Nexode Power Bank 20000mAh 130W',
      image: 'cn-11134207',
      shop_location: 'Selangor',
    },
    ...overrides,
  };
}

// ─── flattenSearchItems: legacy item_basic shape (the #25 fix) ─────────────

test('flattenSearchItems: normalises plain cards with item_basic', () => {
  const b = fakeItemBasic({ itemid: 1, name: 'Legacy', shop_location: 'Jakarta' });
  const items: SearchItem[] = [{ itemid: 1, shopid: 1, item_basic: b }];
  const [r] = flattenSearchItems(items);
  assert.equal(r.name, 'Legacy');
  assert.equal(r.price, 1000000);
  assert.equal(r.currency, 'IDR');
  assert.equal(r.shopLocation, 'Jakarta');
  assert.equal(r.ratingStar, 4.5);
});

test('flattenSearchItems: flattens a recommendation/ads card with real_items', () => {
  // Reproduces the exact crash from #25: a card with no top-level item_basic,
  // whose real products are nested under real_items.
  const b1 = fakeItemBasic({ itemid: 1 });
  const b2 = fakeItemBasic({ itemid: 2 });
  const adsCard = {
    itemid: 0,
    shopid: 0,
    item_basic: null as unknown as ItemBasic,
    real_items: [{ item_basic: b1 }, { item_basic: b2 }],
  };
  assert.deepEqual(
    flattenSearchItems(adsCard ? [adsCard] : []).map((r) => r.itemid),
    [1, 2],
  );
});

test('flattenSearchItems: mixes plain and ads cards in order', () => {
  const plain = fakeItemBasic({ itemid: 1 });
  const nested = fakeItemBasic({ itemid: 2 });
  const items = [
    { itemid: 1, shopid: 1, item_basic: plain },
    {
      itemid: 0,
      shopid: 0,
      item_basic: null as unknown as ItemBasic,
      real_items: [{ item_basic: nested }],
    },
  ];
  assert.deepEqual(
    flattenSearchItems(items).map((r) => r.itemid),
    [1, 2],
  );
});

test('flattenSearchItems: drops a card with neither item_basic nor real_items', () => {
  const dead = { itemid: 0, shopid: 0, item_basic: null as unknown as ItemBasic };
  assert.deepEqual(flattenSearchItems([dead]), []);
});

test('flattenSearchItems: drops null item_basic entries nested in real_items', () => {
  const good = fakeItemBasic({ itemid: 1 });
  const card = {
    itemid: 0,
    shopid: 0,
    item_basic: null as unknown as ItemBasic,
    real_items: [{ item_basic: good }, { item_basic: null as unknown as ItemBasic }],
  };
  assert.deepEqual(
    flattenSearchItems([card]).map((r) => r.itemid),
    [1],
  );
});

test('flattenSearchItems: handles null/undefined items list', () => {
  assert.deepEqual(flattenSearchItems(null), []);
  assert.deepEqual(flattenSearchItems(undefined), []);
});

// ─── flattenSearchItems: newer card shape (shopee.com.my) ──────────────────

test('flattenSearchItems: reads a newer card with item_basic null', () => {
  const [r] = flattenSearchItems([fakeCard()]);
  assert.equal(r.name, 'Ugreen Nexode Power Bank 20000mAh 130W');
  assert.equal(r.itemid, 43174409162);
  assert.equal(r.shopid, 1432004273);
  assert.equal(r.price, 22555000);
  assert.equal(r.priceBeforeDiscount, 47806000);
  assert.equal(r.ratingStar, 4.97);
  assert.equal(r.shopLocation, 'Selangor');
});

test('flattenSearchItems: prefers Shopee pre-formatted sold text on newer cards', () => {
  const [r] = flattenSearchItems([fakeCard()]);
  assert.equal(r.soldText, '20k+ sold');
  assert.equal(r.sold, 23758);
});

test('flattenSearchItems: leaves currency undefined on newer cards', () => {
  // Newer cards carry no currency field; the caller falls back to the region's.
  const [r] = flattenSearchItems([fakeCard()]);
  assert.equal(r.currency, undefined);
});

test('flattenSearchItems: ignores real_items tracking metadata on newer cards', () => {
  // On newer cards real_items holds ad attribution, NOT products — fanning it
  // out would emit one bogus entry per tracking record.
  const card = fakeCard({
    real_items: [
      { item_id: 24782704787, shop_id: 64923440, info: 'AB:711473|...' },
      { item_id: 24782704788, shop_id: 64923440, info: 'AB:711474|...' },
    ] as unknown as SearchItem['real_items'],
  });
  const out = flattenSearchItems([card]);
  assert.equal(out.length, 1);
  assert.equal(out[0].itemid, 43174409162);
});

test('flattenSearchItems: drops a newer card missing a name or price', () => {
  const noName = fakeCard({ item_card_displayed_asset: { name: '', shop_location: 'Selangor' } });
  assert.deepEqual(flattenSearchItems([noName]), []);
  const noPrice = fakeCard({ item_data: { item_card_display_price: null } });
  assert.deepEqual(flattenSearchItems([noPrice]), []);
});

test('flattenSearchItems: handles a response mixing both shapes', () => {
  const legacy = { itemid: 1, shopid: 1, item_basic: fakeItemBasic({ itemid: 1 }) };
  const out = flattenSearchItems([legacy, fakeCard()]);
  assert.deepEqual(
    out.map((r) => r.itemid),
    [1, 43174409162],
  );
});

// ─── formatPrice ────────────────────────────────────────────────────────────

test('formatPrice: divides by 100000 and formats IDR with Rp prefix', () => {
  assert.equal(formatPrice(15000000000), 'Rp150.000');
});

test('formatPrice: rounds fractional amounts', () => {
  assert.equal(formatPrice(15000050000), 'Rp150.001');
});

test('formatPrice: renders MYR with RM and two decimals', () => {
  // RM225.55 — rounding to whole units here would silently drop sen.
  assert.equal(formatPrice(22555000, 'MYR'), 'RM225.55');
});

test('formatPrice: renders SGD with S$ and two decimals', () => {
  assert.equal(formatPrice(1999000, 'SGD'), 'S$19.99');
});

test('formatPrice: renders TWD with NT$ and no decimals', () => {
  assert.equal(formatPrice(50000000, 'TWD'), 'NT$500');
});

test('formatPrice: falls back to "CURRENCY amount" for an unmapped currency', () => {
  assert.equal(formatPrice(500000000, 'USD'), 'USD 5.000');
});

// ─── parseProductUrl ────────────────────────────────────────────────────────

test('parseProductUrl: parses /product/<shopid>/<itemid> form', () => {
  assert.deepEqual(parseProductUrl('https://shopee.co.id/product/78730497/47060432055'), {
    shopId: '78730497',
    itemId: '47060432055',
  });
});

test('parseProductUrl: parses "-i.<shopid>.<itemid>" slug form', () => {
  assert.deepEqual(
    parseProductUrl('https://shopee.co.id/Some-Product-Name-i.78730497.47060432055'),
    { shopId: '78730497', itemId: '47060432055' },
  );
});

test('parseProductUrl: returns null for an unrelated URL', () => {
  assert.equal(parseProductUrl('https://shopee.co.id/'), null);
});

// ─── cache ──────────────────────────────────────────────────────────────────

test('cache: set/get round-trips within TTL', () => {
  cache.set('unit-test-key', 'value');
  assert.equal(cache.get('unit-test-key'), 'value');
});

test('cache: get returns undefined for a missing key', () => {
  assert.equal(cache.get('never-set-key'), undefined);
});

test('cache: key() joins parts with ":"', () => {
  assert.equal(cache.key('search', 'shoes', 1, 20, 'relevance'), 'search:shoes:1:20:relevance');
});

// ─── regionFor (locale/timezone by domain) ──────────────────────────────────

test('regionFor: .id domains get Indonesian locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.co.id'), {
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
  });
});

test('regionFor: .my domains get Malaysian locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.com.my'), {
    locale: 'en-MY',
    timezone: 'Asia/Kuala_Lumpur',
    currency: 'MYR',
  });
});

test('regionFor: .sg domains get Singaporean locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.sg'), {
    locale: 'en-SG',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
  });
});

test('regionFor: .tw domains get Taiwanese locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.tw'), {
    locale: 'zh-TW',
    timezone: 'Asia/Taipei',
    currency: 'TWD',
  });
});

test('regionFor: an unmapped domain falls back to the Indonesian defaults', () => {
  assert.deepEqual(regionFor('shopee.vn'), {
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
  });
});

test('regionFor: matches on the TLD suffix, not a substring elsewhere', () => {
  // ".my" appears mid-string but the TLD is .tw — must not match Malaysia.
  assert.equal(regionFor('shopee.my-mirror.tw').currency, 'TWD');
});

// ─── shopeeCapture retry-on-timeout ─────────────────────────────────────────

const loggedIn = async () => true;
const loggedOut = async () => false;

test('shopeeCapture: recovers from a single timeout via retry, no auth error', async () => {
  let calls = 0;
  const flakyCapture = async () => {
    calls++;
    if (calls === 1) throw new Error('Timeout 30000ms exceeded');
    return { error: 0, items: [] };
  };
  const result = await shopeeCapture(
    'https://x',
    'search/search_items',
    undefined,
    false,
    flakyCapture,
    loggedIn,
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { error: 0, items: [] });
});

test('shopeeCapture: reports auth-required only after a second consecutive timeout', async () => {
  let calls = 0;
  const alwaysTimesOut = async () => {
    calls++;
    throw new Error('Timeout 30000ms exceeded');
  };
  await assert.rejects(
    () =>
      shopeeCapture('https://x', 'search/search_items', undefined, false, alwaysTimesOut, loggedIn),
    ShopeeAuthRequiredError,
  );
  assert.equal(calls, 2);
});

test('shopeeCapture: signed out fails fast, without spending the capture budget', async () => {
  // The whole point: a logged-out user must get the login prompt immediately
  // rather than after a timeout (plus retry) that outlives the client's patience.
  let calls = 0;
  const capture = async () => {
    calls++;
    return { error: 0 };
  };
  await assert.rejects(
    () => shopeeCapture('https://x', 'search/search_items', undefined, false, capture, loggedOut),
    ShopeeAuthRequiredError,
  );
  assert.equal(calls, 0);
});

test('shopeeCapture: a session that lapses mid-request skips the retry', async () => {
  let calls = 0;
  const alwaysTimesOut = async () => {
    calls++;
    throw new Error('Timeout 60000ms exceeded');
  };
  // Logged in at the pre-flight check, signed out by the time it times out.
  let checks = 0;
  const lapses = async () => ++checks === 1;
  await assert.rejects(
    () =>
      shopeeCapture('https://x', 'search/search_items', undefined, false, alwaysTimesOut, lapses),
    ShopeeAuthRequiredError,
  );
  assert.equal(calls, 1, 'should not retry once the session is gone');
});

await runTests();
console.log(
  `\n${failures === 0 ? '✅ All unit tests passed' : `❌ ${failures} unit test(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
