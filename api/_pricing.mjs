// Multi-pass pricing. One key, valid on `quantity` browsers, priced as
// quantity × the plan price minus a volume discount. Totals round to whole rupees.
export const MAX_QUANTITY = 50;
// Owner decision 2026-10-03: more than 20 passes (21+) are half price, and the
// rates below ramp smoothly up to it so buying more never costs less in total
// than buying fewer (no tier cliff): 12% for 2 passes, +2% per extra pass,
// 48% at 20, then 50% from 21.
export const BULK_TIERS = Object.freeze([
  ...Array.from({ length: 19 }, (_, i) => Object.freeze({ min: i + 2, pct: 12 + 2 * i })),
  Object.freeze({ min: 21, pct: 50 })
]);

export function discountFor(quantity) {
  let pct = 0;
  for (const tier of BULK_TIERS) if (quantity >= tier.min) pct = tier.pct;
  return pct;
}

export function priceFor(plan, quantity = 1) {
  const q = Number(quantity);
  if (!plan || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) return null;
  const subtotal = plan.net * q;
  const pct = discountFor(q);
  const total = Math.round((subtotal * (100 - pct)) / 100 / 100) * 100;
  return { quantity: q, unit: plan.net, subtotal, discountPct: pct, discount: subtotal - total, total };
}
