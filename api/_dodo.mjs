import { createHash, timingSafeEqual } from 'node:crypto';

const LIVE_BASE = 'https://live.dodopayments.com';
const TEST_BASE = 'https://test.dodopayments.com';
const REQUEST_TIMEOUT_MS = 8000;

export const WEEKLY_PRODUCT_ID = 'pdt_0Nk4Gw67usedtjPoO6hX2';
export const WEEKLY_ENTITLEMENT_ID = 'ent_0Nk4GugPIsPbnFf5dYYqC';
export const LEGACY_30_DAY_PRODUCT_ID = 'pdt_0NkvjEpCQNkDuaCT65cFV';
export const LEGACY_90_DAY_PRODUCT_ID = 'pdt_0NkvjEr1l8rhSF6Ibxlj3';
export const SUPPORTER_PRODUCT_ID = 'pdt_0NjbdVzVqfSrrofI36ENV';

// Purchasable pass plans. `list_price`/`discount_percent` mirror the live Dodo
// product exactly (Dodo is the source of truth for the amount actually charged);
// `net` is the effective INR-paise price after the product discount and is what
// the config guard verifies. All three issue a one-time, single-activation
// licence key whose duration comes from the attached entitlement below.
export const PLANS = Object.freeze({
  '7d': Object.freeze({
    code: '7d', product_id: WEEKLY_PRODUCT_ID, entitlement_id: WEEKLY_ENTITLEMENT_ID,
    currency: 'INR', list_price: 19800, discount_percent: 50, net: 9900, days: 7, activations: 1, label: '7-day pass'
  }),
  '30d': Object.freeze({
    code: '30d', product_id: LEGACY_30_DAY_PRODUCT_ID, entitlement_id: 'ent_0NkvjEit63fF12KazuaN1',
    currency: 'INR', list_price: 29900, discount_percent: 0, net: 29900, days: 30, activations: 1, label: '30-day pass'
  }),
  '90d': Object.freeze({
    code: '90d', product_id: LEGACY_90_DAY_PRODUCT_ID, entitlement_id: 'ent_0NkvjEqEgOtu4zXZbpSnR',
    currency: 'INR', list_price: 69900, discount_percent: 0, net: 69900, days: 90, activations: 1, label: '90-day pass'
  })
});

export function planByCode(code) {
  return PLANS[String(code || '')] || null;
}

export function planByProductId(productId) {
  const id = String(productId || '');
  return Object.values(PLANS).find((plan) => plan.product_id === id) || null;
}

// Retained alias: existing callers/tests reference WEEKLY_PLAN for the 7-day tier.
export const WEEKLY_PLAN = PLANS['7d'];

export class ProviderError extends Error {
  constructor(status, code = null) {
    super('Payment provider request failed');
    this.status = status;
    this.code = code;
  }
}

export class ProviderConfigurationError extends Error {
  constructor() {
    super('Payment provider configuration is invalid');
  }
}

function providerConfig() {
  const production = process.env.VERCEL_ENV === 'production';
  return {
    base: String(process.env.DODO_API_BASE || (production ? LIVE_BASE : TEST_BASE)).replace(/\/$/, ''),
    apiKey: String(process.env.DODO_API_KEY || '').trim(),
    productId: String(process.env.DODO_PRODUCT_ID || WEEKLY_PRODUCT_ID).trim(),
    entitlementId: String(process.env.DODO_ENTITLEMENT_ID || WEEKLY_ENTITLEMENT_ID).trim()
  };
}

