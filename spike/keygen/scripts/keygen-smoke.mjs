#!/usr/bin/env node
// Phase 1 functional spike against a Keygen CE instance.
// Reads ~/.keygen-spike.env (KEYGEN_HOST, KEYGEN_ACCOUNT_ID, KEYGEN_ADMIN_EMAIL, KEYGEN_ADMIN_PASSWORD).
// Prints PASS/FAIL per check and a JSON summary. Never prints keys, tokens or passwords.
//   node keygen-smoke.mjs [--base https://host] [--keep]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const env = Object.fromEntries(readFileSync(homedir() + '/.keygen-spike.env', 'utf8')
  .split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const argv = process.argv.slice(2);
const BASE = (argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'https://' + env.KEYGEN_HOST).replace(/\/$/, '');
const KEEP = argv.includes('--keep');
const ACCOUNT = env.KEYGEN_ACCOUNT_ID;
const API = `${BASE}/v1/accounts/${ACCOUNT}`;
const RUN = 'spike-' + Date.now().toString(36);
const DAY = 86400;

const results = [];
const timings = {};
let adminToken = '';
let adminTokenId = '';
let productToken = '';

async function call(method, path, { body, token, basic, timeoutMs = 30000 } = {}) {
  const headers = { Accept: 'application/vnd.api+json', 'Keygen-Version': '1.7' };
  if (body) headers['Content-Type'] = 'application/vnd.api+json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (basic) headers.Authorization = 'Basic ' + Buffer.from(basic).toString('base64');
  const t0 = performance.now();
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs)
  });
  const ms = Math.round(performance.now() - t0);
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json, ms };
}

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const errCode = (r) => r.json && r.json.errors && r.json.errors[0] && (r.json.errors[0].code || r.json.errors[0].title);
const fp = (install) => createHmac('sha256', RUN).update(install).digest('hex').slice(0, 32);

async function validate(key, fingerprint) {
  const r = await call('POST', '/licenses/actions/validate-key', {
    body: { meta: { key, ...(fingerprint ? { scope: { fingerprint } } : {}) } }
  });
  return { code: r.json && r.json.meta && r.json.meta.code, valid: !!(r.json && r.json.meta && r.json.meta.valid), ms: r.ms, lic: r.json && r.json.data };
}

async function activate(licenseId, fingerprint) {
  return call('POST', '/machines', {
    token: productToken,
    body: { data: { type: 'machines', attributes: { fingerprint, name: `TTD Autofill - Chrome instref:${fingerprint.slice(0, 12)}` },
      relationships: { license: { data: { type: 'licenses', id: licenseId } } } } }
  });
}

