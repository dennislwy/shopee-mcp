import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shopeeCapture, shopeeUrl } from '../api/client.js';
import { BASE_URL, CURRENCY, captureWithSelections } from '../browser/session.js';
import { cache } from '../utils/cache.js';
import { withErrorHandling } from '../utils/errors.js';
import { formatPrice } from '../utils/price.js';
import { parseProductUrl } from './product.js';
import type { PdpModel, PdpResponse, SelectVariationResponse } from '../api/types.js';

/** Clicking every option on a long list costs a round trip each; keep it sane. */
const MAX_STOCK_LOOKUPS = 12;

/** One variant, normalised for display. */
export interface VariantRow {
  modelId: number;
  name: string;
  /** Real amount × 100000. */
  price: number;
  priceBeforeDiscount?: number;
  /** Exact count — only present when the opt-in stock lookup ran. */
  stock?: number;
  /** Availability from get_pc; the fallback when exact counts weren't fetched. */
  inStock?: boolean;
  isPreOrder?: boolean;
}

/**
 * Normalise a listing's models into display rows, folding in exact stock counts
 * when the caller gathered them (keyed by variant name, which matches the tier
 * option label that was clicked).
 */
export function buildVariantRows(
  models: PdpModel[] | null | undefined,
  stockByName?: Map<string, number>,
): VariantRow[] {
  return (models ?? []).map((m) => {
    // `?? undefined` rather than `||`: a genuine 0 is a sold-out count, not a miss.
    const exact = stockByName?.get(m.name);
    return {
      modelId: m.model_id,
      name: m.name,
      price: m.price,
      priceBeforeDiscount: m.price_before_discount ?? undefined,
      stock: exact,
      inStock: m.has_stock ?? undefined,
      isPreOrder: m.extinfo?.is_pre_order,
    };
  });
}

function stockLabel(r: VariantRow): string {
  if (r.stock !== undefined) return `📦 ${r.stock.toLocaleString('en-US')} in stock`;
  if (r.inStock === true) return '✅ In stock';
  if (r.inStock === false) return '❌ Out of stock';
  return '📦 Stock unknown';
}

export function registerVariantTools(server: McpServer): void {
  server.tool(
    'get_product_variants',
    'List every variant (model) of a Shopee product: exact model IDs, variant names, and per-variant prices. ' +
      'Use the model ID to refer to one specific variant of a multi-option listing. ' +
      'Set includeStock=true to also fetch exact stock counts (slower — Shopee only reveals them one variant at a time).',
    {
      shopId: z.string().optional().describe('Numeric shop ID (from search_products)'),
      itemId: z.string().optional().describe('Numeric item/product ID (from search_products)'),
      url: z.string().url().optional().describe('Full product URL, as an alternative to the IDs'),
      includeStock: z
        .boolean()
        .default(false)
        .describe(
          'Fetch exact per-variant stock counts. Off by default because it costs a round trip ' +
            'per variant; when off, each variant is reported as in/out of stock.',
        ),
    },
    async ({ shopId, itemId, url, includeStock }) => {
      return withErrorHandling(async () => {
        let sid = shopId;
        let iid = itemId;
        if ((!sid || !iid) && url) {
          const parsed = parseProductUrl(url);
          if (parsed) {
            sid = parsed.shopId;
            iid = parsed.itemId;
          }
        }
        if (!sid || !iid) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '❌ Please provide both `shopId` and `itemId`, or a full product `url`.',
              },
            ],
          };
        }

        const cacheKey = cache.key('variants', sid, iid, includeStock);
        const cached = cache.get<string>(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: cached }] };

        const pageUrl = shopeeUrl(`/product/${sid}/${iid}`);

        let data: PdpResponse;
        let stockByName: Map<string, number> | undefined;

        if (includeStock) {
          // One navigation: read the listing, then click each option for its count.
          const { primary, selections } = await captureWithSelections<
            PdpResponse,
            SelectVariationResponse
          >(pageUrl, {
            apiMatch: 'pdp/get_pc',
            selectionApiMatch: 'cart_panel/select_variation_pc',
            maxSelections: MAX_STOCK_LOOKUPS,
            labelsFrom: (p) => (p.data?.item?.models ?? []).map((m) => m.name),
          });
          data = primary;
          stockByName = new Map();
          for (const [name, sel] of selections) {
            const n = sel.data?.stock;
            if (typeof n === 'number') stockByName.set(name, n);
          }
        } else {
          data = await shopeeCapture<PdpResponse>(pageUrl, 'pdp/get_pc');
        }

        const item = data.data?.item;
        if (!item) {
          return {
            content: [
              {
                type: 'text' as const,
                text: '❌ Could not read product data. Check the shopId/itemId or URL.',
              },
            ],
          };
        }

        const rows = buildVariantRows(item.models, stockByName);
        if (rows.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `📦 **${item.title}**\n\nThis listing has no variants — it is sold as a single option.\n` +
                  `Use get_product_detail for its price and stock.`,
              },
            ],
          };
        }

        const currency = item.currency || CURRENCY;
        const tiers = item.tier_variations ?? [];
        const lines: string[] = [
          `🎚 **${item.title}**`,
          `${rows.length} variant${rows.length === 1 ? '' : 's'}${tiers.length ? ` | ${tiers.map((t) => t.name).join(' × ')}` : ''}`,
          '',
        ];

        rows.forEach((r, i) => {
          const before =
            r.priceBeforeDiscount && r.priceBeforeDiscount > r.price
              ? ` ~~${formatPrice(r.priceBeforeDiscount, currency)}~~`
              : '';
          lines.push(`${i + 1}. **${r.name}**`);
          lines.push(`   💰 ${formatPrice(r.price, currency)}${before}`);
          lines.push(
            `   ${stockLabel(r)}${r.isPreOrder ? ' | ⏳ Pre-order' : ''} | 🆔 model_id: \`${r.modelId}\``,
          );
          if (i < rows.length - 1) lines.push('');
        });

        if (!includeStock) {
          lines.push('', '💡 Set `includeStock=true` for exact per-variant stock counts.');
        } else if (tiers.length > 1) {
          // Each variant is a combination across axes, so clicking one option
          // never selects a single model and no count comes back for it.
          lines.push(
            '',
            `⚠️ This listing varies across ${tiers.length} options (${tiers.map((t) => t.name).join(' × ')}), ` +
              'so exact counts are unavailable — showing availability instead.',
          );
        } else if (rows.length > MAX_STOCK_LOOKUPS) {
          lines.push(
            '',
            `⚠️ Exact counts fetched for the first ${MAX_STOCK_LOOKUPS} variants only.`,
          );
        }

        lines.push('', `🔗 ${BASE_URL}/product/${item.shop_id}/${item.item_id}`);

        const text = lines.join('\n');
        cache.set(cacheKey, text);
        return { content: [{ type: 'text' as const, text }] };
      });
    },
  );
}
