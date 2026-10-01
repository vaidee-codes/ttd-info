#!/usr/bin/env node
// Imports a migration plan into a Keygen instance (rehearsal or, at cutover, production).
//   node import.mjs <plan.json.age> <keygen env file> [--limit N]
// Resumable: progress is checkpointed; licences are looked up by key before create.
// Writes the ledger rows to apply at cutover (licence_authority + instance_alias) to an
// age-encrypted file. Never touches Dodo. Prints counts only.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [planFile, envFile] = process.argv.slice(2);
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const SYNC = process.argv.includes('--sync');
if (!planFile || !envFile) { console.error('usage: import.mjs <plan.json.age> <keygen env file> [--limit N]'); process.exit(2); }
const AGE_KEY = homedir() + '/.ttd-backup-age.key';
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `https://${env.KEYGEN_HOST}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const target = env.KEYGEN_HOST.split('.')[0];
const STATE = `${homedir()}/ttd-migration/import-state-${target}.json`;
const plan = JSON.parse(execFileSync('age', ['-d', '-i', AGE_KEY, planFile], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { done: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });

async function kg(method, path, body, auth, attempt = 0) {
  const r = await fetch(API + path, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8', Authorization: auth } }).catch(() => null);
  if (!r || r.status === 429 || r.status >= 500) {
    if (attempt >= 5) throw new Error(`${method} ${path.split('?')[0]} unavailable`);
    await new Promise((x) => setTimeout(x, 1000 * 2 ** attempt));
    return kg(method, path, body, auth, attempt + 1);
  }
  return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
}

const basic = 'Basic ' + Buffer.from(`${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const session = await kg('POST', '/tokens', { data: { type: 'tokens', attributes: { name: 'migration-import', expiry: new Date(Date.now() + 6 * 3600e3).toISOString() } } }, basic);
const ADMIN = 'Bearer ' + session.json.data.attributes.token;
const policies = Object.fromEntries((await kg('GET', `/policies?product=${env.KEYGEN_PRODUCT_ID}&page[size]=100&page[number]=1`, null, ADMIN)).json.data.map((p) => [p.attributes.name, p.id]));

const stats = { licences_created: 0, licences_existing: 0, machines_created: 0, suspended: 0, synced_fields: 0, machines_removed: 0, reinstated: 0, errors: {} };
const bump = (k) => (stats.errors[k] = (stats.errors[k] || 0) + 1);

// --sync: bring an already-imported licence in line with the (newer) plan.
async function syncEntry(e, licenseId, entry) {
  const lic = await kg('GET', '/licenses/' + licenseId, null, ADMIN);
  const a = lic.json && lic.json.data && lic.json.data.attributes;
  if (!a) { bump('sync_missing'); return; }
  const patch = {};
  const wantLimit = Math.max(e.max_machines, e.machines.length);
  if (e.expiry && Date.parse(a.expiry || 0) !== Date.parse(e.expiry)) patch.expiry = e.expiry;
  if (Number(a.maxMachines) !== wantLimit) patch.maxMachines = wantLimit;
  if (Number(a.metadata && a.metadata.baseMaxMachines) !== wantLimit) patch.metadata = { ...(a.metadata || {}), baseMaxMachines: wantLimit };
  if (Object.keys(patch).length) {
    const r = await kg('PATCH', '/licenses/' + licenseId, { data: { type: 'licenses', attributes: patch } }, ADMIN);
    if (r.status === 200) stats.synced_fields += Object.keys(patch).length; else bump('sync_patch_' + r.status);
  }
  if (a.status === 'SUSPENDED' && e.status !== 'SUSPENDED') {
    const r = await kg('POST', `/licenses/${licenseId}/actions/reinstate`, null, ADMIN);
    if (r.status === 200) { entry.suspended = false; stats.reinstated++; } else bump('reinstate_' + r.status);
  } else if (a.status === 'SUSPENDED') entry.suspended = true;
  const existing = (await kg('GET', `/machines?license=${licenseId}&page[size]=100&page[number]=1`, null, ADMIN)).json.data || [];
  const wanted = new Set(e.machines.map((m) => m.public_instance_id));
  for (const m of existing) {
    const pid = m.attributes.metadata && m.attributes.metadata.publicInstanceId;
    if (pid && !wanted.has(pid)) {
      const d = await kg('DELETE', '/machines/' + m.id, null, ADMIN);
      if (d.status === 204) { stats.machines_removed++; delete entry.machines[pid]; } else bump('machine_delete_' + d.status);
    } else if (pid) entry.machines[pid] = m.id;
  }
}

async function importEntry(e) {
  let licenseId = state.done[e.public_license_id] && state.done[e.public_license_id].license;
  if (!licenseId) {
    const found = await kg('POST', '/licenses/actions/validate-key', { meta: { key: e.key } }, ADMIN);
    licenseId = found.json && found.json.data && found.json.data.id;
    if (licenseId) stats.licences_existing++;
  }
  if (!licenseId) {
    const attributes = {
      key: e.key,
      ...(e.expiry ? { expiry: e.expiry } : {}),
      ...(Math.max(e.max_machines, e.machines.length) !== 1 ? { maxMachines: Math.max(e.max_machines, e.machines.length) } : {}),
      metadata: { source: 'dodo-migrated', publicLicenseId: e.public_license_id, publicProductId: e.public_product_id, plan: e.plan,
        email: e.email, dodoPaymentId: e.dodo.payment_id, dodoCreatedAt: e.dodo.created_at,
        // The limit to restore after a legacy-machine bridge (see _licensing.mjs).
        baseMaxMachines: Math.max(e.max_machines, e.machines.length) }
    };
    const c = await kg('POST', '/licenses', { data: { type: 'licenses', attributes, relationships: { policy: { data: { type: 'policies', id: policies[e.policy] } } } } }, ADMIN);
    if (c.status !== 201) { bump('licence_' + ((c.json && c.json.errors && c.json.errors[0].code) || c.status)); return; }
    licenseId = c.json.data.id;
    stats.licences_created++;
  }
  const entry = state.done[e.public_license_id] || { license: licenseId, machines: {} };
  state.done[e.public_license_id] = entry;
  for (const m of e.machines) {
    if (entry.machines[m.public_instance_id]) continue;
    const c = await kg('POST', '/machines', { data: { type: 'machines',
      attributes: { fingerprint: m.fingerprint, name: m.name, metadata: { publicInstanceId: m.public_instance_id, dodoCreatedAt: m.created_at } },
      relationships: { license: { data: { type: 'licenses', id: licenseId } } } } }, ADMIN);
    if (c.status === 201) { entry.machines[m.public_instance_id] = c.json.data.id; stats.machines_created++; }
    else if (c.json && c.json.errors && c.json.errors[0].code === 'FINGERPRINT_TAKEN') {
      const f = await kg('GET', `/machines?license=${licenseId}&fingerprint=${encodeURIComponent(m.fingerprint)}&page[size]=1&page[number]=1`, null, ADMIN);
      if (f.json && f.json.data && f.json.data[0]) entry.machines[m.public_instance_id] = f.json.data[0].id;
    } else bump('machine_' + ((c.json && c.json.errors && c.json.errors[0].code) || c.status));
  }
  if (SYNC) await syncEntry(e, licenseId, entry);
  if (e.status === 'SUSPENDED' && !entry.suspended) {
    const s = await kg('POST', `/licenses/${licenseId}/actions/suspend`, null, ADMIN);
    if (s.status === 200 || (s.json && s.json.errors && s.json.errors[0].code === 'LICENSE_ALREADY_SUSPENDED')) { entry.suspended = true; stats.suspended++; }
    else bump('suspend_' + s.status);
  }
}

const todo = plan.entries.filter((e) => e.action === 'migrate').slice(0, LIMIT);

// --sync: a licence imported earlier that the newer plan no longer migrates
// (quarantined or gone) must not stay valid in Keygen. Suspend it; it also
// gets no ledger row, so it is never routed to Keygen.
async function suspendStale() {
  const wanted = new Set(plan.entries.filter((e) => e.action === 'migrate').map((e) => e.public_license_id));
  for (const [publicId, entry] of Object.entries(state.done)) {
    if (wanted.has(publicId) || entry.stale) continue;
    const s = await kg('POST', `/licenses/${entry.license}/actions/suspend`, null, ADMIN);
    if (s.status === 200 || (s.json && s.json.errors && s.json.errors[0].code === 'LICENSE_ALREADY_SUSPENDED') || s.status === 404) {
      entry.stale = true; stats.stale_suspended = (stats.stale_suspended || 0) + 1;
    } else bump('stale_suspend_' + s.status);
  }
}
const started = Date.now();
const CONCURRENCY = 4;
let index = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (index < todo.length) {
    const e = todo[index++];
    try { await importEntry(e); } catch (error) { bump('exception'); }
    if (index % 100 === 0) { save(); process.stderr.write(`  ${index}/${todo.length}\n`); }
  }
}));
if (SYNC && LIMIT === Infinity) await suspendStale();
save();
await kg('DELETE', `/tokens/${session.json.data.id}`, null, ADMIN).catch(() => {});

