import {
  activateLicenseKey,
  deactivateLicenseKey,
  findLicenseKeyBySecret,
  inspectLicenseBinding,
  instanceBelongsToInstallation,
  instanceName,
  isAcceptedProduct,
  listLicenseKeyInstances,
  logProviderFailure
} from './_dodo.mjs';
import { logActivationOutcome } from './_diagnostics.mjs';
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

// A brand-new key that was already activated seconds ago on the same device
// label is an abandoned activation from the pre-instance-marker builds: the
// provider finished after the client gave up, so the slot is spent but the
// browser never received an entitlement. Allow that one case to be reclaimed
// by the same installation, and only inside this short window.
const LEGACY_RECLAIM_WINDOW_MS = 15 * 60_000;

// Rejection reason (from inspectLicenseBinding) -> customer-facing response.
// A used slot, an uncompleted payment, and an expired key are three different
// problems; reporting all of them as "invalid key" is what sent customers back
// to the payment page instead of to support.
const REJECTIONS = {
  licence_expired: {
    status: 400,
    code: 'licence_expired',
    message: 'This pass has expired. Buy a new pass to keep autofill unlocked.'
  },
  licence_disabled: {
    status: 400,
    code: 'licence_disabled',
    message: 'This key is no longer active on the payment provider (it may have been refunded or revoked). Use the key from your latest purchase, or contact support.'
  },
  payment_not_succeeded: {
    status: 400,
    code: 'payment_not_completed',
    message: 'The payment for this key did not complete, so it cannot unlock autofill. Use the key from your successful payment (check your email), or contact support if you were charged.'
  },
  product_not_accepted: {
    status: 400,
    code: 'licence_invalid',
    message: 'This key is not for a TTD Autofill pass.'
  },
  product_mismatch: {
    status: 400,
    code: 'licence_invalid',
    message: 'This key is not for a TTD Autofill pass.'
  }
};

function rejectionFor(reason) {
  return REJECTIONS[reason] || {
    status: 400,
    code: 'licence_invalid',
    message: 'This licence is expired, disabled, unpaid, or invalid.'
  };
}

// Reasons that describe the KEY itself (expired, disabled, unpaid, wrong
// product) are worth surfacing even from a recovery attempt. Structural
// reasons (instance mismatch, validation failure) keep the generic answer, so
// a provider hiccup is never reported as a dead key.
function terminalRejection(reason) {
  return Object.prototype.hasOwnProperty.call(REJECTIONS, reason) ? REJECTIONS[reason] : null;
}

function entitlementResponse({ state, entitlement, instanceId, licenseKeyId }) {
  return {
    ok: true,
    instance_id: instanceId,
    license_key_id: licenseKeyId,
    product_id: state.productId,
    provider_status: 'active',
    activation_limit: Number(state.license && state.license.activations_limit) || null,
    provider_expires_at: state.effectiveExpiry || null,
    entitlement_token: entitlement.token,
    token_expires_at: entitlement.expires_at
  };
}

