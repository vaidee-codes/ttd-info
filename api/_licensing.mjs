import { instanceName, logProviderFailure, ProviderError } from './_dodo.mjs';
import { logActivationOutcome } from './_diagnostics.mjs';
import { issueEntitlement } from './_entitlement.mjs';
import { sendError } from './_http.mjs';
import {
  ACTIVATION_CALL_TIMEOUT_MS,
  createMachine,
  getLicense,
  setLicenseMaxMachines,
  deleteMachine,
  ensureActivationExpiry,
  findMachine,
  fingerprintFor,
  getMachine,
  isKeygenId,
  licenceView,
  machineView,
  validateKey
} from './_keygen.mjs';
import { authorityByKey, authorityByPublicLicenseId, instanceAlias, ledgerConfigured, updateWhere } from './_ledger.mjs';

// Rejection reason -> customer-facing response. Shared by both providers so a
// Keygen-served pass fails with exactly the wording a Dodo pass would.
export const REJECTIONS = {
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

export function rejectionFor(reason) {
  return REJECTIONS[reason] || {
    status: 400,
    code: 'licence_invalid',
    message: 'This licence is expired, disabled, unpaid, or invalid.'
  };
}

const IN_USE_MESSAGE = 'This pass is already activated in another browser. If autofill is still locked here, email support with your receipt and we will move the activation for you.';
const ACTIVATE_UNAVAILABLE = 'Licence activation is temporarily unavailable. Wait a moment and try again.';
const TERMINAL = { ok: false, error: 'licence_invalid', provider_status: 'invalid' };

function defaultProvider() {
  return String(process.env.LICENSING_PROVIDER || '').trim().toLowerCase() === 'keygen' ? 'keygen' : 'dodo';
}

// One provider owns each licence. There is deliberately no "try the other
// provider" fallback: an authoritative Keygen denial must never be re-asked of
// Dodo, and vice versa.
export async function routeForKey(licenseKey) {
  const row = ledgerConfigured() ? await authorityByKey(licenseKey) : null;
  if (row) return { authority: row.authority, keygenLicenseId: row.keygen_license_id || null };
  return { authority: defaultProvider(), keygenLicenseId: null };
}

export async function routeForClaims(claims, instanceId) {
  const publicLicenseId = String(claims && claims.license_key_id || '');
  if (isKeygenId(publicLicenseId)) {
    return { authority: 'keygen', keygenLicenseId: publicLicenseId, keygenMachineId: isKeygenId(instanceId) ? instanceId : null, tombstoned: false };
  }
  if (!ledgerConfigured()) return { authority: 'dodo' };
  const row = await authorityByPublicLicenseId(publicLicenseId);
  if (!row || row.authority !== 'keygen') return { authority: 'dodo' };
  if (isKeygenId(instanceId)) {
    return { authority: 'keygen', keygenLicenseId: row.keygen_license_id, keygenMachineId: instanceId, tombstoned: false };
  }
  const alias = await instanceAlias(instanceId);
  const owned = alias && alias.public_license_id === publicLicenseId;
  return {
    authority: 'keygen',
    keygenLicenseId: row.keygen_license_id,
    keygenMachineId: owned ? alias.keygen_machine_id || null : null,
    tombstoned: !!(owned && alias.tombstoned_at),
    viaAlias: owned
  };
}

function entitlementBody({ view, installationUuid, licenseKeyId, instanceId }) {
  const entitlement = issueEntitlement({
    productId: view.productId,
    licenseKeyId,
    installationUuid,
    activationInstanceId: instanceId,
    providerExpiry: view.expiry
  });
  return {
    ok: true,
    instance_id: instanceId,
    license_key_id: licenseKeyId,
    product_id: view.productId,
    provider_status: 'active',
    activation_limit: view.maxMachines,
    provider_expires_at: view.expiry,
    entitlement_token: entitlement.token,
    token_expires_at: entitlement.expires_at
  };
}

// Outage access (LICENSING_OUTAGE_ACCESS, on unless set to "false"): when Keygen
// or the ledger is unreachable — e.g. Supabase paused a project — a browser that
// already holds a validly signed entitlement keeps working on short 2 h tokens,
// for at most 72 h from when its last real token ran out. Never past the pass's
// own expiry, and never for a new activation.
export const OUTAGE_GRACE_SECONDS = 72 * 3600;
const OUTAGE_TOKEN_SECONDS = 2 * 3600;

export function outageGrace(res, { claims, installationUuid, instanceId }, now = Date.now()) {
  if (String(process.env.LICENSING_OUTAGE_ACCESS || '').trim().toLowerCase() === 'false') return false;
  if (!claims || !claims.exp) return false;
  const nowSeconds = Math.floor(now / 1000);
  const since = Number(claims.grace_since) || Math.min(Number(claims.exp), nowSeconds);
  if (nowSeconds - since > OUTAGE_GRACE_SECONDS) return false;
  if (claims.provider_expiry && Date.parse(claims.provider_expiry) <= now) return false;
  let entitlement;
  try {
    entitlement = issueEntitlement({
      productId: claims.product_id, licenseKeyId: claims.license_key_id, installationUuid, activationInstanceId: instanceId,
      providerExpiry: claims.provider_expiry || null, graceSince: since, seconds: OUTAGE_TOKEN_SECONDS
    }, now);
  } catch {
    return false;
  }
  console.log(JSON.stringify({ event: 'licensing_outage_grace', hours_in_grace: Math.round((nowSeconds - since) / 3600) }));
  res.status(200).json({
    ok: true,
    instance_id: instanceId,
    license_key_id: claims.license_key_id,
    product_id: claims.product_id,
    provider_status: 'active',
    activation_limit: null,
    provider_expires_at: claims.provider_expiry || null,
    entitlement_token: entitlement.token,
    token_expires_at: entitlement.expires_at,
    outage_grace: true
  });
  return true;
}

function isAvailabilityFailure(error) {
  return !(error instanceof ProviderError) || error.status === 429 || error.status >= 500;
}

export async function keygenActivate(res, { licenseKey, installationUuid, deviceLabel }) {
  const outcome = (fields) => logActivationOutcome({ licenseKey, installationUuid, provider: 'keygen', ...fields });
  let fingerprint;
  let check;
  try {
    fingerprint = fingerprintFor(installationUuid);
    check = await validateKey(licenseKey, fingerprint, { timeoutMs: ACTIVATION_CALL_TIMEOUT_MS });
  } catch (error) {
    logProviderFailure('keygen_activate_validate', error, { installationUuid });
    outcome({ outcome: 'provider_unavailable', reason: 'validate_failed' });
    return sendError(res, 502, 'provider_unavailable', ACTIVATE_UNAVAILABLE);
  }

  if (check.reason === 'licence_not_found' || !check.license) {
    outcome({ outcome: 'rejected', reason: 'keygen_not_found' });
    return sendError(res, 400, 'licence_invalid', 'This licence cannot be activated.');
  }
  let view = licenceView(check.license);
  const keyReason = !view.productAccepted ? 'product_not_accepted'
    : ['licence_expired', 'licence_disabled', 'product_not_accepted'].includes(check.reason) ? check.reason : null;
  if (keyReason) {
    outcome({ outcome: 'rejected', reason: keyReason });
    const rejection = rejectionFor(keyReason);
    return sendError(res, rejection.status, rejection.code, rejection.message);
  }

  let machine = null;
  let created = false;
  try {
    if (check.valid) machine = await findMachine(view.id, fingerprint, { timeoutMs: ACTIVATION_CALL_TIMEOUT_MS });
    if (!machine) {
      try {
        machine = await createMachine(view.id, fingerprint, instanceName(deviceLabel, installationUuid));
        created = true;
      } catch (error) {
        if (error instanceof ProviderError && error.status === 422 && error.code === 'MACHINE_LIMIT_EXCEEDED') {
          // A full slot on a key that is itself expired or disabled: say that
          // (as the Dodo path does), not "activated in another browser".
          const keyCheck = await validateKey(licenseKey, null, { timeoutMs: ACTIVATION_CALL_TIMEOUT_MS }).catch(() => null);
          const keyLevel = keyCheck && ['licence_expired', 'licence_disabled'].includes(keyCheck.reason) ? keyCheck.reason : null;
          if (keyLevel) {
            outcome({ outcome: 'rejected', reason: keyLevel + '_slot_used' });
            const rejection = rejectionFor(keyLevel);
            return sendError(res, rejection.status, rejection.code, rejection.message);
          }
          outcome({ outcome: 'limit_reached', reason: 'instance_in_use' });
          return sendError(res, 409, 'activation_in_use', IN_USE_MESSAGE);
        }
        const retryable = (error instanceof ProviderError && error.status === 422 && error.code === 'FINGERPRINT_TAKEN') ||
          isAvailabilityFailure(error);
        if (!retryable) {
          outcome({ outcome: 'rejected', reason: 'keygen_' + String(error.code || error.status || 'error').toLowerCase() });
          return sendError(res, 400, 'licence_invalid', 'This licence cannot be activated.');
        }
        // Same installation already holds the slot (a retry, or a create that
        // timed out after Keygen committed it): re-attach instead of refusing.
        machine = await findMachine(view.id, fingerprint, { timeoutMs: ACTIVATION_CALL_TIMEOUT_MS });
        if (!machine) throw error;
      }
    }

    await ensureActivationExpiry(check.license);
    check = await validateKey(licenseKey, fingerprint, { timeoutMs: ACTIVATION_CALL_TIMEOUT_MS });
    view = licenceView(check.license);
    if (!check.valid || !view.productAccepted) {
      if (created) await deleteMachine(machine.id).catch(() => {});
      const reason = view.productAccepted ? check.reason : 'product_not_accepted';
      outcome({ outcome: 'rejected', reason: reason || 'binding_invalid' });
      const rejection = rejectionFor(reason);
      return sendError(res, rejection.status, rejection.code, rejection.message);
    }

    const mv = machineView(machine);
    outcome({ outcome: created ? 'activated' : 'reclaimed', reason: created ? null : 'installation_fingerprint' });
    return res.status(200).json(entitlementBody({
      view, installationUuid, licenseKeyId: view.publicLicenseId, instanceId: mv.publicInstanceId
    }));
  } catch (error) {
    if (created && machine) await deleteMachine(machine.id).catch(() => {});
    logProviderFailure('keygen_activate', error, { installationUuid });
    outcome({ outcome: 'provider_unavailable', reason: 'activate_failed' });
    return sendError(res, 502, 'provider_unavailable', ACTIVATE_UNAVAILABLE);
  }
}

export function isLegacyFingerprint(value) {
  return String(value || '').startsWith('legacy:');
}

// Most Dodo activations predate the installation marker, so they were imported
// with a placeholder fingerprint. The first refresh from that browser (a valid,
// signed entitlement bound to that exact Dodo instance) re-binds the slot to
// the browser's real fingerprint. Keygen cannot change a fingerprint in place,
// so: lift the limit by one, create the real machine, repoint the alias, remove
// the placeholder, then restore the limit. A retry after any step converges.
// The limit to restore is the licence's recorded base (metadata.baseMaxMachines,
// written by the import and by /ops), never the current value: after an
// interrupted bridge the current value is already raised, and re-reading it
// would make the extra browser permanent.
export function bridgeBaseLimit(license) {
  const attributes = license && license.attributes || {};
  const base = Number(attributes.metadata && attributes.metadata.baseMaxMachines);
  return Number.isInteger(base) && base >= 1 ? base : (Number(attributes.maxMachines) || 1);
}

async function bridgeLegacyMachine({ legacy, licenseId, fingerprint, instanceId }) {
  const license = await getLicense(licenseId);
  const limit = bridgeBaseLimit(license);
  await setLicenseMaxMachines(licenseId, limit + 1);
  let machine;
  try {
    machine = await createMachine(licenseId, fingerprint, String(legacy.attributes && legacy.attributes.name || 'Migrated browser'),
      { publicInstanceId: instanceId, bridgedFrom: legacy.id });
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 422 && error.code === 'FINGERPRINT_TAKEN')) {
      await setLicenseMaxMachines(licenseId, limit).catch(() => {});
      throw error;
    }
    machine = await findMachine(licenseId, fingerprint, { timeoutMs: ACTIVATION_CALL_TIMEOUT_MS });
    if (!machine) throw error;
  }
  try {
    await updateWhere('instance_alias', { public_instance_id: instanceId }, { keygen_machine_id: machine.id });
  } catch (error) {
    // Alias not repointed: the next refresh retries the whole bridge, which
    // finds this machine (FINGERPRINT_TAKEN). Put the limit back meanwhile.
    await setLicenseMaxMachines(licenseId, limit).catch(() => {});
    throw error;
  }
  try {
    await deleteMachine(legacy.id);
    await setLicenseMaxMachines(licenseId, limit);
  } catch {
    console.error(JSON.stringify({ event: 'legacy_bridge_incomplete', note: 'placeholder machine or raised limit left behind; reset activations in /ops' }));
  }
  console.log(JSON.stringify({ event: 'legacy_bridge', ok: true }));
  return machine;
}

