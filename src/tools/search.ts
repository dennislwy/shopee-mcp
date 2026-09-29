import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shopeeCapture, shopeeUrl } from '../api/client.js';
import { BASE_URL, CURRENCY } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling } from '../utils/errors.js';
import { formatPrice } from '../utils/price.js';
import type { SearchItemsResponse, SearchItem, ItemBasic, SearchResult } from '../api/types.js';

/** Normalise a legacy `item_basic` card. */
function fromItemBasic(b: ItemBasic): SearchResult {
  return {
    itemid: b.itemid,
    shopid: b.shopid,
    name: b.name,
    price: b.price,
    priceMin: b.price_min,
    priceMax: b.price_max,
    priceBeforeDiscount: b.price_before_discount,
    currency: b.currency,
    ratingStar: b.item_rating?.rating_star,
    sold: b.historical_sold || b.sold,
    shopLocation: b.shop_location,
    isOfficialShop: b.is_official_shop,
  };
}

/** Normalise a newer card-shaped result (`item_data` + `item_card_displayed_asset`). */
function fromCard(it: SearchItem): SearchResult | null {
  const d = it.item_data ?? undefined;
  const asset = it.item_card_displayed_asset ?? undefined;
  const p = d?.item_card_display_price ?? undefined;
  const name = asset?.name?.trim();

  // Without a name or a price there's nothing worth showing.
  if (!name || !p || typeof p.price !== 'number') return null;

  const soldCount = d?.item_card_display_sold_count ?? undefined;
  const before = p.original_price ?? p.strikethrough_price ?? undefined;

  // On a "virtual item" card the top-level ids are a synthetic selection-model
  // placeholder that pdp/get_pc rejects (266900504); real_items holds the actual
  // listing. Display still comes from the card the user sees.
  const real = it.real_items?.[0];

  return {
    itemid: real?.item_id ?? it.itemid ?? d?.itemid ?? 0,
    shopid: real?.shop_id ?? it.shopid ?? d?.shopid ?? 0,
    name,
    price: p.price,
    priceBeforeDiscount: before ?? undefined,
    // Newer cards carry no currency field at all — left undefined so the caller
    // falls back to the region's currency.
    currency: undefined,
    ratingStar: d?.item_rating?.rating_star,
    sold: soldCount?.historical_sold_count ?? soldCount?.monthly_sold_count ?? undefined,
    soldText:
      soldCount?.historical_sold_count_text ?? soldCount?.monthly_sold_count_text ?? undefined,
    shopLocation: asset?.shop_location ?? undefined,
    // No Shopee Mall equivalent is exposed on these cards (`shopee_verified` is a
    // different, seller-level flag), so the badge is simply omitted.
    isOfficialShop: undefined,
  };
}

/**
 * Flatten a search response into products, detecting each card's shape
 * individually rather than assuming one shape per domain — Shopee is rolling the
 * newer card format out per-market, and a single response can mix forms.
 *
 * Order matters: newer cards also carry a `real_items` array, but there it
 * describes the same product (see fromCard) rather than extra ones, so the
 * legacy fan-out is only tried once both other shapes have been ruled out.
 */
export function flattenSearchItems(items: SearchItem[] | null | undefined): SearchResult[] {
  return (items ?? []).flatMap((it) => {
    // 1. Legacy plain card.
    if (it.item_basic) return [fromItemBasic(it.item_basic)];

    // 2. Newer card shape — the product lives on the card itself.
    if (it.item_data || it.item_card_displayed_asset) {
      const card = fromCard(it);
      if (card) return [card];
    }

    // 3. Legacy recommendation/ads card nesting real products.
    if (it.real_items?.length) {
      return it.real_items
        .map((ri) => ri.item_basic)
        .filter((b): b is ItemBasic => Boolean(b))
        .map(fromItemBasic);
    }

    return [];
  });
}

function priceText(r: SearchResult, fallbackCurrency: string): string {
  const currency = r.currency || fallbackCurrency;
  if (r.priceMin && r.priceMax && r.priceMin !== r.priceMax) {
    return `${formatPrice(r.priceMin, currency)} – ${formatPrice(r.priceMax, currency)}`;
  }
  return formatPrice(r.price, currency);
}

