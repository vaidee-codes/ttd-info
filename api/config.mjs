import { PLANS, WEEKLY_PLAN } from './_dodo.mjs';
import { beginRequest, featureEnabled } from './_http.mjs';

function planView(plan) {
  return {
    code: plan.code,
    currency: plan.currency,
    amount: plan.net,
    list_amount: plan.list_price,
    duration_days: plan.days,
    activation_limit: plan.activations,
    label: plan.label,
    billing: 'one_time'
  };
}

export default function handler(req, res) {
  if (!beginRequest(req, res, ['GET'])) return;
  // Public rollout flags — no per-user data. Cacheable at the edge (overrides
  // the default no-store from beginRequest) so a mass simultaneous open of tens
  // of thousands of clients collapses to ~one origin invocation per minute per
  // region instead of one per client. `Vary: Origin` (set upstream) keeps the
  // allowed origins on separate cache entries.
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({
    sales_enabled: featureEnabled('PASS_SALES_ENABLED'),
    gate_enabled: featureEnabled('PASS_GATE_ENABLED'),
    // `plan` retained for older clients that expect the single 7-day tier;
    // `plans` is the full set the pass page renders.
    plan: planView(WEEKLY_PLAN),
    plans: Object.values(PLANS).map(planView)
  });
}
