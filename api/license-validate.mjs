import { inspectLicenseBinding, logProviderFailure } from './_dodo.mjs';
import { verifyEntitlement } from './_entitlement.mjs';
import {
  beginRequest,
  boundedString,
  handleRequestError,
  MAX_INSTANCE_ID_LENGTH,
  MAX_LICENSE_KEY_LENGTH,
  MAX_TOKEN_LENGTH,
  readJsonBody,
  sendError
} from './_http.mjs';
import { enforceHashedKeyRateLimit } from './_rate-limit.mjs';

export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  let licenseKey;
  let instanceId;
  let token;
  try {
    const body = readJsonBody(req);
    licenseKey = boundedString(body.license_key, { field: 'license_key', max: MAX_LICENSE_KEY_LENGTH });
    instanceId = boundedString(body.instance_id, { field: 'instance_id', max: MAX_INSTANCE_ID_LENGTH });
    token = boundedString(body.entitlement_token, { field: 'entitlement_token', max: MAX_TOKEN_LENGTH });
  } catch (error) {
    return handleRequestError(res, error);
  }
  if (!await enforceHashedKeyRateLimit(res, licenseKey)) return;

  let claims;
  try {
    claims = verifyEntitlement(token, { allowExpired: true });
    if (claims.activation_instance_id !== instanceId) throw new Error('binding mismatch');
  } catch {
    return sendError(res, 401, 'invalid_entitlement', 'Entitlement is invalid.');
  }

  try {
    const state = await inspectLicenseBinding({
      licenseKey,
      licenseKeyId: String(claims.license_key_id || ''),
      instanceId,
      expectedProductId: String(claims.product_id || '')
    });
    return res.status(200).json({ ok: true, valid: state.valid === true });
  } catch (error) {
    logProviderFailure('license_validate', error);
    return sendError(res, 502, 'provider_unavailable', 'Licence validation is temporarily unavailable.');
  }
}
