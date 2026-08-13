import { assertPlanConfiguration, PLANS } from '../api/_dodo.mjs';

let ok = true;
for (const plan of Object.values(PLANS)) {
  try {
    await assertPlanConfiguration(plan.code);
    console.log(JSON.stringify({
      valid: true,
      plan: plan.code,
      currency: plan.currency,
      amount: plan.net,
      list_amount: plan.list_price,
      billing: 'one_time',
      duration_days: plan.days,
      activation_limit: plan.activations
    }));
  } catch (error) {
    ok = false;
    console.error(JSON.stringify({
      valid: false,
      plan: plan.code,
      reason: error && error.constructor && error.constructor.name || 'ConfigurationError'
    }));
  }
}
if (!ok) process.exitCode = 1;
