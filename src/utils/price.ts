// Shopee reports prices as the real amount × 100000, with no currency symbol
// and no indication of how many decimals a currency actually uses. Both the
// search and product tools render prices, so the table lives here rather than
// being duplicated (they drifted once already: the product tool kept formatting
// Malaysian prices with Indonesian rules, printing "MYR 163,03" for RM163.03).

interface CurrencyFormat {
  symbol: string;
  locale: string;
  decimals: number;
}

const CURRENCY_FORMATS: Record<string, CurrencyFormat> = {
  IDR: { symbol: 'Rp', locale: 'id-ID', decimals: 0 },
  MYR: { symbol: 'RM', locale: 'en-MY', decimals: 2 },
  SGD: { symbol: 'S$', locale: 'en-SG', decimals: 2 },
  TWD: { symbol: 'NT$', locale: 'zh-TW', decimals: 0 },
};

/** Render a raw Shopee price (real amount × 100000) for display. */
export function formatPrice(raw: number, currency = 'IDR'): string {
  const amount = raw / 100000;
  const fmt = CURRENCY_FORMATS[currency];
  // Unknown currency: show the code rather than guess at a symbol or precision.
  if (!fmt) return `${currency} ${amount.toLocaleString('id-ID')}`;
  return `${fmt.symbol}${amount.toLocaleString(fmt.locale, {
    minimumFractionDigits: fmt.decimals,
    maximumFractionDigits: fmt.decimals,
  })}`;
}