// Sort option → Shopee search-URL params.
const SORT_MAP: Record<string, { sortBy: string; order?: string }> = {
  relevance: { sortBy: 'relevancy' },
  newest: { sortBy: 'ctime' },
  top_sales: { sortBy: 'sales' },
  price_low: { sortBy: 'price', order: 'asc' },
  price_high: { sortBy: 'price', order: 'desc' },
};

export function registerSearchTools(server: McpServer): void {
  server.tool(
    'search_products',
    'Search for products on Shopee by keyword, with sorting and pagination. ' +
      'Returns product names, prices, sold counts, ratings, seller location, product IDs, and direct URLs. ' +
      'Requires a one-time login (run `npm run login`) because Shopee blocks anonymous requests.',
    {
      query: z.string().min(1).describe('The search query, e.g. "laptop gaming", "sepatu nike"'),
      page: z.number().int().min(1).default(1).describe('Page number (default: 1)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(20)
        .describe('Max results to show from the page, 1-60 (default: 20)'),
      sort: z
        .enum(['relevance', 'newest', 'top_sales', 'price_low', 'price_high'])
        .default('relevance')
        .describe('Sort order (default: relevance)'),
    },
    async ({ query, page, limit, sort }) => {
      return withErrorHandling(async () => {
        const cacheKey = cache.key('search', query, page, limit, sort);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text', text: cached }] };

        const { sortBy, order } = SORT_MAP[sort] ?? SORT_MAP.relevance;
        const qs = new URLSearchParams({ keyword: query, page: String(page - 1), sortBy });
        if (order) qs.set('order', order);
        const searchUrl = shopeeUrl(`/search?${qs.toString()}`);

        const data = await shopeeCapture<SearchItemsResponse>(searchUrl, 'search/search_items');

        const items = flattenSearchItems(data.items);
        if (items.length === 0) {
          return {
            content: [
              { type: 'text', text: `No products found for "${query}". Try a different keyword.` },
            ],
          };
        }

        const shown = items.slice(0, limit);
        const totalCount = data.total_count ?? 0;
        // Estimate only: `items.length` is Shopee's per-request page size, but flattening
        // an ads card into multiple real_items (see flattenSearchItems) can inflate it
        // above that true size, undercounting totalPages. Shopee doesn't expose the real
        // page size otherwise, so this stays an approximation — it doesn't affect
        // pagination itself, only the displayed page count.
        const totalPages = totalCount > 0 ? Math.ceil(totalCount / items.length) : page;

        const lines: string[] = [
          `🛒 Search Results for "${query}"`,
          `📊 ${totalCount.toLocaleString('id-ID')} total products | Page ${page}${totalPages > 1 ? `/${totalPages}` : ''}`,
          ``,
        ];

        shown.forEach((r, i) => {
          const rank = (page - 1) * limit + i + 1;
          const rating = r.ratingStar ? `⭐ ${r.ratingStar.toFixed(1)}` : '⭐ N/A';
          // Newer cards give a pre-formatted string ("20k+ sold"); older ones a raw count.
          const soldLabel = r.soldText
            ? r.soldText
            : r.sold
              ? `${r.sold.toLocaleString('id-ID')} sold`
              : '';
          const soldText = soldLabel ? ` | 📦 ${soldLabel}` : '';
          const official = r.isOfficialShop ? ' [Shopee Mall]' : '';
          const url = `${BASE_URL}/product/${r.shopid}/${r.itemid}`;

          lines.push(`${rank}. **${r.name}**`);
          lines.push(`   💰 ${priceText(r, CURRENCY)}`);
          lines.push(
            `   ${rating}${soldText} | 🏪 ${r.shopLocation || 'N/A'}${official} | 🆔 ${r.itemid}`,
          );
          lines.push(`   🔗 ${url}`);
          if (i < shown.length - 1) lines.push('');
        });

        if (!data.nomore) {
          lines.push(``, `📄 Use page=${page + 1} to see more results.`);
        }

        const text = lines.join('\n');
        cache.set(cacheKey, text);
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
