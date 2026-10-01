#!/usr/bin/env node
// Runs the real /api/license-* handlers against an imported Keygen (rehearsal) with real
// migrated licences, using Dodo-era-shaped entitlements signed by a local test key.
// The ledger is served in-memory from the import's ledger-rows file (nothing written to
// the production ledger). Modifies only the rehearsal Keygen. Prints PASS/FAIL only.
//   node verify-adapter.mjs <plan.json.age> <keygen env file>
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [planFile, envFile] = process.argv.slice(2);
const AGE_KEY = homedir() + '/.ttd-backup-age.key';
const decrypt = (f) => JSON.parse(execFileSync('age', ['-d', '-i', AGE_KEY, f], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const target = env.KEYGEN_HOST.split('.')[0];
const plan = decrypt(planFile);
const ledger = decrypt(`${homedir()}/ttd-migration/ledger-rows-${target}.json.age`);
const state = JSON.parse(readFileSync(`${homedir()}/ttd-migration/import-state-${target}.json`, 'utf8'));

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
Object.assign(process.env, {
  TTDAF_ENTITLEMENT_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
  TTDAF_LOG_CORRELATION_SECRET: 'rehearsal-' + randomBytes(6).toString('hex'),
  KEYGEN_API_URL: 'https://' + env.KEYGEN_HOST, KEYGEN_ACCOUNT_ID: env.KEYGEN_ACCOUNT_ID,
  KEYGEN_PRODUCT_TOKEN: env.KEYGEN_PRODUCT_TOKEN, KEYGEN_PRODUCT_ID: env.KEYGEN_PRODUCT_ID,
  KEYGEN_POLICY_PRODUCTS: env.KEYGEN_POLICY_PRODUCTS, LICENSING_PROVIDER: 'dodo',
  TTD_LEDGER_URL: 'https://ledger.rehearsal', TTD_LEDGER_SECRET_KEY: 'in-memory'
});
delete process.env.VERCEL; delete process.env.VERCEL_ENV;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'ledger.rehearsal') return realFetch(url, opts);
  const table = u.pathname.split('/').pop();
  const rows = ledger[table] || [];
  const filters = [...u.searchParams].filter(([k]) => !['select', 'limit'].includes(k));
  const hit = rows.filter((r) => filters.every(([k, v]) => String(r[k]) === v.replace(/^eq\./, '')));
  if ((opts.method || 'GET') === 'PATCH') hit.forEach((r) => Object.assign(r, JSON.parse(opts.body)));
  return new Response(JSON.stringify(hit), { status: 200 });
};
console.log = () => {};
const say = (n, ok, d = '') => { results.push(ok); process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}\n`); };
const results = [];

const { issueEntitlement } = await import('../../api/_entitlement.mjs');
const activate = (await import('../../api/license-activate.mjs')).default;
const refresh = (await import('../../api/license-refresh.mjs')).default;
const call = async (h, body) => {
  const r = { statusCode: 200, body: undefined, setHeader() {}, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
  await h({ method: 'POST', body, headers: { origin: 'https://ttd-info.vercel.app', 'content-length': String(JSON.stringify(body).length) } }, r);
  return r;
};
const uuid = () => '11111111-1111-4111-8111-' + randomBytes(6).toString('hex');
const oldToken = (e, instanceId, installation) => issueEntitlement({ productId: e.public_product_id, licenseKeyId: e.public_license_id,
  installationUuid: installation, activationInstanceId: instanceId, providerExpiry: e.expiry },
  Math.min(Date.now() - 9 * 3600e3, e.expiry ? Date.parse(e.expiry) - 3600e3 : Infinity)).token;

const live = plan.entries.filter((e) => e.action === 'migrate' && e.status === 'ACTIVE' && !e.expired && state.done[e.public_license_id]);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const legacy = pick(live.filter((e) => e.machines.length === 1 && e.machines[0].legacy && e.max_machines === 1));
const grant = pick(live.filter((e) => e.kind === 'grant' && !e.machines.length));
const suspended = plan.entries.find((e) => e.action === 'migrate' && e.status === 'SUSPENDED' && e.machines.length && state.done[e.public_license_id]);
const expired = pick(plan.entries.filter((e) => e.action === 'migrate' && e.expired && e.status === 'ACTIVE' && e.machines.length && state.done[e.public_license_id]));

if (legacy) {
  const install = uuid();
  const inst = legacy.machines[0].public_instance_id;
  const r = await call(refresh, { license_key: legacy.key, instance_id: inst, installation_uuid: install, entitlement_token: oldToken(legacy, inst, install) });
  say('live licence, pre-marker browser: old token refreshes (bridge)', r.statusCode === 200 && r.body.license_key_id === legacy.public_license_id && r.body.instance_id === inst && r.body.provider_expires_at && Date.parse(r.body.provider_expires_at) === Date.parse(legacy.expiry), `HTTP ${r.statusCode} ${r.body && r.body.error || ''}`);
  const again = await call(refresh, { license_key: legacy.key, instance_id: inst, installation_uuid: install, entitlement_token: r.body.entitlement_token || '' });
  say('…and keeps refreshing after the bridge', again.statusCode === 200);
  const other = await call(activate, { license_key: legacy.key, installation_uuid: uuid() });
  say('…a second browser is told the pass is in use', other.statusCode === 409 && other.body.error === 'activation_in_use', `HTTP ${other.statusCode} ${other.body.error}`);
} else say('found a live licence with a pre-marker browser', false);

if (grant) {
  const a = await call(activate, { license_key: grant.key, installation_uuid: uuid() });
  const days = a.body && a.body.provider_expires_at ? (Date.parse(a.body.provider_expires_at) - Date.now()) / 864e5 : null;
  const want = { '7d': 7, '30d': 30, '90d': 90 }[grant.plan];
  say(`unused complimentary ${grant.plan} key: activates and its clock starts now`, a.statusCode === 200 && days > want - 0.01 && days <= want, days ? days.toFixed(3) + ' days' : `HTTP ${a.statusCode} ${a.body.error}`);
} else say('found an unused complimentary key', false);

if (suspended) {
  const inst = suspended.machines[0].public_instance_id;
  const install = uuid();
  const r = await call(refresh, { license_key: suspended.key, instance_id: inst, installation_uuid: install, entitlement_token: oldToken(suspended, inst, install) });
  say('disabled Dodo key: refresh is refused (terminal)', r.statusCode === 401 && r.body.provider_status === 'invalid', `HTTP ${r.statusCode}`);
} else say('found a disabled key', false);

if (expired) {
  const inst = expired.machines[0].public_instance_id;
  const install = uuid();
  const r = await call(refresh, { license_key: expired.key, instance_id: inst, installation_uuid: install, entitlement_token: oldToken(expired, inst, install) });
  say('expired Dodo key: refresh is refused (terminal)', r.statusCode === 401, `HTTP ${r.statusCode}`);
  const a = await call(activate, { license_key: expired.key, installation_uuid: uuid() });
  say('expired Dodo key: new activation says expired', a.statusCode === 400 && a.body.error === 'licence_expired', `HTTP ${a.statusCode} ${a.body.error}`);
} else say('found an expired key', false);

const failed = results.filter((x) => !x).length;
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
process.exitCode = failed ? 1 : 0;
