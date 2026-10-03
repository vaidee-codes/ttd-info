#!/usr/bin/env node
// Idempotently provisions the production Keygen product, policies and a server
// product token. Reads/appends ~/.ttd-keygen-prod.env; prints IDs only, never secrets.
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const FILE = process.argv[2] || homedir() + '/.ttd-keygen-prod.env';
const env = Object.fromEntries(readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `https://${env.KEYGEN_HOST}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const DAY = 86400;
const PUBLIC = { '7d': 'pdt_0Nk4Gw67usedtjPoO6hX2', '30d': 'pdt_0NkvjEpCQNkDuaCT65cFV', '90d': 'pdt_0NkvjEr1l8rhSF6Ibxlj3' };
const POLICIES = ['7d', '30d', '90d'].flatMap((tier) => [
  { name: `pass-${tier}`, days: parseInt(tier, 10), basis: 'FROM_CREATION', publicProductId: PUBLIC[tier] },
  { name: `grant-${tier}`, days: parseInt(tier, 10), basis: 'FROM_FIRST_ACTIVATION', publicProductId: PUBLIC[tier] }
]);

async function kg(method, path, body, auth) {
  const r = await fetch(API + path, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8', Authorization: auth } });
  const json = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${json && json.errors && json.errors[0] && json.errors[0].code}`);
  return json;
}

const basic = 'Basic ' + Buffer.from(`${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const session = await kg('POST', '/tokens', { data: { type: 'tokens', attributes: { name: 'provision', expiry: new Date(Date.now() + 1800e3).toISOString() } } }, basic);
const admin = 'Bearer ' + session.data.attributes.token;
try {
  const products = (await kg('GET', '/products?page[size]=100&page[number]=1', null, admin)).data;
  let product = products.find((p) => p.attributes.name === 'TTD Autofill');
  if (!product) product = (await kg('POST', '/products', { data: { type: 'products', attributes: { name: 'TTD Autofill', distributionStrategy: 'CLOSED' } } }, admin)).data;
  console.log('product', product.id);

  const existing = (await kg('GET', `/policies?product=${product.id}&page[size]=100&page[number]=1`, null, admin)).data;
  const map = {};
  for (const spec of POLICIES) {
    let policy = existing.find((p) => p.attributes.name === spec.name);
    if (!policy) {
      policy = (await kg('POST', '/policies', { data: { type: 'policies', attributes: {
        name: spec.name, duration: spec.days * DAY, maxMachines: 1, floating: true, strict: false,
        expirationBasis: spec.basis, expirationStrategy: 'RESTRICT_ACCESS', machineUniquenessStrategy: 'UNIQUE_PER_LICENSE',
        overageStrategy: 'NO_OVERAGE', requireHeartbeat: false, authenticationStrategy: 'LICENSE',
        metadata: { publicProductId: spec.publicProductId } },
        relationships: { product: { data: { type: 'products', id: product.id } } } } }, admin)).data;
    }
    map[policy.id] = spec.publicProductId;
    console.log('policy', spec.name, policy.id, spec.basis);
  }

  const lines = [];
  if (env.KEYGEN_PRODUCT_ID !== product.id) lines.push(`KEYGEN_PRODUCT_ID=${product.id}`);
  if (!env.KEYGEN_PRODUCT_TOKEN) {
    const token = await kg('POST', `/products/${product.id}/tokens`, { data: { type: 'tokens', attributes: { name: 'ttd-info server' } } }, admin);
    lines.push(`KEYGEN_PRODUCT_TOKEN=${token.data.attributes.token}`);
    console.log('product token created (saved to env file, not printed)');
  }
  lines.push(`KEYGEN_POLICY_PRODUCTS=${JSON.stringify(map)}`);
  appendFileSync(FILE, lines.join('\n') + '\n', { mode: 0o600 });
} finally {
  await kg('DELETE', `/tokens/${session.data.id}`, null, admin).catch(() => {});
}
