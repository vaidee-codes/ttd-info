#!/usr/bin/env node
// Compares every imported licence in a Keygen instance with its plan entry, field by field.
//   node reconcile.mjs <plan.json.age> <keygen env file>
// Prints mismatch counts by field (and HMAC refs for the first few), never keys or emails.
import { createHmac } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [planFile, envFile] = process.argv.slice(2);
const AGE_KEY = homedir() + '/.ttd-backup-age.key';
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `https://${env.KEYGEN_HOST}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const target = env.KEYGEN_HOST.split('.')[0];
const plan = JSON.parse(execFileSync('age', ['-d', '-i', AGE_KEY, planFile], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
const state = JSON.parse(readFileSync(`${homedir()}/ttd-migration/import-state-${target}.json`, 'utf8'));
const ref = (v) => createHmac('sha256', 'migration-report').update('dodo_license\0' + v).digest('hex').slice(0, 12);

async function kg(path, auth, attempt = 0) {
  const r = await fetch(API + path, { headers: { Accept: 'application/vnd.api+json', 'Keygen-Version': '1.8', Authorization: auth }, signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!r || r.status === 429 || r.status >= 500) {
    if (attempt >= 5) throw new Error('unavailable');
    await new Promise((x) => setTimeout(x, 1000 * 2 ** attempt));
    return kg(path, auth, attempt + 1);
  }
  return r.json();
}
const basic = 'Basic ' + Buffer.from(`${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const tok = await fetch(API + '/tokens', { method: 'POST', headers: { Authorization: basic, Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8' },
  body: JSON.stringify({ data: { type: 'tokens', attributes: { name: 'reconcile', expiry: new Date(Date.now() + 3600e3).toISOString() } } }) }).then((r) => r.json());
const ADMIN = 'Bearer ' + tok.data.attributes.token;
const policyNames = Object.fromEntries((await kg(`/policies?product=${env.KEYGEN_PRODUCT_ID}&page[size]=100&page[number]=1`, ADMIN)).data.map((p) => [p.id, p.attributes.name]));

// Activations deliberately removed after the import (extension deactivate or
// /ops reset) leave a tombstoned alias in the ledger; those are expected gaps.
const tombstoned = (() => {
  try {
    const pw = readFileSync(homedir() + '/.dbpassword', 'utf8').split('\n').find((l) => l.trim()).trim();
    const r = spawnSync('psql', ['host=aws-0-ap-south-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.nfjpzkkqcfgvopijnxtj sslmode=require', '-tAc',
      'select public_instance_id from instance_alias where tombstoned_at is not null'], { env: { ...process.env, PGPASSWORD: pw }, encoding: 'utf8' });
    return new Set(r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []);
  } catch { return new Set(); }
})();
const explained = { new_activations_after_import: 0, activations_removed_after_import: 0 };
const entries = plan.entries.filter((e) => e.action === 'migrate' && state.done[e.public_license_id]);
const missing = plan.entries.filter((e) => e.action === 'migrate' && !state.done[e.public_license_id]).length;
const wanted = new Set(plan.entries.filter((e) => e.action === 'migrate').map((e) => e.public_license_id));
const staleNotSuspended = Object.entries(state.done).filter(([id, d]) => !wanted.has(id) && !d.stale).length;
const mismatches = {};
const samples = {};
const miss = (field, e) => { mismatches[field] = (mismatches[field] || 0) + 1; (samples[field] ||= []).length < 3 && samples[field].push(ref(e.public_license_id)); };

let index = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (index < entries.length) {
    const e = entries[index++];
    const id = state.done[e.public_license_id].license;
    const [lic, machines] = await Promise.all([kg('/licenses/' + id, ADMIN), kg(`/machines?license=${id}&page[size]=100&page[number]=1`, ADMIN)]);
    const a = lic.data && lic.data.attributes;
    if (!a) { miss('licence_missing', e); continue; }
    if (a.key !== e.key) miss('key', e);
    if ((a.expiry ? Date.parse(a.expiry) : null) !== (e.expiry ? Date.parse(e.expiry) : null)) miss('expiry', e);
    if ((a.status === 'SUSPENDED') !== (e.status === 'SUSPENDED')) miss('suspended', e);
    if (a.status === 'BANNED') miss('banned', e);
    if (Number(a.maxMachines) !== Math.max(e.max_machines, e.machines.length)) miss('max_machines', e);
    if (policyNames[lic.data.relationships.policy.data.id] !== e.policy) miss('policy', e);
    if (a.metadata.publicLicenseId !== e.public_license_id) miss('public_license_id', e);
    if (a.metadata.publicProductId !== e.public_product_id) miss('public_product_id', e);
    if ((a.metadata.email || null) !== (e.email || null)) miss('email', e);
    // Machines made in Keygen after the import (no Dodo id) and Dodo instances
    // whose Keygen machine was deliberately removed are expected; anything else
    // about machines is a real difference.
    const imported = (machines.data || []).filter((m) => m.attributes.metadata && m.attributes.metadata.publicInstanceId);
    explained.new_activations_after_import += (machines.data || []).length - imported.length;
    const wantList = e.machines.filter((m) => {
      const present = imported.some((x) => x.attributes.metadata.publicInstanceId === m.public_instance_id);
      if (!present && tombstoned.has(m.public_instance_id)) { explained.activations_removed_after_import++; return false; }
      return true;
    });
    // A legacy machine re-bound by the bridge keeps its Dodo id with the browser's real fingerprint.
    const fp = (x) => (x.attributes.metadata.bridgedFrom || String(x.attributes.fingerprint).startsWith('legacy:')) ? 'bridged' : x.attributes.fingerprint;
    const got = imported.map((m) => `${m.attributes.metadata.publicInstanceId}|${fp(m) === 'bridged' ? 'legacy' : fp(m)}`).sort().join(',');
    const want = wantList.map((m) => `${m.public_instance_id}|${m.legacy ? 'legacy' : m.fingerprint}`).sort().join(',');
    if (got !== want) miss('machines', e);
  }
}));
await fetch(API + '/tokens/' + tok.data.id, { method: 'DELETE', headers: { Authorization: ADMIN } }).catch(() => {});
console.log(JSON.stringify({ target, compared: entries.length, not_yet_imported: missing,
  stale_not_suspended: staleNotSuspended, supporters_kept_on_dodo: plan.entries.filter((e) => e.authority === 'dodo').length,
  explained,
  unexplained_differences: Object.values(mismatches).reduce((a, b) => a + b, 0) + staleNotSuspended, by_field: mismatches, sample_refs: samples }, null, 2));
