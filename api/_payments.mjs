import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PLANS, ProviderConfigurationError, ProviderError } from './_dodo.mjs';
import { deliverForOrder } from './_email.mjs';
import { createLicenseWithKey } from './_keygen.mjs';
import { insertOne, licenceKeyHash, openSecret, sealSecret, selectOne, sha256Hex, updateWhere } from './_ledger.mjs';
import { capturePayment, getPayment, listOrderPayments, paymentMatchesOrder } from './_razorpay.mjs';

export function normaliseEmail(value) {
  const email = String(value || '').trim();
  const at = email.lastIndexOf('@');
  // Keep the local part as typed (plus-addressing included); only the domain is case-insensitive.
  return at > 0 ? email.slice(0, at) + '@' + email.slice(at + 1).toLowerCase() : email;
}

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// TTD-XXXXX-XXXXX-XXXXX-XXXXX: 20 symbols from a 32-letter alphabet = 100 bits.
export function generateLicenceKey() {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b & 31]).join('');
  return 'TTD-' + chars.match(/.{5}/g).join('-');
}

export function newPurchaseToken() {
  return randomBytes(32).toString('base64url');
}

export function purchaseTokenMatches(order, token) {
  if (!order || !token) return false;
  const given = Buffer.from(sha256Hex(token), 'utf8');
  return [order.purchase_token_hash, order.purchase_token_hash_prev].some((hash) => {
    if (!hash) return false;
    const expected = Buffer.from(hash, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

function policyFor(plan) {
  let map;
  try {
    map = JSON.parse(String(process.env.KEYGEN_PLAN_POLICIES || '{}'));
  } catch {
    map = {};
  }
  const policyId = map && map[plan];
  if (!policyId) throw new ProviderConfigurationError();
  return policyId;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

// Finds the captured Razorpay payment for an order. An `authorized` payment is
// captured here, in case the account's auto-capture setting is off.
async function capturedPaymentFor(order, paymentId) {
  const candidates = paymentId ? [await getPayment(paymentId)] : await listOrderPayments(order.razorpay_order_id);
  const matching = candidates.filter((p) => paymentMatchesOrder(p, order));
  let captured = matching.find((p) => p.status === 'captured');
  if (!captured) {
    const authorized = matching.find((p) => p.status === 'authorized');
    if (authorized) captured = await capturePayment(authorized.id, order.amount_paise);
  }
  const extra = matching.filter((p) => p.status === 'captured' && captured && p.id !== captured.id);
  if (extra.length) log('payment_duplicate_capture', { order_id: order.id, count: extra.length });
  return captured && captured.status === 'captured' ? captured : null;
}

// Idempotent: any number of concurrent/retried calls produce one licence.
export async function fulfilOrder(order) {
  if (!PLANS[order.plan]) throw new ProviderConfigurationError();
  await insertOne('fulfilments', { order_id: order.id, license_key_enc: sealSecret(generateLicenceKey()) },
    { onConflict: 'order_id', ignoreDuplicates: true });
  const fulfilment = await selectOne('fulfilments', { order_id: order.id });
  if (!fulfilment) throw new ProviderError(503, 'FULFILMENT_MISSING');
  const licenseKey = openSecret(fulfilment.license_key_enc);

  if (fulfilment.status !== 'provisioned') {
    const quantity = Number(order.quantity || 1);
    const license = await createLicenseWithKey({
      key: licenseKey,
      policyId: policyFor(order.plan),
      maxMachines: quantity,
      metadata: {
        quantity,
        source: 'razorpay',
        orderId: order.id,
        plan: order.plan,
        email: order.email || null,
        publicProductId: PLANS[order.plan].product_id
      }
    });
    if (!license || !license.id) throw new ProviderError(503, 'KEYGEN_CREATE_FAILED');
    await insertOne('licence_authority', {
      key_hash: licenceKeyHash(licenseKey), authority: 'keygen', public_license_id: license.id,
      keygen_license_id: license.id, source: 'razorpay'
    }, { onConflict: 'key_hash', ignoreDuplicates: true });
    await updateWhere('fulfilments', { order_id: order.id, status: 'pending' },
      { status: 'provisioned', keygen_license_id: license.id, provisioned_at: new Date().toISOString() });
  }

  // Queue the email before marking the order fulfilled: the reconcile job only
  // revisits unfulfilled orders, so a failed insert must leave the order open.
  if (order.email) {
    await insertOne('email_outbox', { kind: 'licence_key', order_id: order.id, to_email: order.email },
      { onConflict: 'kind,order_id', ignoreDuplicates: true });
  }
  await updateWhere('orders', { id: order.id, status: 'paid' }, { status: 'fulfilled', fulfilled_at: new Date().toISOString() });
  return licenseKey;
}

// Verifies payment with Razorpay, marks the order paid, and fulfils it.
// Returns { state: 'fulfilled', licenseKey } | { state: 'unpaid' }.
export async function settleOrder(order, { paymentId } = {}) {
  if (order.status === 'created') {
    const payment = await capturedPaymentFor(order, paymentId);
    if (!payment) return { state: 'unpaid' };
    // Our checkout collects the email. Razorpay's is only a fallback, and its
    // placeholder for "no email given" (void@razorpay.com) is never a buyer.
    const fromRazorpay = typeof payment.email === 'string' && payment.email.includes('@') && !/@razorpay\.com$/i.test(payment.email.trim())
      ? normaliseEmail(payment.email).slice(0, 254) : null;
    await updateWhere('orders', { id: order.id, status: 'created' },
      { status: 'paid', razorpay_payment_id: payment.id, paid_at: new Date().toISOString(), ...(!order.email && fromRazorpay ? { email: fromRazorpay } : {}) });
    log('payment_verified', { order_id: order.id, plan: order.plan });
  }
  const current = await selectOne('orders', { id: order.id });
  if (!current || current.status === 'created') return { state: 'unpaid' };
  const licenseKey = await fulfilOrder(current);
  log('order_fulfilled', { order_id: order.id, plan: order.plan });
  // Best effort: the key is already shown on the page; the outbox retries.
  await deliverForOrder(order.id).catch(() => false);
  return { state: 'fulfilled', licenseKey };
}
