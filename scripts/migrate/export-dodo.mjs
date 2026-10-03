#!/usr/bin/env node
// READ-ONLY export of Dodo licences, activation instances and customers.
// Writes an age-encrypted snapshot to ~/ttd-migration/ (never inside the repo) and
// prints counts only. Needs: ~/.dodoenv (API key), ~/.ttd-backup-age.key (recipient).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = 'https://live.dodopayments.com';
const KEY = readFileSync(homedir() + '/.dodoenv', 'utf8').split('\n').find((l) => l.trim()).replace(/^[^=]*=\s*/, '').replace(/^"|"$/g, '').trim();
const RECIPIENT = execFileSync('age-keygen', ['-y', homedir() + '/.ttd-backup-age.key'], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

// Dodo rate-limits bursts: back off (honouring Retry-After) for up to ~6 min per call.
async function get(path) {
  let last = 'no response';
  for (let attempt = 0; attempt < 10; attempt++) {
    calls++;
    const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (r && r.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`GET ${path.split('?')[0]} → ${r.status}`);
    last = r ? 'HTTP ' + r.status : 'network error';
    const retryAfter = r && Number(r.headers.get('retry-after'));
    await sleep(Math.min(60000, Math.max(retryAfter ? retryAfter * 1000 : 0, 1000 * 2 ** attempt)));
  }
  throw new Error(`GET ${path.split('?')[0]} kept failing (${last})`);
}

async function all(path) {
  const items = [];
  for (let page = 0; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const j = await get(`${path}${sep}page_size=100&page_number=${page}`);
    const batch = Array.isArray(j && j.items) ? j.items : [];
    items.push(...batch);
    if (batch.length < 100) return items;
    await sleep(150);
  }
}

const started = new Date().toISOString();
const licenseKeys = await all('/license_keys');
const customers = await all('/customers');
const instances = [];
const withInstances = licenseKeys.filter((k) => Number(k.instances_count) > 0);
let next = 0;
await Promise.all(Array.from({ length: Number(process.env.EXPORT_CONCURRENCY || 3) }, async () => {
  while (next < withInstances.length) {
    const lk = withInstances[next++];
    instances.push(...await all('/license_key_instances?license_key_id=' + encodeURIComponent(lk.id)));
    await sleep(120);
  }
}));

const snapshot = { schema: 1, source: 'dodo-live', exported_at: new Date().toISOString(), started_at: started, license_keys: licenseKeys, instances, customers };
const dir = homedir() + '/ttd-migration';
mkdirSync(dir, { recursive: true, mode: 0o700 });
const out = `${dir}/dodo-snapshot-${started.replace(/[:.]/g, '-')}.json.age`;
const enc = spawnSync('age', ['-r', RECIPIENT, '-o', out], { input: JSON.stringify(snapshot) });
if (enc.status !== 0) throw new Error('age encryption failed');

const byStatus = licenseKeys.reduce((m, k) => ((m[k.status] = (m[k.status] || 0) + 1), m), {});
const byProduct = licenseKeys.reduce((m, k) => ((m[k.product_id] = (m[k.product_id] || 0) + 1), m), {});
console.log(JSON.stringify({
  snapshot: out, api_calls: calls,
  license_keys: licenseKeys.length, by_status: byStatus, by_product: byProduct,
  with_instances: licenseKeys.filter((k) => Number(k.instances_count) > 0).length,
  instances: instances.length, customers: customers.length,
  with_expiry: licenseKeys.filter((k) => k.expires_at).length, without_payment: licenseKeys.filter((k) => !k.payment_id).length,
  with_subscription: licenseKeys.filter((k) => k.subscription_id).length
}, null, 2));