async function main() {
  console.log(`Keygen smoke test: ${BASE} run=${RUN}`);

  const ping = await call('GET', `${BASE}/v1/ping`, { timeoutMs: 60000 });
  timings.first_request_ms = ping.ms;
  check('instance reachable (/v1/ping)', ping.status < 500, `HTTP ${ping.status} in ${ping.ms} ms`);

  const tok = await call('POST', '/tokens', { basic: `${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`,
    body: { data: { type: 'tokens', attributes: { name: RUN, expiry: new Date(Date.now() + 3600e3).toISOString() } } } });
  adminToken = tok.json && tok.json.data && tok.json.data.attributes.token;
  adminTokenId = tok.json && tok.json.data && tok.json.data.id;
  check('admin token via basic auth', !!adminToken, `HTTP ${tok.status}`);
  if (!adminToken) return;

  const product = await call('POST', '/products', { token: adminToken,
    body: { data: { type: 'products', attributes: { name: `TTD Autofill ${RUN}`, distributionStrategy: 'CLOSED' } } } });
  const productId = product.json && product.json.data && product.json.data.id;
  check('create product', !!productId, `HTTP ${product.status}`);

  const ptok = await call('POST', `/products/${productId}/tokens`, { token: adminToken,
    body: { data: { type: 'tokens', attributes: { name: RUN } } } });
  productToken = ptok.json && ptok.json.data && ptok.json.data.attributes.token;
  check('product token (server-side credential)', !!productToken, `HTTP ${ptok.status}`);

  const policy = async (name, days, basis) => {
    const r = await call('POST', '/policies', { token: adminToken, body: { data: { type: 'policies',
      attributes: { name, duration: days ? days * DAY : null, maxMachines: 1, floating: true, strict: false,
        expirationBasis: basis, expirationStrategy: 'RESTRICT_ACCESS', machineUniquenessStrategy: 'UNIQUE_PER_LICENSE',
        overageStrategy: 'NO_OVERAGE', requireHeartbeat: false, authenticationStrategy: 'LICENSE' },
      relationships: { product: { data: { type: 'products', id: productId } } } } } });
    check(`create policy ${name}`, r.status === 201, `HTTP ${r.status} ${errCode(r) || ''}`);
    return r.json && r.json.data && r.json.data.id;
  };
  const pass7 = await policy('pass-7d', 7, 'FROM_CREATION');
  const grant7 = await policy('grant-7d', 7, 'FROM_FIRST_ACTIVATION');

  const user = await call('POST', '/users', { token: adminToken, body: { data: { type: 'users',
    attributes: { email: `${RUN}+buyer@example.com`, firstName: 'Spike', lastName: 'Buyer', metadata: { source: 'dodo-migrated' } } } } });
  const userId = user.json && user.json.data && user.json.data.id;
  check('create customer (user) without password', !!userId, `HTTP ${user.status} ${errCode(user) || ''}`);

  const createLicense = (key, policyId, extra = {}) => call('POST', '/licenses', { token: adminToken, body: { data: { type: 'licenses',
    attributes: { key, metadata: { source: 'dodo-migrated', run: RUN }, ...extra },
    relationships: { policy: { data: { type: 'policies', id: policyId } },
      ...(userId ? { owner: { data: { type: 'users', id: userId } } } : {}) } } } });

  const formats = {
    dodo_like_uuid: randomUUID().toUpperCase(),
    dodo_like_groups: Array.from({ length: 4 }, () => randomBytes(3).toString('hex').toUpperCase()).join('-'),
    test_fixture_style: `7DAY-${randomBytes(4).toString('hex').toUpperCase()}-LICENCE`,
    long_128: randomBytes(64).toString('hex')
  };
  const licenses = {};
  for (const [label, key] of Object.entries(formats)) {
    const r = await createLicense(key, pass7);
    const stored = r.json && r.json.data && r.json.data.attributes.key;
    licenses[label] = { id: r.json && r.json.data && r.json.data.id, key };
    check(`custom key preserved verbatim (${label}, ${key.length} chars)`, stored === key, `HTTP ${r.status} ${errCode(r) || ''}`);
  }

  const main = licenses.dodo_like_uuid;
  const lic = (await call('GET', `/licenses/${main.id}`, { token: adminToken })).json.data;
  const expiryDays = (Date.parse(lic.attributes.expiry) - Date.now()) / 864e5;
  check('pass-7d expiry set at creation (FROM_CREATION)', expiryDays > 6.9 && expiryDays <= 7, `${expiryDays.toFixed(3)} days`);

  const fpA = fp('install-A'); const fpB = fp('install-B');
  let v = await validate(main.key, fpA);
  check('validate before activation → NO_MACHINE(S)', /NO_MACHINE/.test(v.code || ''), v.code);

  let a = await activate(main.id, fpA);
  timings.activation_ms = a.ms;
  const machineA = a.json && a.json.data && a.json.data.id;
  check('activate installation A', a.status === 201, `HTTP ${a.status} ${a.ms} ms`);

  v = await validate(main.key, fpA);
  check('validate A → VALID', v.valid && v.code === 'VALID', v.code);

  a = await activate(main.id, fpA);
  check('same installation re-activate → conflict (adapter treats as idempotent)', a.status === 422, `HTTP ${a.status} ${errCode(a) || ''}`);

  a = await activate(main.id, fpB);
  check('second installation blocked by maxMachines=1', a.status === 422, `HTTP ${a.status} ${errCode(a) || ''}`);

  v = await validate(main.key, fpB);
  check('validate B (not activated) → FINGERPRINT_SCOPE_MISMATCH', v.code === 'FINGERPRINT_SCOPE_MISMATCH', v.code);

  const del = await call('DELETE', `/machines/${machineA}`, { token: adminToken });
  check('admin deactivates instance A (DELETE /machines/:id)', del.status === 204, `HTTP ${del.status}`);
  v = await validate(main.key, fpA);
  check('deactivated A no longer valid', !v.valid, v.code);
  a = await activate(main.id, fpB);
  check('freed slot → installation B activates', a.status === 201, `HTTP ${a.status}`);

  const sus = await call('POST', `/licenses/${main.id}/actions/suspend`, { token: adminToken });
  v = await validate(main.key, fpB);
  check('suspend → SUSPENDED', sus.status === 200 && v.code === 'SUSPENDED', `suspend HTTP ${sus.status} ${sus.ms} ms, validate ${v.code}`);
  await call('POST', `/licenses/${main.id}/actions/reinstate`, { token: adminToken });
  v = await validate(main.key, fpB);
  check('reinstate → VALID', v.code === 'VALID', v.code);

  const over = await call('PATCH', `/licenses/${main.id}`, { token: adminToken, body: { data: { type: 'licenses', attributes: { maxMachines: 2 } } } });
  a = await activate(main.id, fp('install-C'));
  check('per-licence maxMachines override (2) allows a second instance', over.status === 200 && a.status === 201, `PATCH ${over.status}, activate ${a.status} ${errCode(a) || ''}`);

  const past = await call('PATCH', `/licenses/${main.id}`, { token: adminToken, body: { data: { type: 'licenses', attributes: { expiry: new Date(Date.now() - 60e3).toISOString() } } } });
  v = await validate(main.key, fpB);
  check('expiry in the past → EXPIRED', past.status === 200 && v.code === 'EXPIRED', v.code);

  const grant = await createLicense(`GRANT-${randomBytes(6).toString('hex').toUpperCase()}`, grant7);
  const grantId = grant.json && grant.json.data && grant.json.data.id;
  check('grant licence created with no expiry (FROM_FIRST_ACTIVATION)', grant.status === 201 && !grant.json.data.attributes.expiry, `expiry=${grant.json && grant.json.data && grant.json.data.attributes.expiry}`);
  await activate(grantId, fp('grant-install'));
  let gexp = null;
  for (let i = 0; i < 10 && !gexp; i++) {
    gexp = (await call('GET', `/licenses/${grantId}`, { token: adminToken })).json.data.attributes.expiry;
    if (!gexp) await new Promise((r) => setTimeout(r, 1000));
  }
  const gdays = gexp ? (Date.parse(gexp) - Date.now()) / 864e5 : null;
  check('first activation starts grant clock (+7 days)', gdays && gdays > 6.9 && gdays <= 7, gdays ? `${gdays.toFixed(3)} days` : 'expiry still null (needs worker?)');

  const offline = await call('POST', '/licenses', { token: adminToken, body: { data: { type: 'licenses',
    attributes: { metadata: { source: 'offline', method: 'upi', reference: `UTR${RUN}`, amountInr: 299 } },
    relationships: { policy: { data: { type: 'policies', id: pass7 } } } } } });
  const found = await call('GET', `/licenses?metadata[source]=offline&metadata[reference]=UTR${RUN}`, { token: adminToken });
  check('offline sale licence (generated key) + metadata search', offline.status === 201 && found.json && found.json.data.length === 1,
    `create ${offline.status}, found ${found.json && found.json.data && found.json.data.length}`);

  const lat = [];
  for (let i = 0; i < 20; i++) lat.push((await validate(licenses.dodo_like_groups.key)).ms);
  lat.sort((x, y) => x - y);
  timings.validate_p50_ms = lat[9]; timings.validate_p95_ms = lat[18];
  check('validate-key latency measured', true, `p50 ${lat[9]} ms, p95 ${lat[18]} ms`);

  if (!KEEP) {
    const all = [...Object.values(licenses).map((l) => l.id), grantId, offline.json && offline.json.data && offline.json.data.id].filter(Boolean);
    for (const id of all) await call('DELETE', `/licenses/${id}`, { token: adminToken });
    for (const id of [pass7, grant7]) if (id) await call('DELETE', `/policies/${id}`, { token: adminToken });
    if (userId) await call('DELETE', `/users/${userId}`, { token: adminToken });
    if (productId) await call('DELETE', `/products/${productId}`, { token: adminToken });
    console.log('cleaned up spike records');
  }
}

main().catch((e) => check('unexpected error', false, e.message)).finally(async () => {
  if (adminTokenId) await call('DELETE', `/tokens/${adminTokenId}`, { token: adminToken }).catch(() => {});
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ base: BASE, run: RUN, passed: results.length - failed, failed, timings }, null, 2));
  process.exitCode = failed ? 1 : 0;
});
