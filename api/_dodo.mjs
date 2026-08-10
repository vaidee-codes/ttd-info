import { createHash, timingSafeEqual } from 'node:crypto';

const LIVE_BASE = 'https://live.dodopayments.com';
const TEST_BASE = 'https://test.dodopayments.com';
const REQUEST_TIMEOUT_MS = 8000;

export const WEEKLY_PRODUCT_ID = 'pdt_0Nk4Gw67usedtjPoO6hX2';
export const WEEKLY_ENTITLEMENT_ID = 'ent_0Nk4GugPIsPbnFf5dYYqC';
export const LEGACY_30_DAY_PRODUCT_ID = 'pdt_0NkvjEpCQNkDuaCT65cFV';
export const LEGACY_90_DAY_PRODUCT_ID = 'pdt_0NkvjEr1l8rhSF6Ibxlj3';
export const SUPPORTER_PRODUCT_ID = 'pdt_0NjbdVzVqfSrrofI36ENV';
export const WEEKLY_PLAN = Object.freeze({
  code: '7d',
  product_id: WEEKLY_PRODUCT_ID,
  entitlement_id: WEEKLY_ENTITLEMENT_ID,
  currency: 'INR',
  price: 9900,
  days: 7,
  activations: 1,
  label: '7-day pass'
});

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

  const expiresAt = license && license.expires_at ? Date.parse(license.expires_at) : null;
  const productId = String(license && license.product_id || '');
  const basicValid = validation && validation.valid === true &&
    instance && instance.id === instanceId && instance.license_key_id === licenseKeyId &&
    license && license.id === licenseKeyId && exactSecretMatch(license.key, licenseKey) &&
    isAcceptedProduct(productId) && (!expectedProductId || productId === expectedProductId) &&
    license.status === 'active' && license.activations_limit === WEEKLY_PLAN.activations &&
    (!expiresAt || (Number.isFinite(expiresAt) && expiresAt > Date.now()));
  if (!basicValid) return { valid: false, productId, license };

  // Existing 30/90-day and supporter keys predate the weekly-only checkout.
  // Dodo's public validation plus the direct key/instance records remain the
  // authority for them. In particular, a no-expiry supporter key is accepted
  // only while /licenses/validate reports it valid on this exact instance.
  if (productId !== providerConfig().productId) {
    return { valid: true, productId, license };
  }

  if (!license.payment_id) return { valid: false, productId, license };

  const payment = await getPaymentById(license.payment_id);
  const paymentValid = payment && payment.payment_id === license.payment_id &&
    payment.status === 'succeeded' && payment.currency === WEEKLY_PLAN.currency &&
    hasProductCart(payment, productId) && !!payment.checkout_session_id;
  if (!paymentValid) return { valid: false, productId, license };

  const checkout = await getCheckoutById(payment.checkout_session_id);
  const checkoutValid = checkout && checkout.id === payment.checkout_session_id &&
    checkout.payment_id === payment.payment_id && checkout.payment_status === 'succeeded';

  return { valid: !!checkoutValid, productId, license };
}

export async function assertDodoConfiguration() {
  const config = providerConfig();
  const [product, entitlement] = await Promise.all([
    dodo('/products/' + encodeURIComponent(config.productId)),
    dodo('/entitlements/' + encodeURIComponent(config.entitlementId))
  ]);
  const price = product && product.price || {};
  const integration = entitlement && entitlement.integration_config || {};
  const attachedIds = new Set((product && product.entitlements || []).map((item) => String(item.entitlement_id || item.id || '')));
  const valid = product && product.product_id === config.productId &&
    product.is_recurring === false && price.currency === WEEKLY_PLAN.currency &&
    price.price === WEEKLY_PLAN.price && price.pay_what_you_want !== true &&
    entitlement && entitlement.id === config.entitlementId && entitlement.is_active === true &&
    entitlement.integration_type === 'license_key' && integration.fulfillment_mode === 'auto' &&
    integration.duration_count === WEEKLY_PLAN.days && integration.duration_interval === 'Day' &&
    integration.activations_limit === WEEKLY_PLAN.activations &&
    (attachedIds.size === 0 || attachedIds.has(config.entitlementId));
  if (!valid) throw new ProviderConfigurationError();
  return true;
}

export function createCheckoutIdempotencyKey(requestId) {
  return 'pass-checkout-' + createHash('sha256').update(requestId, 'utf8').digest('hex');
}
