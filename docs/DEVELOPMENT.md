# Development

## Scripts

| Command             | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `npm install`       | Install dependencies (also fetches the CloakBrowser binary) |
| `npm run login`     | One-time: open a browser window and log into Shopee         |
| `npm run build`     | Compile TypeScript to `build/` (`tsc`)                      |
| `npm run dev`       | Watch mode: `tsx watch src/index.ts`                        |
| `npm run start`     | Run compiled server: `node build/index.js`                  |
| `npm run lint`      | ESLint over the repo                                        |
| `npm run format`    | Prettier write; `npm run format:check` to verify            |
| `npm run typecheck` | `tsc --noEmit`, strict, with unused-symbol checks           |
| `npm run test:unit` | Offline unit tests — no login, no display, safe in CI       |
| `npm test`          | **Live smoke test** — needs a login and a display           |

## Project layout

```
src/
  index.ts          # MCP server entry; registers tools
  login.ts          # one-time interactive login (npm run login)
  api/
    client.ts       # navigates the real page and intercepts the app's response
    types.ts        # shared types
  browser/
    session.ts      # CloakBrowser persistent-profile session
  tools/
    search.ts       # search_products
    product.ts      # get_product_detail
    variants.ts     # get_product_variants
    status.ts       # check_login_status
  utils/
    cache.ts        # in-memory TTL cache
    errors.ts       # error wrapper / friendly messages
    price.ts        # currency table; shared by search and product
test/
  unit.ts           # offline unit tests (npm run test:unit)
  smoke.ts          # the npm test health check (live)
```

## Why a browser is required

Shopee does **not** expose an open API or server-rendered product HTML. Its `/api/v4/*` endpoints are guarded by an anti-fraud gate that requires per-request signature headers minted by Shopee's own obfuscated SDK. Plain `fetch`, headless Chromium, and hand-rolled in-page fetches are all rejected.

So this server drives **[CloakBrowser](https://github.com/CloakHQ/cloakbrowser)** (a fingerprint-patched Chromium) against a persistent profile you log into once, **navigates to the real Shopee page, and intercepts the response** its own app fetches — so the request carries valid signatures. The browser runs **headed** (Shopee detects headless); on a server use `xvfb`.

## How Shopee reports prices

Prices are the real amount **× 100000** (`29699000` is RM296.99). Beyond that, two things about the payload are easy to get wrong.

**`product_price.price` is already the final, post-voucher price.** `price_before_discount` is the original. `price_breakdown.discount_breakdown[]` **explains the gap between them** — it is not a list of further deductions to apply on top of `price`. For one observed listing:

```
price_before_discount   RM299.99
discount_breakdown      Shop Voucher Discount  −RM3.00
price                   RM296.99
```

`299.99 − 3.00 = 296.99` exactly. Subtracting `discount_amount` from `price` would double-count the voucher and under-report every discounted listing. Report `price` as-is; read `discount_breakdown` only for attribution (which voucher produced the reduction).

**On search cards, `price` is the one to show — not `applied_product_promo_price`.** Cards carry a recommended shop voucher; `price` already has it deducted, and `applied_product_promo_price` is the **pre**-voucher figure. The name reads like the opposite, so check before trusting it. Three cards sampled against their own PDP `price_breakdown` in the same session:

| card `price` | `applied_product_promo_price` | PDP authoritative |
| ------------ | ----------------------------- | ----------------- |
| 251.10       | 279.00                        | **251.10**        |
| 278.10       | 309.00                        | **278.10**        |
| 289.13       | 319.13                        | **289.13**        |

To verify this yourself, compare a card against **that same item's** PDP in one session. Comparing across sessions is unreliable: Shopee runs flash sales that move prices within the hour. A **virtual card** is also useless as evidence here — its PDP resolves to a different default variant, so neither field will match, and that mismatch says nothing about the field semantics.

The voucher is in `recommended_shop_voucher_info`. It must be claimed, usually carries a `min_spend`, and is often restricted to a membership tier (`groups: ["Shopee Plus"]`), so the price is real but not unconditional — `search_products` prints those terms under the price.

**App-exclusive pricing is not visible.** This server reads Shopee's **PC web** app, and the mobile app can show a lower price for the same item — one listing showed RM296.99 on web against RM288.08 in the app. That figure appears nowhere in the PC payload: not in `get_pc`, not in any of the ~20 other endpoints the product page calls, and not in the rendered page. It is structurally out of reach here, not a parsing gap. Closing it would mean targeting the mobile API, a different anti-bot surface.

**Exact per-variant stock and per-variant post-voucher prices are both absent** from `get_pc`. `stock` and `normal_stock` are null at `detail_level: 0` (the page controls that), and `models[].price` is the **list** price, excluding any shop voucher. Both come from `cart_panel/select_variation_pc`, fired when a variant is selected — where `product_price.price` is the post-voucher figure and matches that response's own `price_breakdown.price`:

| variant        | `models[].price` | `select_variation_pc` |
| -------------- | ---------------- | --------------------- |
| 200w 25 000mAh | 279.00           | **249.00**            |
| 130w 20 000mAh | 239.00           | **209.00**            |
| 100w 12 000mAh | 182.09           | **152.09**            |

**Clicking a variant has to wait for hydration.** The option button exists in the DOM before React attaches its handler, so a click fired the moment it appears is a silent no-op — no error, no request, just nothing. `captureWithSelections` settles for 3s after the options render and retries a click once if no response arrives. Without that, a filtered lookup (one click, no second chance) returns zero live data on some listings while looking like it simply found nothing. It is a timing race, not a deterministic fix: a lookup that reports `0 variants matching` is worth re-running before believing it.

That is one round trip per variant, which is why `get_product_variants` keeps `includeStock` opt-in — it gathers both from the same response. On the default path the tool labels its prices as list prices rather than implying they are what you would pay.

## Build output

`npm run build` emits JavaScript under **`build/`**. The repo **gitignores** `build/`; CI and `prepublishOnly` run `npm run build`.

## Tech stack

- TypeScript, **strict** (with `noUnusedLocals` / `noUnusedParameters`)
- Zod for MCP tool input validation
- `@modelcontextprotocol/sdk` (stdio), CloakBrowser + Playwright
