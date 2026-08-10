const CANONICAL_ORIGIN = 'https://ttd-info.vercel.app';
const EXTENSION_ORIGIN = 'chrome-extension://piiegkjdfbbakjmjdckgdjbbohfjfolg';

export const MAX_BODY_BYTES = 4096;
export const MAX_LICENSE_KEY_LENGTH = 128;
export const MAX_INSTANCE_ID_LENGTH = 96;
export const MAX_TOKEN_LENGTH = 4096;
export const MAX_NAME_LENGTH = 64;

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function header(req, name) {
  const value = req && req.headers && req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function previewOrigins() {
  if (process.env.VERCEL_ENV !== 'preview') return [];
  const configured = String(process.env.PASS_PREVIEW_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => {
      if (!value || value.includes('*')) return false;
      try {
        const parsed = new URL(value);
        return parsed.origin === value && (parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      } catch {
        return false;
      }
    });
  // VERCEL_URL and VERCEL_BRANCH_URL are trusted deployment metadata, not the
  // caller-controlled Host header. Each contributes one exact Preview origin.
  for (const hostname of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (!hostname) continue;
    try {
      const origin = new URL('https://' + hostname).origin;
      if (origin !== 'https://') configured.push(origin);
    } catch { /* ignore malformed platform metadata */ }
  }
  return configured;
}

export function allowedOrigins() {
  return new Set([CANONICAL_ORIGIN, EXTENSION_ORIGIN, ...previewOrigins()]);
}

export function applyResponseHeaders(req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Max-Age', '600');

  const origin = String(header(req, 'origin') || '');
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

export function beginRequest(req, res, methods) {
  applyResponseHeaders(req, res);
  const origin = String(header(req, 'origin') || '');
  if (origin && !allowedOrigins().has(origin)) {
    sendError(res, 403, 'origin_not_allowed', 'Origin is not allowed.');
    return false;
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return false;
  }
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    sendError(res, 405, 'method_not_allowed', 'Method is not allowed.');
    return false;
  }
  return true;
}

export function readJsonBody(req) {
  const declared = Number(header(req, 'content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RequestError(413, 'body_too_large', 'Request body is too large.');
  }

  let raw;
  if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else if (typeof req.body === 'string') raw = req.body;
  else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) raw = JSON.stringify(req.body);
  else if (req.body == null || req.body === '') raw = '{}';
  else throw new RequestError(400, 'invalid_json', 'A JSON object is required.');

  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new RequestError(413, 'body_too_large', 'Request body is too large.');
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch {
    throw new RequestError(400, 'invalid_json', 'A valid JSON object is required.');
  }
}

export function boundedString(value, { field, max, required = true, pattern } = {}) {
  const clean = String(value || '').trim();
  if (required && !clean) throw new RequestError(400, 'invalid_request', `${field} is required.`);
  if (clean.length > max || (clean && pattern && !pattern.test(clean))) {
    throw new RequestError(400, 'invalid_request', `${field} is invalid.`);
  }
  return clean;
}

export function sendError(res, status, code, message) {
  return res.status(status).json({ ok: false, error: code, message });
}

export function handleRequestError(res, error) {
  if (error instanceof RequestError) return sendError(res, error.status, error.code, error.message);
  return sendError(res, 500, 'internal_error', 'The request could not be completed.');
}

export function featureEnabled(name) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true';
}

export { CANONICAL_ORIGIN, EXTENSION_ORIGIN };