// A refused activation is not always a dead end. When the provider says the
// single slot is already used, or when the activation call itself timed out,
// this installation may simply be re-attaching to an activation it already
// paid for. Only the instance that carries this installation's own marker (or,
// for the pre-marker builds, an instance created moments ago with this exact
// device label) is eligible: no other browser's slot is ever taken.
//
// `budget` keeps the scan inside the function's time limit: the customer's key
// is minutes old on the stranding paths, so the newest pages are enough.
async function recoverActivation({ licenseKey, installationUuid, deviceLabel, budget = 'normal' }) {
  const scan = budget === 'tight'
    ? { maxPages: 2, timeoutMs: 5000 }
    : { maxPages: 5, timeoutMs: 6000 };
  const license = await findLicenseKeyBySecret(licenseKey, scan);
  if (!license || !license.id) return { recovered: false, reason: 'key_not_found' };

  const listing = await listLicenseKeyInstances(license.id, { timeoutMs: scan.timeoutMs });
  const instances = Array.isArray(listing && listing.items) ? listing.items : [];
  if (!instances.length) return { recovered: false, reason: 'no_instance', license };

  const marked = instances.filter((item) => instanceBelongsToInstallation(item, installationUuid));
  const legacyCandidate = instances.length === 1 && instances[0].name === deviceLabel &&
    Date.parse(instances[0].created_at || 0) > Date.now() - LEGACY_RECLAIM_WINDOW_MS
    ? instances[0]
    : null;
  const instance = marked[0] || legacyCandidate;
  if (!instance) return { recovered: false, reason: 'instance_in_use', license };

  return {
    recovered: true,
    license,
    licenseKeyId: license.id,
    instanceId: String(instance.id),
    reason: marked.length ? 'installation_marker' : 'recent_same_device'
  };
}

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
  if (!await enforceHashedKeyRateLimit(req, res, licenseKey)) return;

  let activation;
  let activationFailure = null;
  try {
    activation = await activateLicenseKey(licenseKey, instanceName(deviceLabel, installationUuid));
  } catch (error) {
    activationFailure = error;
  }

  if (activationFailure) {
    const status = Number(activationFailure.status) || 0;
    if (status === 403 || status === 404) {
      // Terminal: an inactive, revoked, or unknown key. A slot cannot be
      // reclaimed from here, so do not spend latency scanning for one.
      logActivationOutcome({ outcome: 'rejected', reason: `provider_${status}`, licenseKey, installationUuid });
      const rejection = status === 403
        ? {
          code: 'licence_inactive',
          message: 'This key is expired, disabled, or already used. Check your email for the key from your latest purchase, or contact support.'
        }
        : { code: 'licence_invalid', message: 'This licence cannot be activated.' };
      return sendError(res, 400, rejection.code, rejection.message);
    }
    if (status === 409 || status === 422 || activationFailure.code === 'LICENSE_KEY_LIMIT_REACHED') {
      const reclaimed = await reclaimIfOwned({ licenseKey, installationUuid, deviceLabel, reason: 'limit_reached' });
      if (reclaimed.response) return res.status(200).json(reclaimed.response);
      if (reclaimed.rejection) {
        // The slot is ours, but the key itself is unusable (expired, disabled,
        // refunded, or paid out of a failed payment). Saying "already activated
        // in another browser" here sends a paying customer to support about a
        // key problem. The reclaim_rejected outcome is already logged.
        return sendError(res, reclaimed.rejection.status, reclaimed.rejection.code, reclaimed.rejection.message);
      }
      logActivationOutcome({
        outcome: 'limit_reached',
        reason: reclaimed.reason || 'instance_in_use',
        licenseKey,
        licenseKeyId: reclaimed.licenseKeyId || null,
        installationUuid
      });
      return sendError(res, 409, 'activation_in_use',
        'This pass is already activated in another browser. If autofill is still locked here, email support with your receipt and we will move the activation for you.');
    }
    // A timeout or provider outage may still have reserved the slot, so try to
    // re-attach to our own activation before reporting a failure.
    const reclaimed = await reclaimIfOwned({ licenseKey, installationUuid, deviceLabel, reason: 'provider_unavailable', budget: 'tight' });
    if (reclaimed.response) return res.status(200).json(reclaimed.response);
    logProviderFailure('license_activate', activationFailure, { installationUuid });
    logActivationOutcome({ outcome: 'provider_unavailable', reason: reclaimed.reason || null, licenseKey, installationUuid });
    return sendError(res, 502, 'provider_unavailable', 'Licence activation is temporarily unavailable. Wait a moment and try again.');
  }

  const instanceId = String(activation && activation.id || '');
  const licenseKeyId = String(activation && activation.license_key_id || '');
  const activationProductId = String(activation && activation.product && activation.product.product_id || '');
  if (!instanceId || !licenseKeyId || !isAcceptedProduct(activationProductId)) {
    if (instanceId) await deactivateLicenseKey(licenseKey, instanceId).catch(() => {});
    logActivationOutcome({ outcome: 'rejected', reason: 'activation_shape', licenseKey, licenseKeyId, instanceId, installationUuid });
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
      // The key is unusable, so release the slot we just reserved instead of
      // leaving a paid customer locked out with a spent activation.
      await deactivateLicenseKey(licenseKey, instanceId).catch(() => {});
      const rejection = rejectionFor(state.reason);
      logActivationOutcome({
        outcome: 'rejected',
        reason: state.reason || 'binding_invalid',
        licenseKey,
        licenseKeyId,
        instanceId,
        installationUuid
      });
      return sendError(res, rejection.status, rejection.code, rejection.message);
    }
    const entitlement = issueEntitlement({
      productId: state.productId,
      licenseKeyId,
      installationUuid,
      activationInstanceId: instanceId,
      providerExpiry: state.effectiveExpiry || null
    });
    logActivationOutcome({ outcome: 'activated', reason: null, licenseKey, licenseKeyId, instanceId, installationUuid });
    return res.status(200).json(entitlementResponse({ state, entitlement, instanceId, licenseKeyId }));
  } catch (error) {
    await deactivateLicenseKey(licenseKey, instanceId).catch(() => {});
    logProviderFailure('license_activate_verify', error, { licenseKeyId, instanceId, installationUuid });
    logActivationOutcome({ outcome: 'provider_unavailable', reason: 'verify_failed', licenseKey, licenseKeyId, instanceId, installationUuid });
    return sendError(res, 502, 'provider_unavailable', 'Licence activation is temporarily unavailable. Wait a moment and try again.');
  }
}

// Shared recovery step for the refusal/timeout paths: re-attach to an
// activation this installation already owns, or explain why we cannot.
async function reclaimIfOwned({ licenseKey, installationUuid, deviceLabel, reason, budget }) {
  try {
    const recovered = await recoverActivation({ licenseKey, installationUuid, deviceLabel, budget });
    if (!recovered.recovered) {
      return { reason: recovered.reason, licenseKeyId: recovered.license ? recovered.license.id : null };
    }
    const state = await inspectLicenseBinding({
      licenseKey,
      licenseKeyId: recovered.licenseKeyId,
      instanceId: recovered.instanceId,
      expectedProductId: null
    });
    if (!state.valid) {
      logActivationOutcome({
        outcome: 'reclaim_rejected',
        reason: state.reason || recovered.reason,
        licenseKey,
        licenseKeyId: recovered.licenseKeyId,
        instanceId: recovered.instanceId,
        installationUuid,
        recovered: true
      });
      return { reason: state.reason || recovered.reason, licenseKeyId: recovered.licenseKeyId, rejection: terminalRejection(state.reason) };
    }
    const entitlement = issueEntitlement({
      productId: state.productId,
      licenseKeyId: recovered.licenseKeyId,
      installationUuid,
      activationInstanceId: recovered.instanceId,
      providerExpiry: state.effectiveExpiry || null
    });
    logActivationOutcome({
      outcome: 'reclaimed',
      reason: `${reason}:${recovered.reason}`,
      licenseKey,
      licenseKeyId: recovered.licenseKeyId,
      instanceId: recovered.instanceId,
      installationUuid,
      recovered: true
    });
    return {
      response: entitlementResponse({
        state,
        entitlement,
        instanceId: recovered.instanceId,
        licenseKeyId: recovered.licenseKeyId
      })
    };
  } catch (error) {
    logProviderFailure('license_activate_recover', error, { installationUuid });
    return { reason: 'recovery_failed' };
  }
}