async function request(path, opts = {}) {
  const config = providerConfig();
  const authenticated = opts.authenticated !== false;
  if (authenticated && !config.apiKey) throw new ProviderConfigurationError();

  let response;
  try {
    response = await fetch(config.base + path, {
      method: opts.method || 'GET',
      headers: {
        ...(authenticated ? { Authorization: 'Bearer ' + config.apiKey } : {}),
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const code = json && typeof json === 'object'
      ? (json.code || (json.error && json.error.code) || null)
      : null;
    throw new ProviderError(response.status, code);
  }
  return json;
}

export function logProviderFailure(operation, error) {
  // Never log request bodies, licence keys, customer data, tokens, or provider
  // responses. Status/code are sufficient for operational diagnosis.
  console.error(JSON.stringify({
    event: 'provider_failure',
    operation,
    status: Number(error && error.status) || null,
    code: String(error && error.code || '').slice(0, 64) || null
  }));
}

export function dodo(path, opts = {}) {
  return request(path, { ...opts, authenticated: true });
}

export function activateLicenseKey(key, name) {
  return request('/licenses/activate', {
    authenticated: false,
    method: 'POST',
    body: { license_key: key, name }
  });
}

export function validateLicenseKey(key, instanceId) {
  return request('/licenses/validate', {
    authenticated: false,
    method: 'POST',
    body: { license_key: key, license_key_instance_id: instanceId }
  });
}

export function deactivateLicenseKey(key, instanceId) {
  return request('/licenses/deactivate', {
    authenticated: false,
    method: 'POST',
    body: { license_key: key, license_key_instance_id: instanceId }
  });
}

export function getLicenseKeyById(licenseKeyId) {
  return dodo('/license_keys/' + encodeURIComponent(licenseKeyId));
}

export function getLicenseInstanceById(instanceId) {
  return dodo('/license_key_instances/' + encodeURIComponent(instanceId));
}

export function getPaymentById(paymentId) {
  return dodo('/payments/' + encodeURIComponent(paymentId));
}

export function getCheckoutById(sessionId) {
  return dodo('/checkouts/' + encodeURIComponent(sessionId));
}

function exactSecretMatch(left, right) {
  const a = createHash('sha256').update(String(left || ''), 'utf8').digest();
  const b = createHash('sha256').update(String(right || ''), 'utf8').digest();
  return timingSafeEqual(a, b);
}

function hasProductCart(payment, productId) {
  const cart = Array.isArray(payment && payment.product_cart) ? payment.product_cart : [];
  return cart.length === 1 && cart[0].product_id === productId && cart[0].quantity === 1;
}

export function acceptedProductIds() {
  return new Set([
    providerConfig().productId,
    LEGACY_30_DAY_PRODUCT_ID,
    LEGACY_90_DAY_PRODUCT_ID,
    SUPPORTER_PRODUCT_ID
  ]);
}

export function isAcceptedProduct(productId) {
  return acceptedProductIds().has(String(productId || ''));
}

export async function inspectLicenseBinding({ licenseKey, licenseKeyId, instanceId, expectedProductId }) {
  const [validation, instance, license] = await Promise.all([
    validateLicenseKey(licenseKey, instanceId),
    getLicenseInstanceById(instanceId),
    getLicenseKeyById(licenseKeyId)
  ]);

  const productId = String(license && license.product_id || '');
  const plan = planByProductId(productId);

  // Effective expiry. Purchased keys carry a fixed expires_at set at issuance.
  // Donor / complimentary keys are created with NO expiry on a pass-tier product;
  // for those the pass runs its full tier length from the ACTIVATION timestamp
  // (Dodo's license_key_instance.created_at). This is how we honour
  // activation-based expiry, which Dodo itself does not support. Supporter /
  // subscription keys keep an open expiry (validity follows the subscription).
  const effectiveExpiry = computeEffectiveExpiry(license, instance, plan);
  const effectiveExpiryMs = effectiveExpiry ? Date.parse(effectiveExpiry) : null;

  const basicValid = validation && validation.valid === true &&
    instance && instance.id === instanceId && instance.license_key_id === licenseKeyId &&
    license && license.id === licenseKeyId && exactSecretMatch(license.key, licenseKey) &&
    isAcceptedProduct(productId) && (!expectedProductId || productId === expectedProductId) &&
    license.status === 'active' && license.activations_limit === 1 &&
    (!effectiveExpiryMs || (Number.isFinite(effectiveExpiryMs) && effectiveExpiryMs > Date.now()));
  if (!basicValid) return { valid: false, productId, license, effectiveExpiry };

  // Imported grants (donor thank-you keys and any manually issued key) carry no
  // payment record, and the recurring supporter product is not a one-time pass
  // tier. For both, Dodo's /licenses/validate plus the direct key/instance
  // records are the authority. Only a one-time purchasable tier (7/30/90-day)
  // backed by a real payment gets the full payment + checkout cross-check.
  if (!plan || !license.payment_id) {
    return { valid: true, productId, license, effectiveExpiry };
  }

  const payment = await getPaymentById(license.payment_id);
  // Do not require a specific settlement currency. The product is configured in
  // plan.currency (INR), but Dodo charges foreign buyers in their own
  // presentment currency (USD, etc.), so payment.currency legitimately differs
  // for the same weekly product. Identity is proven by the product_cart match
  // and the checkout-session linkage below, not by the currency; the amount is
  // never cross-checked here in the first place. Only require a real currency.
  const paymentValid = payment && payment.payment_id === license.payment_id &&
    payment.status === 'succeeded' && typeof payment.currency === 'string' && payment.currency.length > 0 &&
    hasProductCart(payment, productId) && !!payment.checkout_session_id;
  if (!paymentValid) return { valid: false, productId, license, effectiveExpiry };

  const checkout = await getCheckoutById(payment.checkout_session_id);
  const checkoutValid = checkout && checkout.id === payment.checkout_session_id &&
    checkout.payment_id === payment.payment_id && checkout.payment_status === 'succeeded';

  return { valid: !!checkoutValid, productId, license, effectiveExpiry };
}

// A pass-tier key with no fixed expiry expires plan.days after its activation
// timestamp; anything else keeps its own expires_at (or none).
export function computeEffectiveExpiry(license, instance, plan) {
  if (license && license.expires_at) return license.expires_at;
  if (plan && instance && instance.created_at) {
    const activatedAt = Date.parse(instance.created_at);
    if (Number.isFinite(activatedAt)) {
      return new Date(activatedAt + plan.days * 86400_000).toISOString();
    }
  }
  return null;
}

export async function assertPlanConfiguration(planCode) {
  const plan = planByCode(planCode);
  if (!plan) throw new ProviderConfigurationError();
  const [product, entitlement] = await Promise.all([
    dodo('/products/' + encodeURIComponent(plan.product_id)),
    dodo('/entitlements/' + encodeURIComponent(plan.entitlement_id))
  ]);
  const price = product && product.price || {};
  const integration = entitlement && entitlement.integration_config || {};
  // Dodo stores the list price plus a discount percent; the amount actually
  // charged is the discounted effective price. Verify that against plan.net.
  const discount = Number(price.discount) || 0;
  const effective = Math.round(Number(price.price) * (100 - discount) / 100);
  const attachedIds = new Set((product && product.entitlements || []).map((item) => String(item.entitlement_id || item.id || '')));
  const valid = product && product.product_id === plan.product_id &&
    product.is_recurring === false && price.currency === plan.currency &&
    effective === plan.net && price.pay_what_you_want !== true &&
    entitlement && entitlement.id === plan.entitlement_id && entitlement.is_active === true &&
    entitlement.integration_type === 'license_key' && integration.fulfillment_mode === 'auto' &&
    integration.duration_count === plan.days && integration.duration_interval === 'Day' &&
    integration.activations_limit === plan.activations &&
    (attachedIds.size === 0 || attachedIds.has(plan.entitlement_id));
  if (!valid) throw new ProviderConfigurationError();
  return true;
}

// Back-compat: the default configuration guard validates the 7-day tier.
export function assertDodoConfiguration() {
  return assertPlanConfiguration('7d');
}

export function createCheckoutIdempotencyKey(requestId) {
  return 'pass-checkout-' + createHash('sha256').update(requestId, 'utf8').digest('hex');
}
