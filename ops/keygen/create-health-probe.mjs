#!/usr/bin/env node
// Idempotently creates the suspended licence that health-watch's keygen_writes
// check validates. Validating an existing licence makes Keygen queue an event in
// Redis, so the check fails when Redis refuses writes (the 2026-10-29 outage),
// which a lookup of a missing key never notices. Reads ~/.ttd-keygen-prod.env;
// prints IDs only, never secrets.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const PROBE_KEY = 'TTDAF-HEALTH-PROBE-SUSPENDED';

const FILE = process.argv[2] || homedir() + '/.ttd-keygen-prod.env';
const env = Object.fromEntries(readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `https://${env.KEYGEN_HOST}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const auth = 'Bearer ' + env.KEYGEN_PRODUCT_TOKEN;

async function kg(method, path, body) {
  const r = await fetch(API + path, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8', Authorization: auth } });
  const json = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${json && json.errors && json.errors[0] && json.errors[0].code}`);
  return json;
}

const found = await kg('POST', '/licenses/actions/validate-key', { meta: { key: PROBE_KEY } });
let license = found.data;
if (!license) {
  const policy = (await kg('GET', '/policies?page[size]=100&page[number]=1')).data.find((p) => p.attributes.name === 'grant-7d');
  if (!policy) throw new Error('policy grant-7d not found');
  license = (await kg('POST', '/licenses', { data: { type: 'licenses',
    attributes: { key: PROBE_KEY, name: 'health-watch probe (suspended, never sold)', metadata: { purpose: 'health-probe' } },
    relationships: { policy: { data: { type: 'policies', id: policy.id } } } } })).data;
  console.log('created', license.id);
}
if (license.attributes.status !== 'SUSPENDED') {
  license = (await kg('POST', `/licenses/${license.id}/actions/suspend`)).data;
}
console.log('probe licence', license.id, license.attributes.status);