// A machine's licence, fingerprint and public instance id never change once it
// exists (Keygen cannot edit a fingerprint; ids are never reused), so they are
// remembered per server instance. Whether the machine still exists is checked
// by Keygen on every refresh (machine scope), never cached.
const MACHINE_FACTS_MAX = 20000;
const machineFacts = new Map();
async function factsFor(machineId) {
  if (machineFacts.has(machineId)) return machineFacts.get(machineId);
  let machine;
  try {
    machine = await getMachine(machineId);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return null;
    throw error;
  }
  const mv = machineView(machine);
  const facts = { licenseId: mv.licenseId, fingerprint: mv.fingerprint, publicInstanceId: mv.publicInstanceId };
  if (machineFacts.size >= MACHINE_FACTS_MAX) machineFacts.delete(machineFacts.keys().next().value);
  machineFacts.set(machineId, facts);
  return facts;
}
export function forgetMachineFactsForTests() { machineFacts.clear(); }

// A terminal answer clears the customer's licence in the extension, so every
// one is logged with the check that decided it (no keys, ids or emails).
function terminal(check, extra = {}) {
  console.log(JSON.stringify({ event: 'refresh_terminal', check, ...extra }));
  return { terminal: true, ...(extra.reason ? { reason: extra.reason } : {}) };
}

