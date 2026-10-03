import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ProviderError } from './_dodo.mjs';

const REQUEST_TIMEOUT_MS = 5000;

function ledgerConfig() {
  const url = String(process.env.TTD_LEDGER_URL || '').trim().replace(/\/$/, '');
  const key = String(process.env.TTD_LEDGER_SECRET_KEY || '').trim();
  return url && key ? { url, key } : null;
}

export function ledgerConfigured() {
  return !!ledgerConfig();
}

export function licenceKeyHash(licenseKey) {
  return createHash('sha256').update(String(licenseKey || ''), 'utf8').digest('hex');
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

// Supabase REST (PostgREST). Any transport or server failure is an availability
// failure, never "not found": callers must not guess on a ledger outage.
async function rest(method, table, { query = {}, body, prefer } = {}) {
  const config = ledgerConfig();
  if (!config) throw new ProviderError(503, 'LEDGER_NOT_CONFIGURED');
  const params = new URLSearchParams(query);
  let response;
  try {
    response = await fetch(`${config.url}/rest/v1/${table}${params.size ? '?' + params : ''}`, {
      method,
      headers: {
        apikey: config.key,
        Authorization: 'Bearer ' + config.key,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503, 'LEDGER_UNAVAILABLE');
  }
  if (!response.ok) throw new ProviderError(response.status >= 500 ? 503 : response.status, 'LEDGER_ERROR');
  if (response.status === 204) return [];
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw new ProviderError(503, 'LEDGER_ERROR');
  return rows;
}

const eq = (filters) => Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v === null ? 'is.null' : 'eq.' + v]));

export async function selectOne(table, filters, columns = '*') {
  if (!ledgerConfigured()) return null;
  const rows = await rest('GET', table, { query: { select: columns, limit: '1', ...eq(filters) } });
  return rows[0] || null;
}

export function selectMany(table, query) {
  return rest('GET', table, { query });
}

export async function insertOne(table, row, { onConflict, ignoreDuplicates = false } = {}) {
  const rows = await rest('POST', table, {
    query: onConflict ? { on_conflict: onConflict } : {},
    body: row,
    prefer: ['return=representation', ignoreDuplicates ? 'resolution=ignore-duplicates' : ''].filter(Boolean).join(',')
  });
  return rows[0] || null;
}

// Compare-and-set: only rows still matching `filters` are changed.
export async function updateWhere(table, filters, patch) {
  return rest('PATCH', table, { query: eq(filters), body: { ...patch, ...(table === 'orders' ? { updated_at: new Date().toISOString() } : {}) }, prefer: 'return=representation' });
}

// PostgREST RPC: POST /rest/v1/rpc/<fn> with named arguments.
export async function rpc(fn, args) {
  const config = ledgerConfig();
  if (!config) throw new ProviderError(503, 'LEDGER_NOT_CONFIGURED');
  let response;
  try {
    response = await fetch(`${config.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: config.key, Authorization: 'Bearer ' + config.key, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new ProviderError(503, 'LEDGER_UNAVAILABLE');
  }
  if (!response.ok) throw new ProviderError(response.status >= 500 ? 503 : response.status, 'LEDGER_ERROR');
  return response.json();
}

const AUTHORITY_COLUMNS = 'authority,public_license_id,keygen_license_id';

export function authorityByKey(licenseKey) {
  return selectOne('licence_authority', { key_hash: licenceKeyHash(licenseKey) }, AUTHORITY_COLUMNS);
}

export function authorityByPublicLicenseId(publicLicenseId) {
  return selectOne('licence_authority', { public_license_id: publicLicenseId }, AUTHORITY_COLUMNS);
}

export function instanceAlias(publicInstanceId) {
  return selectOne('instance_alias', { public_instance_id: publicInstanceId }, 'public_license_id,keygen_machine_id,tombstoned_at');
}

// Licence keys waiting to be provisioned are kept encrypted (AES-256-GCM).
function secretKey() {
  const raw = String(process.env.LEDGER_ENCRYPTION_KEY || '').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new ProviderError(503, 'LEDGER_ENCRYPTION_KEY_INVALID');
  return key;
}

export function sealSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function openSecret(sealed) {
  const [version, iv, tag, data] = String(sealed || '').split('.');
  if (version !== 'v1') throw new ProviderError(503, 'LEDGER_SEAL_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
