import { diagnosticRef } from '../api/_diagnostics.mjs';
import { dodo } from '../api/_dodo.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function findLicenseByRef(targetRef) {
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await dodo(`/license_keys?page_size=${PAGE_SIZE}&page_number=${page}`);
    const items = Array.isArray(response && response.items) ? response.items : [];
    for (const item of items) {
      if (diagnosticRef('dodo_license_id', item && item.id) === targetRef) {
        return { license: item, matched_on: 'license_id' };
      }
      if (diagnosticRef('dodo_license_key', item && item.key) === targetRef) {
        return { license: item, matched_on: 'license_key' };
      }
    }
    if (items.length < PAGE_SIZE) return null;
  }
  throw new Error(`Search stopped after ${MAX_PAGES * PAGE_SIZE} licence records`);
}

async function main() {
  const targetRef = String(process.argv[2] || '').trim().toLowerCase();
  if (!/^[0-9a-f]{20}$/.test(targetRef)) {
    throw new Error('Usage: npm run diagnose:license-ref -- LICENSE_REF_FROM_VERCEL');
  }

  required('DODO_API_KEY');
  required('TTDAF_LOG_CORRELATION_SECRET');

  const match = await findLicenseByRef(targetRef);
  if (!match) {
    console.log(JSON.stringify({ found: false, license_ref: targetRef }, null, 2));
    process.exitCode = 2;
    return;
  }
  const { license, matched_on: matchedOn } = match;

  const customerId = String(license.customer_id || '').trim();
  const customer = customerId
    ? await dodo('/customers/' + encodeURIComponent(customerId))
    : null;

  // This command is an explicit, local incident-response tool. Customer PII is
  // shown only here; production logs keep the HMAC reference and never the key.
  console.log(JSON.stringify({
    found: true,
    license_ref: targetRef,
    matched_on: matchedOn,
    license: {
      id: license.id || null,
      product_id: license.product_id || null,
      status: license.status || null,
      source: license.source || null,
      created_at: license.created_at || null,
      expires_at: license.expires_at || null,
      activations: {
        used: Number.isFinite(license.instances_count) ? license.instances_count : null,
        limit: Number.isFinite(license.activations_limit) ? license.activations_limit : null
      },
      payment_id: license.payment_id || null,
      subscription_id: license.subscription_id || null
    },
    customer: customer ? {
      id: customer.customer_id || customerId,
      name: customer.name || null,
      email: customer.email || null
    } : null
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    found: false,
    error: error && error.message || 'Correlation lookup failed'
  }));
  process.exitCode = 1;
});
