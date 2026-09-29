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
    status.ts       # check_login_status
  utils/
    cache.ts        # in-memory TTL cache
    errors.ts       # error wrapper / friendly messages
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

**On search cards, use `applied_product_promo_price`, not `price`.** Search results carry a recommended shop voucher, and `price` has that voucher deducted a **second** time. `applied_product_promo_price` is the post-voucher price Shopee actually shows. Verified against a live listing:

```
original_price                478.06     (= the page's "Original Price")
  product discount           −249.06
  shop voucher               − 30.00
applied_product_promo_price   199.00     (= the page's "After Voucher")
price                         169.00     (= 199.00 − 30.00 again)
```

Displaying `price` under-reports every voucher-bearing card by the voucher amount. The relationship `price = applied_product_promo_price − voucher_discount` holds consistently, which makes it tempting to read `price` as the final figure — it is not. The voucher itself is in `recommended_shop_voucher_info`, and is often restricted to a membership tier (`groups: ["Shopee Plus"]`) and a `min_spend`, so the price is not unconditional.

**App-exclusive pricing is not visible.** This server reads Shopee's **PC web** app, and the mobile app can show a lower price for the same item — one listing showed RM296.99 on web against RM288.08 in the app. That figure appears nowhere in the PC payload: not in `get_pc`, not in any of the ~20 other endpoints the product page calls, and not in the rendered page. It is structurally out of reach here, not a parsing gap. Closing it would mean targeting the mobile API, a different anti-bot surface.

**Exact per-variant stock is also absent** from `get_pc` (`stock` and `normal_stock` are null at `detail_level: 0`, which the page controls). It comes only from `cart_panel/select_variation_pc`, fired when a variant is selected — one round trip per variant, which is why `get_product_variants` makes `includeStock` opt-in.

## Build output

`npm run build` emits JavaScript under **`build/`**. The repo **gitignores** `build/`; CI and `prepublishOnly` run `npm run build`.

## Tech stack

- TypeScript, **strict** (with `noUnusedLocals` / `noUnusedParameters`)
- Zod for MCP tool input validation
- `@modelcontextprotocol/sdk` (stdio), CloakBrowser + Playwright
