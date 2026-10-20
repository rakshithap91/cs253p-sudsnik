import {
  CYCLE_UNIT_PRICE_MINOR,
  DEFAULT_CURRENCY,
  EXPECTED_CYCLE_UNITS,
  WASH_PRICE_MINOR,
  isCurrency,
  toCurrency,
  type Currency,
} from "@sudsnik/contracts";

export type PricingTier = "standard" | "priority";

export function asCurrency(currency: string): Currency {
  return isCurrency(currency) ? currency : DEFAULT_CURRENCY;
}

export function priceMinor(tier: PricingTier, currency: string, cycleUnits: number): number {
  const usd = WASH_PRICE_MINOR[tier] + CYCLE_UNIT_PRICE_MINOR * cycleUnits;
  return toCurrency(usd, asCurrency(currency));
}

export function quoteMinor(tier: PricingTier, currency: string): number {
  return priceMinor(tier, currency, EXPECTED_CYCLE_UNITS);
}

export function washBaseMinor(tier: PricingTier, currency: string): number {
  return toCurrency(WASH_PRICE_MINOR[tier], asCurrency(currency));
}
