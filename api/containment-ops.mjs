import crypto from 'node:crypto';
import {
  dodo,
  cors,
  readBody,
  PASS_PLANS,
  MONTHLY_ENTITLEMENT_ID
} from './_dodo.mjs';

const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORTER_PRODUCT_ID = 'pdt_0NjbdVzVqfSrrofI36ENV';

function authorized(req) {
  const expected = Buffer.from(String(process.env.CONTAINMENT_OPS_TOKEN || ''));
  const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  return expected.length > 0 && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

async function list(path) {
  const items = [];
  for (let page = 0; page < 100; page++) {
    const joiner = path.includes('?') ? '&' : '?';
    const response = await dodo(`${path}${joiner}page_size=${PAGE_SIZE}&page_number=${page}`);
    const batch = response.items || [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}

const planByProduct = new Map(Object.entries(PASS_PLANS).map(([code, plan]) => [
  plan.product_id,
  { code, label: plan.label, entitlement_id: plan.entitlement_id }
]));
planByProduct.set(SUPPORTER_PRODUCT_ID, {
  code: 'supporter-monthly',
  label: 'Monthly supporter',
  entitlement_id: MONTHLY_ENTITLEMENT_ID
});

async function loadState() {
  const entitlementIds = [...new Set([
    ...Object.values(PASS_PLANS).map((plan) => plan.entitlement_id),
    MONTHLY_ENTITLEMENT_ID
  ].filter(Boolean))];

  const [payments, refunds, subscriptions, licenseKeys, grantGroups] = await Promise.all([
    list('/payments'),
    list('/refunds'),
    list('/subscriptions'),
    list('/license_keys'),
    Promise.all(entitlementIds.map(async (entitlementId) => ({
      entitlementId,
      grants: await list(`/entitlements/${encodeURIComponent(entitlementId)}/grants`)
    })))
  ]);

  const paymentDetails = await Promise.all(payments.map(async (payment) => {
    try {
      return await dodo('/payments/' + encodeURIComponent(payment.payment_id));
    } catch {
      return null;
    }
  }));

  return { payments, paymentDetails, refunds, subscriptions, licenseKeys, grantGroups };
}

function buildInventory(state) {
  const refundByPayment = new Map();
  for (const refund of state.refunds) {
    const statuses = refundByPayment.get(refund.payment_id) || [];
    statuses.push(String(refund.status || 'unknown'));
    refundByPayment.set(refund.payment_id, statuses);
  }

  const licenseStatusByKey = new Map(state.licenseKeys.map((license) => [
    license.key,
    { status: String(license.status || 'unknown'), expires_at: license.expires_at || null }
  ]));
  const licensesByCustomer = new Map();
  for (const license of state.licenseKeys) {
    const licenses = licensesByCustomer.get(license.customer_id) || [];
    licenses.push(license);
    licensesByCustomer.set(license.customer_id, licenses);
  }
  const grantsByPayment = new Map();
  const grantsBySubscription = new Map();
  const grantsByCustomer = new Map();
  for (const group of state.grantGroups) {
    for (const grant of group.grants) {
      const normalized = {
        entitlement_id: group.entitlementId,
        status: String(grant.status || 'unknown'),
        key: grant.license_key && grant.license_key.key
          ? (licenseStatusByKey.get(grant.license_key.key) || {
              status: String(grant.status || 'unknown'),
              expires_at: grant.license_key.expires_at || null
            })
          : null
      };
      if (grant.payment_id) {
        const grants = grantsByPayment.get(grant.payment_id) || [];
        grants.push(normalized);
        grantsByPayment.set(grant.payment_id, grants);
      }
      if (grant.subscription_id) {
        const grants = grantsBySubscription.get(grant.subscription_id) || [];
        grants.push(normalized);
        grantsBySubscription.set(grant.subscription_id, grants);
      }
      if (grant.customer_id) {
        const grants = grantsByCustomer.get(grant.customer_id) || [];
        grants.push(normalized);
        grantsByCustomer.set(grant.customer_id, grants);
      }
    }
  }

  const keysByPayment = new Map();
  for (const key of state.licenseKeys) {
    if (!key.payment_id) continue;
    const keys = keysByPayment.get(key.payment_id) || [];
    keys.push({
      status: String(key.status || 'unknown'),
      expires_at: key.expires_at || null
    });
    keysByPayment.set(key.payment_id, keys);
  }

  const subscriptionById = new Map(state.subscriptions.map((subscription) => [
    subscription.subscription_id,
    subscription
  ]));

  const purchases = state.payments.map((payment, index) => {
    const detail = state.paymentDetails[index];
    const subscription = payment.subscription_id
      ? subscriptionById.get(payment.subscription_id)
      : null;
    const customerId = (payment.customer && payment.customer.customer_id) ||
      (detail && detail.customer && detail.customer.customer_id) ||
      null;
    const productIds = [...new Set([
      ...(detail && detail.product_cart || []).map((item) => item.product_id),
      subscription && subscription.product_id
    ].filter(Boolean))];
    const products = productIds.map((productId) => {
      const plan = planByProduct.get(productId);
      return {
        product_id: productId,
        plan: plan ? plan.code : 'unmapped',
        label: plan ? plan.label : 'Unmapped Dodo product',
        expected_entitlement_id: plan ? plan.entitlement_id : null
      };
    });
    let grants = grantsByPayment.get(payment.payment_id) ||
      (payment.subscription_id ? grantsBySubscription.get(payment.subscription_id) : null) ||
      [];
    if (!grants.length && customerId) {
      const expectedEntitlements = new Set(products.map((product) => product.expected_entitlement_id));
      grants = (grantsByCustomer.get(customerId) || [])
        .filter((grant) => expectedEntitlements.has(grant.entitlement_id))
        .map((grant) => ({ ...grant, status: `${grant.status} (canonical customer grant)` }));
    }
    const grantKeys = grants.map((grant) => grant.key).filter(Boolean);
    let keys = grantKeys.length
      ? grantKeys
      : (keysByPayment.get(payment.payment_id) || []);
    if (!keys.length && customerId) {
      const productSet = new Set(products.map((product) => product.product_id));
      keys = (licensesByCustomer.get(customerId) || [])
        .filter((license) => productSet.has(license.product_id))
        .map((license) => ({
          status: String(license.status || 'unknown'),
          expires_at: license.expires_at || null
        }));
    }
    let replacementCoverage = false;
    if (!keys.length && customerId) {
      keys = (licensesByCustomer.get(customerId) || [])
        .filter((license) => license.status === 'active' || license.status === 'expired')
        .map((license) => ({
          status: String(license.status || 'unknown'),
          expires_at: license.expires_at || null,
          coverage: 'replacement_or_canonical_time'
        }));
      replacementCoverage = keys.length > 0;
    }
    const entitlements = grants.length
      ? grants.map(({ entitlement_id, status }) => ({ entitlement_id, status }))
      : products.map((product) => ({
          entitlement_id: product.expected_entitlement_id,
          status: replacementCoverage
            ? 'covered_by_replacement_time'
            : (payment.status === 'succeeded' ? 'not_granted' : 'not_applicable')
        }));
    return {
      record: `purchase-${String(index + 1).padStart(3, '0')}`,
      products,
      entitlements,
      payment: {
        status: String(payment.status || 'unknown'),
        amount: payment.total_amount == null ? null : payment.total_amount,
        currency: payment.currency || null,
        refund_status: payment.refund_status || null,
        refunds: refundByPayment.get(payment.payment_id) || []
      },
      keys: keys.length ? keys : [{ status: 'not_issued', expires_at: null }]
    };
  });

  return {
    generated_at: new Date().toISOString(),
    sanitized: true,
    excluded_fields: [
      'customer',
      'customer_id',
      'email',
      'name',
      'phone',
      'address',
      'payment_id',
      'refund_id',
      'license_key',
      'license_key_id'
    ],
    purchase_count: purchases.length,
    purchases
  };
}

async function revokeDiscounts() {
  const discounts = await list('/discounts');
  let revoked = 0;
  let failed = 0;
  for (const discount of discounts) {
    try {
      await dodo('/discounts/' + encodeURIComponent(discount.discount_id), { method: 'DELETE' });
      revoked++;
    } catch {
      failed++;
    }
  }
  return { found: discounts.length, revoked, failed };
}

async function normalizeStacking(licenseKeys) {
  const now = Date.now();
  const byCustomer = new Map();
  for (const key of licenseKeys) {
    const expiry = key.expires_at ? Date.parse(key.expires_at) : 0;
    if (!key.customer_id || key.status !== 'active' || !expiry || expiry <= now) continue;
    const keys = byCustomer.get(key.customer_id) || [];
    keys.push({ ...key, expiry });
    byCustomer.set(key.customer_id, keys);
  }

  let found = 0;
  let extended = 0;
  let failed = 0;
  for (const keys of byCustomer.values()) {
    if (keys.length < 2) continue;
    found++;
    const totalRemaining = keys.reduce((sum, key) => sum + (key.expiry - now), 0);
    const canonical = [...keys]
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0];
    const promisedExpiry = new Date(now + totalRemaining).toISOString();
    try {
      await dodo('/license_keys/' + encodeURIComponent(canonical.id), {
        method: 'PATCH',
        body: { expires_at: promisedExpiry }
      });
      const source = licenseKeys.find((key) => key.id === canonical.id);
      if (source) source.expires_at = promisedExpiry;
      extended++;
    } catch {
      failed++;
    }
  }
  return { customers_with_stacked_time: found, canonical_keys_extended: extended, failed };
}

async function backfillUnfulfilledSupporterPayments(state, dryRun) {
  const subscriptionById = new Map(state.subscriptions.map((subscription) => [
    subscription.subscription_id,
    subscription
  ]));
  const deliveredCustomers = new Set();
  for (const group of state.grantGroups) {
    if (group.entitlementId !== MONTHLY_ENTITLEMENT_ID) continue;
    for (const grant of group.grants) {
      if (String(grant.status).toLowerCase() === 'delivered') deliveredCustomers.add(grant.customer_id);
    }
  }
  const supporterKeyCustomers = new Set(state.licenseKeys
    .filter((license) => license.product_id === SUPPORTER_PRODUCT_ID)
    .map((license) => license.customer_id));

  const unfulfilledByCustomer = new Map();
  state.payments.forEach((payment, index) => {
    if (payment.status !== 'succeeded') return;
    const detail = state.paymentDetails[index];
    const subscription = payment.subscription_id
      ? subscriptionById.get(payment.subscription_id)
      : null;
    const productIds = new Set([
      ...(detail && detail.product_cart || []).map((item) => item.product_id),
      subscription && subscription.product_id
    ].filter(Boolean));
    if (!productIds.has(SUPPORTER_PRODUCT_ID)) return;
    const customerId = (payment.customer && payment.customer.customer_id) ||
      (detail && detail.customer && detail.customer.customer_id) ||
      null;
    if (!customerId || deliveredCustomers.has(customerId) || supporterKeyCustomers.has(customerId)) return;
    unfulfilledByCustomer.set(customerId, (unfulfilledByCustomer.get(customerId) || 0) + 1);
  });

  let customersCoveredByIndefiniteKey = 0;
  let canonicalKeysExtended = 0;
  let replacementKeysCreated = 0;
  let failed = 0;
  let daysIssued = 0;
  for (const [customerId, paymentCount] of unfulfilledByCustomer) {
    const customerKeys = state.licenseKeys
      .filter((license) => license.customer_id === customerId && ['active', 'expired'].includes(license.status))
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    const indefinite = customerKeys.find((license) => license.status === 'active' && !license.expires_at);
    if (indefinite) {
      customersCoveredByIndefiniteKey++;
      continue;
    }

    const issuedDays = paymentCount * 30;
    const expiresAt = new Date(Math.max(
      Date.now(),
      ...customerKeys.map((license) => license.expires_at ? Date.parse(license.expires_at) : 0)
    ) + issuedDays * DAY_MS).toISOString();
    if (dryRun) {
      if (customerKeys.length) canonicalKeysExtended++;
      else replacementKeysCreated++;
      daysIssued += issuedDays;
      continue;
    }

    try {
      if (customerKeys.length) {
        const canonical = customerKeys[0];
        await dodo('/license_keys/' + encodeURIComponent(canonical.id), {
          method: 'PATCH',
          body: { expires_at: expiresAt }
        });
        const source = state.licenseKeys.find((license) => license.id === canonical.id);
        if (source) {
          source.status = 'active';
          source.expires_at = expiresAt;
        }
        canonicalKeysExtended++;
      } else {
        const replacement = await dodo('/license_keys', {
          method: 'POST',
          body: {
            key: crypto.randomUUID(),
            customer_id: customerId,
            product_id: PASS_PLANS['7d'].product_id,
            activations_limit: 1,
            expires_at: expiresAt
          }
        });
        state.licenseKeys.push(replacement);
        replacementKeysCreated++;
      }
      daysIssued += issuedDays;
    } catch {
      failed++;
    }
  }

  return {
    dry_run: !!dryRun,
    unfulfilled_payments: [...unfulfilledByCustomer.values()].reduce((sum, count) => sum + count, 0),
    affected_customers: unfulfilledByCustomer.size,
    customers_covered_by_indefinite_key: customersCoveredByIndefiniteKey,
    canonical_keys_extended: canonicalKeysExtended,
    replacement_keys_created: replacementKeysCreated,
    replacement_days_issued: daysIssued,
    failed
  };
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authorized(req)) return res.status(404).json({ error: 'Not found' });

  const body = readBody(req);
  if (!['inventory', 'contain', 'backfill-supporter'].includes(body.action)) {
    return res.status(400).json({ error: 'Unsupported action' });
  }

  try {
    const state = await loadState();
    let reconciliation = null;
    if (body.action === 'contain') {
      reconciliation = {
          discounts: await revokeDiscounts(),
          stacking: await normalizeStacking(state.licenseKeys)
      };
    } else if (body.action === 'backfill-supporter') {
      reconciliation = {
        supporter_backfill: await backfillUnfulfilledSupporterPayments(state, body.dry_run !== false)
      };
    }
    return res.status(200).json({
      ok: true,
      action: body.action,
      reconciliation,
      inventory: buildInventory(state)
    });
  } catch {
    return res.status(502).json({ ok: false, error: 'Containment operation failed' });
  }
}
