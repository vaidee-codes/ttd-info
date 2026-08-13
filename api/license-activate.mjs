import {
  activateLicenseKey,
  deactivateLicenseKey,
  inspectLicenseBinding,
  isAcceptedProduct,
  logProviderFailure
} from './_dodo.mjs';
import { isInstallationUuid, issueEntitlement } from './_entitlement.mjs';
import {
  beginRequest,
  boundedString,
  handleRequestError,
  MAX_LICENSE_KEY_LENGTH,
  MAX_NAME_LENGTH,
  readJsonBody,
  sendError
} from './_http.mjs';
import { enforceHashedKeyRateLimit } from './_rate-limit.mjs';

export default async function handler(req, res) {
  if (!beginRequest(req, res, ['POST'])) return;
  let body;
  let licenseKey;
  let installationUuid;
  let deviceLabel;
  try {
    body = readJsonBody(req);
    licenseKey = boundedString(body.license_key, { field: 'license_key', max: MAX_LICENSE_KEY_LENGTH });
    installationUuid = boundedString(body.installation_uuid, { field: 'installation_uuid', max: 36 }).toLowerCase();
    if (!isInstallationUuid(installationUuid)) return sendError(res, 400, 'invalid_request', 'installation_uuid is invalid.');
    deviceLabel = boundedString(body.device_label || 'TTD Autofill - Chrome', {
      field: 'device_label',
      max: MAX_NAME_LENGTH,
      pattern: /^[^\u0000-\u001f\u007f]+$/
    });
  } catch (error) {
    return handleRequestError(res, error);
  }
  if (!await enforceHashedKeyRateLimit(res, licenseKey)) return;

  let activation;
  try {
    activation = await activateLicenseKey(licenseKey, deviceLabel);
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      return sendError(res, 400, 'licence_invalid', 'This licence cannot be activated.');
    }
    if (error.status === 409 || error.status === 422 || error.code === 'LICENSE_KEY_LIMIT_REACHED') {
      return sendError(res, 409, 'activation_limit_reached', 'This licence is already activated.');
    }
    logProviderFailure('license_activate', error);
    return sendError(res, 502, 'provider_unavailable', 'Licence activation is temporarily unavailable.');
  }

  const instanceId = String(activation && activation.id || '');
  const licenseKeyId = String(activation && activation.license_key_id || '');
  const activationProductId = String(activation && activation.product && activation.product.product_id || '');
  if (!instanceId || !licenseKeyId || !isAcceptedProduct(activationProductId)) {
    if (instanceId) await deactivateLicenseKey(licenseKey, instanceId).catch(() => {});
    return sendError(res, 400, 'licence_invalid', 'This licence is not valid for TTD Autofill.');
  }

  try {
    const state = await inspectLicenseBinding({
      licenseKey,
      licenseKeyId,
      instanceId,
      expectedProductId: activationProductId
    });
    if (!state.valid) {
      await deactivateLicenseKey(licenseKey, instanceId).catch(() => {});
      return sendError(res, 400, 'licence_invalid', 'This licence is expired, disabled, unpaid, or invalid.');
    }
    const entitlement = issueEntitlement({
      productId: state.productId,
      licenseKeyId,
      installationUuid,
      activationInstanceId: instanceId,
      providerExpiry: state.effectiveExpiry || null
    });
    return res.status(200).json({
      ok: true,
      instance_id: instanceId,
      license_key_id: licenseKeyId,
      product_id: state.productId,
      provider_status: 'active',
      provider_expires_at: state.effectiveExpiry || null,
      entitlement_token: entitlement.token,
      token_expires_at: entitlement.expires_at
    });
  } catch (error) {
    await deactivateLicenseKey(licenseKey, instanceId).catch(() => {});
    logProviderFailure('license_activate_verify', error);
    return sendError(res, 502, 'provider_unavailable', 'Licence activation is temporarily unavailable.');
  }
}
