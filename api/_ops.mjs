import { createHash } from 'node:crypto';
import { logProviderFailure } from './_dodo.mjs';
import { sendError } from './_http.mjs';
import { adminProfile } from './_keygen.mjs';
import { insertOne } from './_ledger.mjs';

function bearer(req) {
  const value = String(req.headers && req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

// Verified tokens, for read-only callers that opt in (reports): repeat clicks
// then cost Keygen nothing. Keyed by the token's hash; never holds the token.
const verified = new Map();

// Every operations request carries the operator's own Keygen admin token.
// Keygen validates it; only admin users pass. Returns the operator or sends 401.
export async function requireOperator(req, res, { cacheMs = 0 } = {}) {
  const token = bearer(req);
  if (!token || token.length > 256) {
    sendError(res, 401, 'not_signed_in', 'Sign in to continue.');
    return null;
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const hit = cacheMs > 0 && verified.get(tokenHash);
  if (hit && hit.until > Date.now()) return hit.operator;
  try {
    const operator = await adminProfile(token);
    if (operator && cacheMs > 0) {
      if (verified.size > 50) verified.clear();
      verified.set(tokenHash, { operator, until: Date.now() + cacheMs });
    }
    if (!operator) {
      sendError(res, 401, 'not_signed_in', 'Your session has expired or you are not an administrator. Sign in again.');
      return null;
    }
    return operator;
  } catch (error) {
    logProviderFailure('ops_auth', error);
    sendError(res, 503, 'licensing_unavailable', 'The licensing service is unavailable. Try again shortly.');
    return null;
  }
}

export function audit(actor, action, target, detail = {}) {
  return insertOne('audit_events', { actor: actor.id || String(actor), action, target: target || null, detail });
}
