import { createHash, timingSafeEqual } from 'node:crypto';
import { ProviderConfigurationError, ProviderError } from './_dodo.mjs';

const REQUEST_TIMEOUT_MS = 10000;
const HOSTS = {
  sandbox: { api: 'https://api-preprod.phonepe.com/apis/pg-sandbox', token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token' },
  production: { api: 'https://api.phonepe.com/apis/pg', token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token' }
};

// Sandbox unless PHONEPE_MODE is exactly "production": a test key can never be
// pointed at production by accident, and the reverse needs an explicit switch.
export function phonepeConfig() {
  const clientId = String(process.env.PHONEPE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.PHONEPE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw new ProviderConfigurationError();
  const live = String(process.env.PHONEPE_MODE || '').trim().toLowerCase() === 'production';
  const clientVersion = String(process.env.PHONEPE_CLIENT_VERSION || '1').trim();
  return { clientId, clientSecret, clientVersion, live, hosts: live ? HOSTS.production : HOSTS.sandbox };
}

let cachedToken = null;

// OAuth client-credentials token, cached until shortly before it expires.
async function accessToken() {
  const { clientId, clientSecret, clientVersion, hosts, live } = phonepeConfig();
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.live === live && cachedToken.clientId === clientId && cachedToken.expiresAt - 60 > now) return cachedToken.value;
  let response;
  try {
    response = await fetch(hosts.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_version: clientVersion, client_secret: clientSecret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || !json.access_token) throw new ProviderError(response.ok ? 502 : response.status, 'PHONEPE_AUTH');
  cachedToken = { value: json.access_token, expiresAt: Number(json.expires_at) || now + 300, live, clientId };
  return cachedToken.value;
}

async function phonepe(path, { method = 'GET', body } = {}) {
  const { hosts } = phonepeConfig();
  const token = await accessToken();
  let response;
  try {
    response = await fetch(hosts.api + path, {
      method,
      headers: { Authorization: 'O-Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }
  const json = await response.json().catch(() => null);
  if (response.status === 401) cachedToken = null;
  if (!response.ok) throw new ProviderError(response.status, json && (json.code || json.errorCode) || null);
  // A cut-off body is "try again", not "unpaid".
  if (!json || typeof json !== 'object') throw new ProviderError(502, 'INVALID_RESPONSE');
  return json;
}

// PhonePe rejects a second create for the same merchantOrderId (DUPLICATE_TXN_REQUEST),
// so a re-opened checkout uses ttd_<id>_a1, _a2, ... The ledger keeps the newest;
// the earlier ones are derived, so a payment made in an older tab is still found.
export const MAX_PHONEPE_ATTEMPTS = 6;

export function phonepeAttemptIds(gatewayId) {
  const match = /^(.*?)(?:_a(\d+))?$/.exec(String(gatewayId));
  const base = match[1];
  const latest = Number(match[2] || 0);
  const ids = [];
  for (let n = latest; n >= 0; n--) ids.push(n ? `${base}_a${n}` : base);
  return ids;
}

export function nextPhonePeOrderId(gatewayId) {
  const [latest] = phonepeAttemptIds(gatewayId);
  const match = /^(.*?)(?:_a(\d+))?$/.exec(latest);
  return `${match[1]}_a${Number(match[2] || 0) + 1}`;
}

// PhonePe takes the amount in paise, as we store it.
export function createPhonePeOrder({ orderId, amountPaise, returnUrl, note }) {
  return phonepe('/checkout/v2/pay', {
    method: 'POST',
    body: {
      merchantOrderId: orderId,
      amount: Number(amountPaise),
      expireAfter: 1800,
      metaInfo: { udf1: String(note || '').slice(0, 256) },
      paymentFlow: { type: 'PG_CHECKOUT', message: note, merchantUrls: { redirectUrl: returnUrl } }
    }
  });
}

export function getPhonePeOrder(orderId) {
  return phonepe('/checkout/v2/order/' + encodeURIComponent(orderId) + '/status?details=true');
}

function safeEqual(expected, provided) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(provided || '').trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Webhook auth: the dashboard's username/password pair, sent as
// SHA256("username:password") in the Authorization header.
export function verifyPhonePeWebhook(authorization) {
  const username = String(process.env.PHONEPE_WEBHOOK_USERNAME || '');
  const password = String(process.env.PHONEPE_WEBHOOK_PASSWORD || '');
  if (!username || !password || !authorization) return false;
  const expected = createHash('sha256').update(`${username}:${password}`).digest('hex');
  return safeEqual(expected, String(authorization).replace(/^SHA256\s+/i, ''));
}

// A payment counts only when PhonePe itself reports the order COMPLETED for
// this exact amount. The browser redirect is never proof of payment.
export function phonepeOrderMatches(status, order) {
  return !!status && status.state === 'COMPLETED' && Number(status.amount) === Number(order.amount_paise);
}

// Id of the completed attempt (the bank/UPI transaction), falling back to PhonePe's order id.
export function phonepePaymentId(status) {
  const attempt = Array.isArray(status.paymentDetails) ? status.paymentDetails.find((p) => p && p.state === 'COMPLETED') : null;
  return String(attempt && attempt.transactionId || status.orderId || '');
}

const PHONEPE_METHODS = { UPI_INTENT: 'UPI', UPI_COLLECT: 'UPI', UPI_QR: 'UPI', CARD: 'Card', CREDIT_CARD: 'Card', DEBIT_CARD: 'Card', NET_BANKING: 'Netbanking', TOKEN: 'Card' };
export function phonepeMethodLabel(status) {
  const attempt = Array.isArray(status && status.paymentDetails) ? status.paymentDetails.find((p) => p && p.state === 'COMPLETED') : null;
  return PHONEPE_METHODS[attempt && attempt.paymentMode] || null;
}
