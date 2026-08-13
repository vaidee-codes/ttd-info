import { inspectLicenseBinding, logProviderFailure } from './_dodo.mjs';
import { isInstallationUuid, issueEntitlement, verifyEntitlement } from './_entitlement.mjs';
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
  let installationUuid;
  let instanceId;
  let token;
  try {
    const body = readJsonBody(req);
    licenseKey = boundedString(body.license_key, { field: 'license_key', max: MAX_LICENSE_KEY_LENGTH });
    installationUuid = boundedString(body.installation_uuid, { field: 'installation_uuid', max: 36 }).toLowerCase();
    instanceId = boundedString(body.instance_id, { field: 'instance_id', max: MAX_INSTANCE_ID_LENGTH });
    token = boundedString(body.entitlement_token, { field: 'entitlement_token', max: MAX_TOKEN_LENGTH });
    if (!isInstallationUuid(installationUuid)) return sendError(res, 400, 'invalid_request', 'installation_uuid is invalid.');
  } catch (error) {
    return handleRequestError(res, error);
  }
  if (!await enforceHashedKeyRateLimit(res, licenseKey)) return;

  let claims;
  try {
    claims = verifyEntitlement(token, { allowExpired: true });
  } catch {
    return sendError(res, 401, 'invalid_entitlement', 'Entitlement is invalid.');
  }
  if (claims.installation_uuid !== installationUuid || claims.activation_instance_id !== instanceId) {
    return sendError(res, 401, 'invalid_entitlement', 'Entitlement binding is invalid.');
  }

  try {
    const state = await inspectLicenseBinding({
      licenseKey,
      licenseKeyId: String(claims.license_key_id || ''),
      instanceId,
      expectedProductId: String(claims.product_id || '')
    });
    if (!state.valid) {
      return res.status(401).json({ ok: false, error: 'licence_invalid', provider_status: 'invalid' });
    }
    const entitlement = issueEntitlement({
      productId: state.productId,
      licenseKeyId: claims.license_key_id,
      installationUuid,
      activationInstanceId: instanceId,
      providerExpiry: state.effectiveExpiry || null
    });
    return res.status(200).json({
      ok: true,
      instance_id: instanceId,
      license_key_id: claims.license_key_id,
      product_id: state.productId,
      provider_status: 'active',
      provider_expires_at: state.effectiveExpiry || null,
      entitlement_token: entitlement.token,
      token_expires_at: entitlement.expires_at
    });
  } catch (error) {
    logProviderFailure('license_refresh', error);
    return sendError(res, 502, 'provider_unavailable', 'Licence refresh is temporarily unavailable.');
  }
}
