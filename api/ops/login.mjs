import { logProviderFailure } from '../_dodo.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { adminLogin, adminProfile } from '../_keygen.mjs';
import { audit } from '../_ops.mjs';
import { enforceHashedKeyRateLimit } from '../_rate-limit.mjs';

// POST /api/ops/login { email, password } → { token, expires_at } for Keygen admins only.
// The password is passed straight to Keygen and never stored or logged.
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  let email;
  let password;
  try {
    const body = readJsonBody(req);
    email = boundedString(body.email, { field: 'email', max: 254 }).toLowerCase();
    password = boundedString(body.password, { field: 'password', max: 200 });
  } catch (error) {
    return handleRequestError(res, error);
  }
  if (!await enforceHashedKeyRateLimit(req, res, 'ops-login:' + email)) return;

  try {
    const session = await adminLogin(email, password);
    const operator = session && await adminProfile(session.token);
    if (!operator) return sendError(res, 401, 'invalid_login', 'Email or password is incorrect, or this account is not an administrator.');
    await audit(operator, 'ops_login', operator.id).catch(() => {});
    return res.status(200).json({ ok: true, token: session.token, expires_at: session.expiresAt, operator: { email: operator.email } });
  } catch (error) {
    logProviderFailure('ops_login', error);
    return sendError(res, 503, 'licensing_unavailable', 'The licensing service is unavailable. Try again shortly.');
  }
}