// Resolves the Keygen licence + machine behind a signed entitlement and checks
// every binding. Returns { terminal: true } for any definitive "not yours /
// gone" state so callers can stop the client's refresh loop.
async function inspectBinding({ licenseKey, installationUuid, instanceId, claims, route }) {
  if (route.tombstoned || !route.keygenLicenseId || !route.keygenMachineId) return terminal('route', { tombstoned: !!route.tombstoned });
  // Keygen-native activation: one Keygen call per refresh (validation scoped to
  // the machine) plus the remembered machine facts — the same checks as the
  // general path below. Migrated (alias) activations take the general path,
  // because the legacy bridge needs the live machine record.
  if (!route.viaAlias && installationUuid) {
    const fingerprint = fingerprintFor(installationUuid);
    const check = await validateKey(licenseKey, fingerprint, { machineId: route.keygenMachineId });
    const view = licenceView(check.license);
    if (!check.license || view.id !== route.keygenLicenseId || view.publicLicenseId !== String(claims.license_key_id || '')) {
      return terminal('licence_identity', { code: check.code || null, has_licence: !!check.license });
    }
    if (!check.valid || !view.productAccepted) return terminal('licence_validity', { code: check.code || null, reason: check.reason });
    const facts = await factsFor(route.keygenMachineId);
    if (!facts || facts.licenseId !== route.keygenLicenseId || facts.fingerprint !== fingerprint || facts.publicInstanceId !== instanceId) {
      return terminal('machine_binding', { found: !!facts });
    }
    return { terminal: false, view };
  }
  let machine;
  try {
    machine = await getMachine(route.keygenMachineId);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return { terminal: true };
    throw error;
  }
  let mv = machineView(machine);
  const fingerprint = installationUuid ? fingerprintFor(installationUuid) : mv.fingerprint;
  if (route.viaAlias && installationUuid && isLegacyFingerprint(mv.fingerprint) &&
      mv.publicInstanceId === instanceId && mv.licenseId === route.keygenLicenseId) {
    // Only re-bind a usable licence: an expired or disabled one is terminal anyway.
    const keyCheck = await validateKey(licenseKey);
    if (!keyCheck.license || keyCheck.license.id !== route.keygenLicenseId) return { terminal: true };
    if (['licence_expired', 'licence_disabled'].includes(keyCheck.reason)) return { terminal: true, reason: keyCheck.reason };
    mv = machineView(await bridgeLegacyMachine({ legacy: machine, licenseId: route.keygenLicenseId, fingerprint, instanceId }));
  }
  if (mv.licenseId !== route.keygenLicenseId || mv.fingerprint !== fingerprint || mv.publicInstanceId !== instanceId) {
    return { terminal: true };
  }
  const check = await validateKey(licenseKey, fingerprint);
  const view = licenceView(check.license);
  if (!check.license || view.id !== route.keygenLicenseId || view.publicLicenseId !== String(claims.license_key_id || '')) {
    return { terminal: true };
  }
  if (!check.valid || !view.productAccepted) return { terminal: true, reason: check.reason };
  return { terminal: false, view };
}

