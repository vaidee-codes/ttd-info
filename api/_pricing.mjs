// Multi-pass pricing. One key, valid on `quantity` browsers, priced as
// quantity × the plan price minus a volume discount. Totals round to whole rupees.
export const MAX_QUANTITY = 50;
export const BULK_TIERS = Object.freeze([
  Object.freeze({ min: 2, pct: 10 }),
  Object.freeze({ min: 5, pct: 15 }),
  Object.freeze({ min: 10, pct: 20 }),
  Object.freeze({ min: 25, pct: 25 })
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