// Ledger rows for cutover (not applied here).
const hash = (k) => createHash('sha256').update(k, 'utf8').digest('hex');
const ledger = { licence_authority: [], instance_alias: [] };
for (const e of plan.entries.filter((x) => x.authority === 'dodo' && x.key)) {
  ledger.licence_authority.push({ key_hash: hash(e.key), authority: 'dodo', public_license_id: e.public_license_id, keygen_license_id: null, source: 'dodo-supporter' });
}
for (const e of todo) {
  const d = state.done[e.public_license_id];
  if (!d || d.stale) continue;
  ledger.licence_authority.push({ key_hash: hash(e.key), authority: 'keygen', public_license_id: e.public_license_id, keygen_license_id: d.license, source: 'dodo-migrated' });
  for (const [instanceId, machineId] of Object.entries(d.machines)) ledger.instance_alias.push({ public_instance_id: instanceId, public_license_id: e.public_license_id, keygen_machine_id: machineId });
}
const recipient = execFileSync('age-keygen', ['-y', AGE_KEY], { encoding: 'utf8' }).trim();
const ledgerFile = `${homedir()}/ttd-migration/ledger-rows-${target}.json.age`;
spawnSync('age', ['-r', recipient, '-o', ledgerFile], { input: JSON.stringify(ledger) });
console.log(JSON.stringify({ target, entries: todo.length, seconds: Math.round((Date.now() - started) / 1000), ...stats,
  ledger_rows: { licence_authority: ledger.licence_authority.length, instance_alias: ledger.instance_alias.length }, ledger_file: ledgerFile }, null, 2));
