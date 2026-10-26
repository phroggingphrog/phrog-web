const MARKETPLACE_CURRENCY: Record<string, string> = {
  EBAY_US: 'USD', EBAY_GB: 'GBP', EBAY_DE: 'EUR', EBAY_FR: 'EUR', EBAY_IT: 'EUR',
  EBAY_ES: 'EUR', EBAY_NL: 'EUR', EBAY_IE: 'EUR', EBAY_AT: 'EUR', EBAY_BE: 'EUR',
  EBAY_CA: 'CAD', EBAY_AU: 'AUD', EBAY_CH: 'CHF', EBAY_PL: 'PLN', EBAY_HK: 'HKD',
  EBAY_SG: 'SGD', EBAY_MY: 'MYR', EBAY_PH: 'PHP', EBAY_TW: 'TWD',
};

export function currencySymbol(code: string): string {
  return { USD: '$', GBP: '£', AUD: 'A$', CAD: 'C$', EUR: '€', CHF: 'CHF ', PLN: 'zł', HKD: 'HK$' }[code] ?? `${code} `;
}

export function marketplaceCurrency(marketplaceId: string): string {
  return MARKETPLACE_CURRENCY[marketplaceId] ?? 'USD';
}
