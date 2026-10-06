import { Agent } from 'undici';
import {
  installationRef,
  LEGACY_30_DAY_PRODUCT_ID,
  LEGACY_90_DAY_PRODUCT_ID,
  ProviderConfigurationError,
  ProviderError,
  SUPPORTER_PRODUCT_ID,
  WEEKLY_PRODUCT_ID
} from './_dodo.mjs';

// Refresh must answer inside the extension's 8 s wait, so Keygen calls fail fast
// there and the client fails open; activation (30 s client wait) gets more room.
const REQUEST_TIMEOUT_MS = 7000;
export const ACTIVATION_CALL_TIMEOUT_MS = 12000;
const API_VERSION = '1.8';
// One request per connection. Required when Keygen ran on Vercel containers
// (a pooled idle socket pinned an instance and forced ~10 s boots); harmless on
// the VPS, so kept to allow either host.
export const noKeepAlive = new Agent({ pipelining: 0 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The extension only trusts these product IDs (ACCEPTED_PRODUCT_IDS in
// src/utils/license.js). Keygen-served passes keep presenting the original
// Dodo product ID of their tier, so no extension release is needed.
export const PUBLIC_PRODUCT_IDS = new Set([
  WEEKLY_PRODUCT_ID, LEGACY_30_DAY_PRODUCT_ID, LEGACY_90_DAY_PRODUCT_ID, SUPPORTER_PRODUCT_ID
]);

export function isKeygenId(value) {
  return UUID.test(String(value || ''));
}

function keygenConfig() {
  const base = String(process.env.KEYGEN_API_URL || '').trim().replace(/\/$/, '');
  const account = String(process.env.KEYGEN_ACCOUNT_ID || '').trim();
  const token = String(process.env.KEYGEN_PRODUCT_TOKEN || '').trim();
  const productId = String(process.env.KEYGEN_PRODUCT_ID || '').trim();
  if (!base || !account || !token || !productId) throw new ProviderConfigurationError();
  return { base, account, token, productId };
}

function policyProductMap() {
  try {
    const parsed = JSON.parse(String(process.env.KEYGEN_POLICY_PRODUCTS || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function keygen(path, { method = 'GET', body, timeoutMs } = {}) {
  const config = keygenConfig();
  let response;
  try {
    response = await fetch(`${config.base}/v1/accounts/${config.account}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer ' + config.token,
        Accept: 'application/vnd.api+json',
        'Keygen-Version': API_VERSION,
        ...(body ? { 'Content-Type': 'application/vnd.api+json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: noKeepAlive,
      signal: AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }
  if (response.status === 204) return null;
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const first = json && Array.isArray(json.errors) ? json.errors[0] : null;
    throw new ProviderError(response.status, first && first.code || null);
  }
  // A success status whose body did not arrive whole (e.g. the timeout fired
  // mid-body under load) is an availability failure, never an answer: an empty
  // result would otherwise read as "licence not found" and lock the customer out.
  if (!json || typeof json !== 'object') throw new ProviderError(502, 'INVALID_RESPONSE');
  return json;
}

const VALIDATION_REASONS = {
  VALID: null,
  EXPIRED: 'licence_expired',
  SUSPENDED: 'licence_disabled',
  BANNED: 'licence_disabled',
  NOT_FOUND: 'licence_not_found',
  NO_MACHINE: 'instance_mismatch',
  NO_MACHINES: 'instance_mismatch',
  FINGERPRINT_SCOPE_MISMATCH: 'instance_mismatch',
  MACHINE_SCOPE_MISMATCH: 'instance_mismatch',
  FINGERPRINT_SCOPE_REQUIRED: 'instance_mismatch',
  TOO_MANY_MACHINES: 'instance_mismatch',
  PRODUCT_SCOPE_MISMATCH: 'product_not_accepted'
};

export function fingerprintFor(installationUuid) {
  const fingerprint = installationRef(installationUuid);
  if (!fingerprint) throw new ProviderConfigurationError();
  return fingerprint;
}

// `machineId` adds Keygen's machine scope: the machine must exist and belong to
// this licence. (Keygen checks machine and fingerprint independently, so the
// caller still confirms they are the same machine.)
export async function validateKey(licenseKey, fingerprint, { timeoutMs, machineId } = {}) {
  const { productId } = keygenConfig();
  const json = await keygen('/licenses/actions/validate-key', {
    method: 'POST',
    timeoutMs,
    body: { meta: { key: licenseKey, scope: { product: productId, ...(fingerprint ? { fingerprint } : {}), ...(machineId ? { machine: machineId } : {}) } } }
  });
  const code = String(json && json.meta && json.meta.code || '');
  const license = json && json.data || null;
  const reason = Object.prototype.hasOwnProperty.call(VALIDATION_REASONS, code)
    ? VALIDATION_REASONS[code]
    : 'provider_validation_failed';
  return { code, valid: !!(json && json.meta && json.meta.valid) && reason === null, reason, license };
}

export function licenceView(license) {
  const attributes = license && license.attributes || {};
  const metadata = attributes.metadata || {};
  const policyId = license && license.relationships && license.relationships.policy &&
    license.relationships.policy.data && license.relationships.policy.data.id || null;
  const productId = String(metadata.publicProductId || policyProductMap()[policyId] || '');
  return {
    id: license && license.id || null,
    publicLicenseId: String(metadata.publicLicenseId || (license && license.id) || ''),
    productId,
    productAccepted: PUBLIC_PRODUCT_IDS.has(productId),
    policyId,
    expiry: attributes.expiry || null,
    maxMachines: Number(attributes.maxMachines) || null
  };
}

export function machineView(machine) {
  const attributes = machine && machine.attributes || {};
  const metadata = attributes.metadata || {};
  return {
    id: machine && machine.id || null,
    publicInstanceId: String(metadata.publicInstanceId || (machine && machine.id) || ''),
    fingerprint: attributes.fingerprint || null,
    licenseId: machine && machine.relationships && machine.relationships.license &&
      machine.relationships.license.data && machine.relationships.license.data.id || null
  };
}

// Creates a licence with a key we chose, so a retried fulfilment can find it.
// Keygen reports a concurrent unique-key insert as 409 and a later duplicate
// as 422. Recover only the licence for this key, policy and fulfilment identity.
export async function createLicenseWithKey({ key, policyId, metadata, maxMachines }) {
  try {
    const json = await keygen('/licenses', {
      method: 'POST',
      timeoutMs: ACTIVATION_CALL_TIMEOUT_MS,
      body: { data: { type: 'licenses', attributes: { key, metadata, ...(maxMachines && maxMachines !== 1 ? { maxMachines } : {}) },
        relationships: { policy: { data: { type: 'policies', id: policyId } } } } }
    });
    return json && json.data || null;
  } catch (error) {
    if (!(error instanceof ProviderError && [409, 422].includes(error.status))) throw error;
    const existing = await validateKey(key, null, { timeoutMs: ACTIVATION_CALL_TIMEOUT_MS });
    const license = existing.license;
    const attributes = license && license.attributes || {};
    const existingPolicy = license && license.relationships && license.relationships.policy &&
      license.relationships.policy.data && license.relationships.policy.data.id;
    const sameIdentity = ['source', 'orderId', 'offlineSaleId', 'publicProductId'].every((field) =>
      metadata && metadata[field] != null ? (attributes.metadata || {})[field] === metadata[field] : true);
    // A late callback can find an expired or unactivated licence. Reuse it
    // without changing its expiry or machines; validation validity is separate.
    if (license && license.id && attributes.key === key && existingPolicy === policyId &&
        existing.reason !== 'product_not_accepted' && sameIdentity) return license;
    throw error;
  }
}

export async function setLicenseMaxMachines(licenseId, maxMachines, metadata) {
  const json = await keygen('/licenses/' + encodeURIComponent(licenseId), {
    method: 'PATCH', body: { data: { type: 'licenses', attributes: { maxMachines, ...(metadata ? { metadata } : {}) } } }
  });
  return json && json.data || null;
}

// Admin actions (suspend / reinstate are reversible; a suspended key fails
// validation, so its browsers lock at their next refresh, within 8 h).
export async function licenseAction(licenseId, action) {
  if (!['suspend', 'reinstate'].includes(action)) throw new Error('unknown licence action');
  const json = await keygen(`/licenses/${encodeURIComponent(licenseId)}/actions/${action}`, { method: 'POST' });
  return json && json.data || null;
}

export async function setLicenseExpiry(licenseId, expiry) {
  const json = await keygen('/licenses/' + encodeURIComponent(licenseId), {
    method: 'PATCH', body: { data: { type: 'licenses', attributes: { expiry } } }
  });
  return json && json.data || null;
}

export async function getLicense(licenseId) {
  try {
    const json = await keygen('/licenses/' + encodeURIComponent(licenseId));
    return json && json.data || null;
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return null;
    throw error;
  }
}

// All of a licence's machines (offline sales allow up to 1,000 browsers).
export async function listLicenseMachines(licenseId) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ license: licenseId, 'page[size]': '100', 'page[number]': String(page) });
    const json = await keygen('/machines?' + params);
    const batch = json && Array.isArray(json.data) ? json.data : [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Keygen filters licences by exact metadata values, e.g. { email: 'a@b.c' }.
export async function findLicensesByMetadata(metadata) {
  const params = new URLSearchParams({ 'page[size]': '50', 'page[number]': '1' });
  for (const [k, v] of Object.entries(metadata)) params.set(`metadata[${k}]`, v);
  const json = await keygen('/licenses?' + params);
  return json && Array.isArray(json.data) ? json.data : [];
}

// Validates an operator's own Keygen token; only admins pass.
export async function adminProfile(token) {
  const { base, account } = keygenConfig();
  let response;
  try {
    response = await fetch(`${base}/v1/accounts/${account}/me`, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.api+json', 'Keygen-Version': API_VERSION },
      dispatcher: noKeepAlive,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new ProviderError(response.status);
  const json = await response.json().catch(() => null);
  const data = json && json.data;
  if (!data || data.type !== 'users' || !data.attributes || data.attributes.role !== 'admin') return null;
  return { id: data.id, email: data.attributes.email };
}

// Exchanges an operator's Keygen admin email/password for a short-lived token.
export async function adminLogin(email, password) {
  const { base, account } = keygenConfig();
  let response;
  try {
    response = await fetch(`${base}/v1/accounts/${account}/tokens`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64'),
        Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': API_VERSION
      },
      body: JSON.stringify({ data: { type: 'tokens', attributes: { name: 'ttd-ops', expiry: new Date(Date.now() + 8 * 3600e3).toISOString() } } }),
      dispatcher: noKeepAlive,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503);
  }
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new ProviderError(response.status);
  const json = await response.json().catch(() => null);
  const attributes = json && json.data && json.data.attributes;
  return attributes && attributes.token ? { token: attributes.token, expiresAt: attributes.expiry } : null;
}

export async function getMachine(machineId) {
  const json = await keygen('/machines/' + encodeURIComponent(machineId));
  return json && json.data || null;
}

export async function findMachine(licenseId, fingerprint, { timeoutMs } = {}) {
  const params = new URLSearchParams({ license: licenseId, fingerprint, 'page[size]': '1', 'page[number]': '1' });
  const json = await keygen('/machines?' + params, { timeoutMs });
  const items = json && Array.isArray(json.data) ? json.data : [];
  return items.find((item) => item.attributes && item.attributes.fingerprint === fingerprint) || null;
}

export async function createMachine(licenseId, fingerprint, name, metadata) {
  const json = await keygen('/machines', {
    method: 'POST',
    timeoutMs: ACTIVATION_CALL_TIMEOUT_MS,
    body: { data: { type: 'machines', attributes: { fingerprint, name, ...(metadata ? { metadata } : {}) },
      relationships: { license: { data: { type: 'licenses', id: licenseId } } } } }
  });
  return json && json.data || null;
}

export async function deleteMachine(machineId) {
  try {
    await keygen('/machines/' + encodeURIComponent(machineId), { method: 'DELETE' });
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 404)) throw error;
  }
}

const policyCache = new Map();
async function getPolicy(policyId) {
  if (policyCache.has(policyId)) return policyCache.get(policyId);
  const json = await keygen('/policies/' + encodeURIComponent(policyId));
  const attributes = json && json.data && json.data.attributes || {};
  const policy = { duration: Number(attributes.duration) || null, basis: attributes.expirationBasis || null };
  policyCache.set(policyId, policy);
  return policy;
}

// Keygen starts a FROM_FIRST_ACTIVATION clock in a background job. A job queued
// on a container that then scales in is lost, so start the clock here as well;
// the null-expiry guard makes the two paths agree.
export async function ensureActivationExpiry(license) {
  const view = licenceView(license);
  if (view.expiry || !view.policyId) return view.expiry;
  const policy = await getPolicy(view.policyId);
  if (policy.basis !== 'FROM_FIRST_ACTIVATION' || !policy.duration) return null;
  const current = await keygen('/licenses/' + encodeURIComponent(view.id));
  const currentExpiry = current && current.data && current.data.attributes && current.data.attributes.expiry;
  if (currentExpiry) return currentExpiry;
  const expiry = new Date(Date.now() + policy.duration * 1000).toISOString();
  await keygen('/licenses/' + encodeURIComponent(view.id), {
    method: 'PATCH',
    body: { data: { type: 'licenses', attributes: { expiry } } }
  });
  return expiry;
}
