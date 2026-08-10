import crypto from 'node:crypto';
import {
  dodo,
  cors,
  readBody,
  PASS_PLANS,
  MONTHLY_ENTITLEMENT_ID
} from './_dodo.mjs';

const PAGE_SIZE = 100;

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
  { code, label: plan.label }
]));

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
  const grantsByPayment = new Map();
  const grantsBySubscription = new Map();
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
    const productIds = [...new Set([
      ...(detail && detail.product_cart || []).map((item) => item.product_id),
      subscription && subscription.product_id
    ].filter(Boolean))];
    const products = productIds.map((productId) => {
      const plan = planByProduct.get(productId);
      return {
        product_id: productId,
        plan: plan ? plan.code : 'unmapped',
        label: plan ? plan.label : 'Unmapped Dodo product'
      };
    });
    const grants = grantsByPayment.get(payment.payment_id) ||
      (payment.subscription_id ? grantsBySubscription.get(payment.subscription_id) : null) ||
      [];
    const grantKeys = grants.map((grant) => grant.key).filter(Boolean);
    return {
      record: `purchase-${String(index + 1).padStart(3, '0')}`,
      products,
      entitlements: grants.map(({ entitlement_id, status }) => ({ entitlement_id, status })),
      payment: {
        status: String(payment.status || 'unknown'),
        refund_status: payment.refund_status || null,
        refunds: refundByPayment.get(payment.payment_id) || []
      },
      keys: grantKeys.length ? grantKeys : (keysByPayment.get(payment.payment_id) || [])
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

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authorized(req)) return res.status(404).json({ error: 'Not found' });

  const body = readBody(req);
  if (!['inventory', 'contain'].includes(body.action)) {
    return res.status(400).json({ error: 'Unsupported action' });
  }

  try {
    const state = await loadState();
    const reconciliation = body.action === 'contain'
      ? {
          discounts: await revokeDiscounts(),
          stacking: await normalizeStacking(state.licenseKeys)
        }
      : null;
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
