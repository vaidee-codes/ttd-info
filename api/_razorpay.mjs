import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderConfigurationError, ProviderError } from './_dodo.mjs';

const API = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 10000;

export function razorpayConfig() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret) throw new ProviderConfigurationError();
  // Never let a live key run outside production, or a test key inside it.
  const live = keyId.startsWith('rzp_live_');
  if (live !== (process.env.RAZORPAY_MODE === 'live')) throw new ProviderConfigurationError();
  return { keyId, keySecret, live };
}

export function paymentProvider() {
  return String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase() === 'razorpay' ? 'razorpay' : 'dodo';
}

async function razorpay(path, { method = 'GET', body } = {}) {
  const { keyId, keySecret } = razorpayConfig();
  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ProviderError(response.status, json && json.error && json.error.code || null);
  // A cut-off body is "try again", not "no payments".
  if (!json || typeof json !== 'object') throw new ProviderError(502, 'INVALID_RESPONSE');
  return json;
}

export function createOrder({ amountPaise, receipt, notes }) {
  return razorpay('/orders', { method: 'POST', body: { amount: amountPaise, currency: 'INR', receipt, notes, partial_payment: false } });
}

export function getPayment(paymentId) {
  return razorpay('/payments/' + encodeURIComponent(paymentId));
}

export async function listOrderPayments(orderId) {
  const json = await razorpay('/orders/' + encodeURIComponent(orderId) + '/payments');
  return Array.isArray(json && json.items) ? json.items : [];
}

export function capturePayment(paymentId, amountPaise) {
  return razorpay('/payments/' + encodeURIComponent(paymentId) + '/capture', { method: 'POST', body: { amount: amountPaise, currency: 'INR' } });
}

function safeEqualHex(expected, provided) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Checkout handler signature: HMAC-SHA256(order_id|payment_id, key_secret).
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const { keySecret } = razorpayConfig();
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

// Webhook signature: HMAC-SHA256(raw body, webhook secret).
export function verifyWebhookSignature(rawBody, signature) {
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!secret) throw new ProviderConfigurationError();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

// A payment counts only when Razorpay itself reports it captured for this exact
// order, amount and currency. The browser redirect is never proof of payment.
export function paymentMatchesOrder(payment, order) {
  return !!payment && payment.order_id === order.razorpay_order_id &&
    Number(payment.amount) === Number(order.amount_paise) && payment.currency === 'INR';
}
