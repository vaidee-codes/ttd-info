import { logProviderFailure } from '../_dodo.mjs';
import { resendLicenceEmail } from '../_email.mjs';
import { beginRequest, boundedString, handleRequestError, readJsonBody, sendError } from '../_http.mjs';
import { getLicense, isKeygenId, licenseAction, setLicenseExpiry } from '../_keygen.mjs';
import { audit, requireOperator } from '../_ops.mjs';

const ACTIONS = new Set(['suspend', 'reinstate', 'set_expiry', 'resend_email']);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

// POST /api/ops/licence-action { license_id, action, reason, expiry?, to? }
//   suspend      — the key stops working; its browsers lock within 8 h (reversible)
//   reinstate    — undo a suspension
//   set_expiry   — change when the pass ends (ISO date/time)
//   resend_email — email the key (and invoice, if any) again, optionally to another address
export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  const operator = await requireOperator(req, res);
  if (!operator) return;
  let licenseId;
  let action;
  let reason;
  let expiry = null;
  let to = null;
  try {
    const body = readJsonBody(req);
    licenseId = boundedString(body.license_id, { field: 'license_id', max: 36 });
    action = boundedString(body.action, { field: 'action', max: 20 });
    reason = boundedString(body.reason, { field: 'reason', max: 300 });
    if (!isKeygenId(licenseId) || !ACTIONS.has(action)) return sendError(res, 400, 'invalid_request', 'Invalid licence or action.');
    if (action === 'set_expiry') {
      const raw = boundedString(body.expiry, { field: 'expiry', max: 40 });
      const at = Date.parse(raw);
      if (!Number.isFinite(at)) return sendError(res, 400, 'invalid_request', 'Enter a valid date, e.g. 2026-12-31.');
      expiry = new Date(at).toISOString();
    }
    if (action === 'resend_email' && body.to) {
      to = boundedString(body.to, { field: 'to', max: 254, pattern: EMAIL });
    }
  } catch (error) {
    return handleRequestError(res, error);
  }

  try {
    const license = await getLicense(licenseId);
    if (!license) return sendError(res, 404, 'not_found', 'Licence not found.');
    const before = { status: license.attributes && license.attributes.status, expiry: license.attributes && license.attributes.expiry };
    if (action === 'suspend' || action === 'reinstate') {
      try {
        await licenseAction(licenseId, action);
      } catch (error) {
        // Already in the requested state: treat as done.
        if (!(error && error.status === 422)) throw error;
      }
      await audit(operator, action === 'suspend' ? 'licence_suspended' : 'licence_reinstated', licenseId, { reason, before });
      return res.status(200).json({ ok: true, status: action === 'suspend' ? 'SUSPENDED' : 'ACTIVE' });
    }
    if (action === 'set_expiry') {
      await setLicenseExpiry(licenseId, expiry);
      await audit(operator, 'licence_expiry_changed', licenseId, { reason, from: before.expiry || null, to: expiry });
      return res.status(200).json({ ok: true, expiry, previous: before.expiry || null });
    }
    const result = await resendLicenceEmail(license, { to });
    await audit(operator, 'licence_email_resent', licenseId, { reason, sent: !!result.ok, provider: result.provider || null, error: result.ok ? null : result.error });
    if (!result.ok) {
      return sendError(res, result.error === 'no_email' ? 400 : 503, result.error === 'no_email' ? 'no_email' : 'email_failed',
        result.error === 'no_email' ? 'This licence has no buyer email. Enter an address to send it to.' : 'The email could not be sent right now. Try again shortly.');
    }
    return res.status(200).json({ ok: true, to: result.to, provider: result.provider || null });
  } catch (error) {
    logProviderFailure('ops_licence_action', error);
    return sendError(res, 503, 'licensing_unavailable', 'The licensing service is unavailable. Try again shortly.');
  }
}
