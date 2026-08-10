import { assertDodoConfiguration, WEEKLY_PLAN } from '../api/_dodo.mjs';

try {
  await assertDodoConfiguration();
  console.log(JSON.stringify({
    valid: true,
    plan: WEEKLY_PLAN.code,
    currency: WEEKLY_PLAN.currency,
    amount: WEEKLY_PLAN.price,
    billing: 'one_time',
    duration_days: WEEKLY_PLAN.days,
    activation_limit: WEEKLY_PLAN.activations
  }));
} catch (error) {
  console.error(JSON.stringify({
    valid: false,
    reason: error && error.constructor && error.constructor.name || 'ConfigurationError'
  }));
  process.exitCode = 1;
}
