import { WEEKLY_PLAN } from './_dodo.mjs';
import { beginRequest, featureEnabled } from './_http.mjs';

export default function handler(req, res) {
  if (!beginRequest(req, res, ['GET'])) return;
  return res.status(200).json({
    sales_enabled: featureEnabled('PASS_SALES_ENABLED'),
    gate_enabled: featureEnabled('PASS_GATE_ENABLED'),
    plan: {
      code: WEEKLY_PLAN.code,
      currency: WEEKLY_PLAN.currency,
      amount: WEEKLY_PLAN.price,
      duration_days: WEEKLY_PLAN.days,
      activation_limit: WEEKLY_PLAN.activations,
      billing: 'one_time'
    }
  });
}
