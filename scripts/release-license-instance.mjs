// Support tool: inspect a licence key's activation slots and, when a customer's
// browser consumed a slot without receiving an entitlement, release it so the
// extension can activate again.
//
// Read-only by default. Nothing is released without --confirm, because a
// release lets the key activate in a different browser next.
//
// Usage:
//   node scripts/release-license-instance.mjs <licence-key|20-hex-ref>
//   node scripts/release-license-instance.mjs <licence-key|20-hex-ref> --confirm [--instance lki_...]
import { diagnosticRef } from '../api/_diagnostics.mjs';
import { dodo, listLicenseKeyInstances, findLicenseKeyBySecret } from '../api/_dodo.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function args() {
  const positional = [];
  const flags = new Set();
  let instance = null;
  for (const value of process.argv.slice(2)) {
    if (value === '--confirm') flags.add('confirm');
    else if (value.startsWith('--instance=')) instance = value.slice('--instance='.length).trim();
    else positional.push(value);
  }
  return { target: String(positional[0] || '').trim(), confirm: flags.has('confirm'), instance };
}

async function findLicenseByRef(targetRef) {
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await dodo(`/license_keys?page_size=${PAGE_SIZE}&page_number=${page}`);
    const items = Array.isArray(response && response.items) ? response.items : [];
    for (const item of items) {
      if (diagnosticRef('dodo_license_id', item && item.id) === targetRef) return item;
      if (diagnosticRef('dodo_license_key', item && item.key) === targetRef) return item;
    }
    if (items.length < PAGE_SIZE) return null;
  }
  throw new Error(`Search stopped after ${MAX_PAGES * PAGE_SIZE} licence records`);
}

async function main() {
  const { target, confirm, instance } = args();
  required('DODO_API_KEY');
  required('TTDAF_LOG_CORRELATION_SECRET');
  if (!target) {
    throw new Error('Usage: node scripts/release-license-instance.mjs <licence-key|20-hex-ref> [--confirm] [--instance=ID]');
  }

  const isRef = /^[0-9a-f]{20}$/.test(target.toLowerCase());
  const license = isRef ? await findLicenseByRef(target.toLowerCase()) : await findLicenseKeyBySecret(target);
  if (!license) {
    console.log(JSON.stringify({ found: false, target_kind: isRef ? 'ref' : 'key' }, null, 2));
    process.exitCode = 2;
    return;
  }

  const listing = await listLicenseKeyInstances(license.id);
  const instances = (Array.isArray(listing && listing.items) ? listing.items : []).map((item) => ({
    id: item.id,
    name: item.name,
    created_at: item.created_at
  }));

  const summary = {
    found: true,
    license_ref: diagnosticRef('dodo_license_id', license.id),
    status: license.status,
    product_id: license.product_id,
    expires_at: license.expires_at || null,
    activations: {
      used: Number.isFinite(license.instances_count) ? license.instances_count : null,
      limit: Number.isFinite(license.activations_limit) ? license.activations_limit : null
    },
    instances
  };

  if (!confirm) {
    console.log(JSON.stringify({ ...summary, released: false, hint: 'Re-run with --confirm to release a slot. Add --instance=<id> to pick one.' }, null, 2));
    return;
  }

  const targets = [];
  if (instance) {
    const match = instances.find((item) => item.id === instance);
    if (!match) throw new Error(`Instance ${instance} is not on this licence`);
    targets.push(match);
  } else if (instances.length === 1) {
    targets.push(instances[0]);
  } else {
    throw new Error(`This licence has ${instances.length} instances. Re-run with --instance=<id>.`);
  }

  const released = [];
  for (const item of targets) {
    const response = await fetch(String(process.env.DODO_API_BASE || 'https://live.dodopayments.com').replace(/\/$/, '') + '/licenses/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: license.key, license_key_instance_id: item.id })
    });
    released.push({ instance_id: item.id, instance_ref: diagnosticRef('dodo_instance_id', item.id), http_status: response.status });
  }

  console.log(JSON.stringify({ ...summary, released }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ found: false, error: error && error.message || 'Slot release failed' }));
  process.exitCode = 1;
});
