import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderConfigurationError, ProviderError } from './_dodo.mjs';

const API_VERSION = '2023-08-01';
const REQUEST_TIMEOUT_MS = 10000;

// Cashfree test (sandbox) app ids start with "TEST"; production ones do not.
export function cashfreeConfig() {
  const appId = String(process.env.CASHFREE_APP_ID || '').trim();
  const secretKey = String(process.env.CASHFREE_SECRET_KEY || '').trim();
  if (!appId || !secretKey) throw new ProviderConfigurationError();
  // Never let a production key run against the sandbox, or a test key against production.
  const live = !/^TEST/i.test(appId);
  if (live !== (String(process.env.CASHFREE_MODE || '').trim().toLowerCase() === 'production')) throw new ProviderConfigurationError();
  return { appId, secretKey, live, base: live ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg' };
}

async function cashfree(path, { method = 'GET', body } = {}) {
  const { appId, secretKey, base } = cashfreeConfig();
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        'x-client-id': appId,
        'x-client-secret': secretKey,
        'x-api-version': API_VERSION,
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
  if (!response.ok) throw new ProviderError(response.status, json && (json.code || json.type) || null);
  // A cut-off body is "try again", not "no payments".
  if (!json || typeof json !== 'object') throw new ProviderError(502, 'INVALID_RESPONSE');
  return json;
}

// Cashfree takes the amount in rupees, with at most two decimals.
export function rupees(paise) {
  return Number((Number(paise) / 100).toFixed(2));
}

export function createCashfreeOrder({ orderId, amountPaise, customerId, email, phone, returnUrl, notifyUrl, note }) {
  return cashfree('/orders', {
    method: 'POST',
    body: {
      order_id: orderId,
      order_amount: rupees(amountPaise),
      order_currency: 'INR',
      order_note: note,
      customer_details: { customer_id: customerId, customer_email: email, customer_phone: phone },
      order_meta: { return_url: returnUrl, notify_url: notifyUrl, payment_methods: 'upi,cc,dc,nb,app' }
    }
  });
}

export function getCashfreeOrder(orderId) {
  return cashfree('/orders/' + encodeURIComponent(orderId));
}

export async function listCashfreePayments(orderId) {
  const json = await cashfree('/orders/' + encodeURIComponent(orderId) + '/payments');
  return Array.isArray(json) ? json : [];
}

function safeEqual(expected, provided) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Webhook signature: base64(HMAC-SHA256(timestamp + raw body, client secret)).
export function verifyCashfreeWebhook(rawBody, timestamp, signature) {
  const { secretKey } = cashfreeConfig();
  if (!timestamp || !signature) return false;
  const expected = createHmac('sha256', secretKey).update(String(timestamp) + rawBody.toString('utf8')).digest('base64');
  return safeEqual(expected, signature);
}

// A payment counts only when Cashfree itself reports it SUCCESS for this exact
// order, amount and currency. The browser redirect is never proof of payment.
export function cashfreePaymentMatchesOrder(payment, order) {
  return !!payment && payment.payment_status === 'SUCCESS' &&
    Number(payment.payment_amount) === rupees(order.amount_paise) && String(payment.payment_currency || 'INR') === 'INR';
}