export async function keygenRefresh(res, { licenseKey, installationUuid, instanceId, claims, route }) {
  try {
    const state = await inspectBinding({ licenseKey, installationUuid, instanceId, claims, route });
    if (state.terminal) return res.status(401).json(TERMINAL);
    return res.status(200).json(entitlementBody({
      view: state.view, installationUuid,
      licenseKeyId: claims.license_key_id, instanceId
    }));
  } catch (error) {
    logProviderFailure('keygen_refresh', error, { installationUuid });
    if (isAvailabilityFailure(error) && outageGrace(res, { claims, installationUuid, instanceId })) return;
    return sendError(res, 502, 'provider_unavailable', 'Licence refresh is temporarily unavailable.');
  }
}

export async function keygenValidate(res, { licenseKey, instanceId, claims, route }) {
  try {
    const state = await inspectBinding({
      licenseKey, installationUuid: claims.installation_uuid, instanceId, claims, route
    });
    return res.status(200).json({ ok: true, valid: !state.terminal });
  } catch (error) {
    logProviderFailure('keygen_validate', error, { installationUuid: claims && claims.installation_uuid });
    return sendError(res, 502, 'provider_unavailable', 'Licence validation is temporarily unavailable.');
  }
}

export async function keygenDeactivate(res, { licenseKey, claims, route }) {
  try {
    if (route.tombstoned || !route.keygenMachineId) return res.status(200).json({ ok: true });
    const check = await validateKey(licenseKey);
    if (!check.license || check.license.id !== route.keygenLicenseId) {
      return sendError(res, 401, 'invalid_entitlement', 'Entitlement is invalid.');
    }
    let machine;
    try {
      machine = await getMachine(route.keygenMachineId);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return res.status(200).json({ ok: true });
      throw error;
    }
    if (machineView(machine).licenseId !== route.keygenLicenseId) {
      return sendError(res, 401, 'invalid_entitlement', 'Entitlement is invalid.');
    }
    await deleteMachine(route.keygenMachineId);
    return res.status(200).json({ ok: true });
  } catch (error) {
    logProviderFailure('keygen_deactivate', error, { installationUuid: claims && claims.installation_uuid });
    return sendError(res, 502, 'provider_unavailable', 'Licence deactivation is temporarily unavailable.');
  }
}
