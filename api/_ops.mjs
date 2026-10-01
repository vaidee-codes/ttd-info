import { logProviderFailure } from './_dodo.mjs';
import { sendError } from './_http.mjs';
import { adminProfile } from './_keygen.mjs';
import { insertOne } from './_ledger.mjs';

function bearer(req) {
  const value = String(req.headers && req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

// Every operations request carries the operator's own Keygen admin token.
// Keygen validates it; only admin users pass. Returns the operator or sends 401.
export async function requireOperator(req, res) {
  const token = bearer(req);
  if (!token || token.length > 256) {
    sendError(res, 401, 'not_signed_in', 'Sign in to continue.');
    return null;
  }
  try {
    const operator = await adminProfile(token);
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
