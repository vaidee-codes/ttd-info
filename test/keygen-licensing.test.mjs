import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.TTDAF_ENTITLEMENT_PRIVATE_KEY = JSON.stringify(privateKey.export({ format: 'jwk' }));
process.env.TTDAF_LOG_CORRELATION_SECRET = 'keygen-licensing-test';
process.env.KEYGEN_API_URL = 'https://keygen.test';
process.env.KEYGEN_ACCOUNT_ID = 'acct-1';
process.env.KEYGEN_PRODUCT_TOKEN = 'prod-token';
process.env.KEYGEN_PRODUCT_ID = 'kg-product';
process.env.TTD_LEDGER_URL = 'https://ledger.test';
process.env.TTD_LEDGER_SECRET_KEY = 'ledger-secret';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const { verifyEntitlement, issueEntitlement } = await import('../api/_entitlement.mjs');
const { installationRef } = await import('../api/_dodo.mjs');
const { licenceKeyHash } = await import('../api/_ledger.mjs');
const activate = (await import('../api/license-activate.mjs')).default;
const refresh = (await import('../api/license-refresh.mjs')).default;
const validate = (await import('../api/license-validate.mjs')).default;
const deactivate = (await import('../api/license-deactivate.mjs')).default;

const WEEKLY = 'pdt_0Nk4Gw67usedtjPoO6hX2';
const INSTALL_A = '11111111-1111-4111-8111-111111111111';
const INSTALL_B = '22222222-2222-4222-8222-222222222222';
const DAY = 86400;

// Stateful fake of the Keygen API subset the adapter uses, plus the ledger.
function fakeWorld(t, { ledgerDown = false } = {}) {
  const world = { policies: {}, licenses: {}, machines: {}, authority: [], aliases: [], calls: [], keygenDown: false, createTimeoutCommits: false };
  const kgJson = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/vnd.api+json' } });
  const err = (status, code) => kgJson({ errors: [{ code, title: code }] }, status);
  const licDoc = (l) => ({ id: l.id, type: 'licenses', attributes: { key: l.key, expiry: l.expiry, status: l.status, maxMachines: l.maxMachines, metadata: l.metadata },
    relationships: { policy: { data: { type: 'policies', id: l.policy } }, product: { data: { type: 'products', id: l.product } } } });
  const machDoc = (m) => ({ id: m.id, type: 'machines', attributes: { fingerprint: m.fingerprint, name: m.name, metadata: m.metadata || {} },
    relationships: { license: { data: { type: 'licenses', id: m.license } } } });
  const machinesOf = (id) => Object.values(world.machines).filter((m) => m.license === id);

  function validateCode(l, fingerprint) {
    if (!l) return 'NOT_FOUND';
    if (l.product !== 'kg-product') return 'PRODUCT_SCOPE_MISMATCH';
    if (l.status === 'SUSPENDED') return 'SUSPENDED';
    if (l.expiry && Date.parse(l.expiry) <= Date.now()) return 'EXPIRED';
    const machines = machinesOf(l.id);
    if (fingerprint) {
      if (!machines.length) return 'NO_MACHINES';
      if (!machines.some((m) => m.fingerprint === fingerprint)) return 'FINGERPRINT_SCOPE_MISMATCH';
    }
    return 'VALID';
  }

  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    world.calls.push(method + ' ' + u.host + u.pathname);
    if (u.host === 'ledger.test') {
      if (ledgerDown) return new Response('down', { status: 503 });
      const table = u.pathname.split('/').pop();
      const rows = table === 'licence_authority' ? world.authority : world.aliases;
      const filters = [...u.searchParams].filter(([k]) => !['select', 'limit'].includes(k));
      const hit = rows.filter((row) => filters.every(([k, v]) => String(row[k]) === v.replace(/^eq\./, '')));
      if (method === 'PATCH' && world.failNextAliasPatch) { world.failNextAliasPatch = false; return new Response('down', { status: 503 }); }
      if (method === 'PATCH') { hit.forEach((r) => Object.assign(r, body)); world.aliasPatches = (world.aliasPatches || 0) + 1; }
      return new Response(JSON.stringify(hit), { status: 200 });
    }
    if (world.keygenDown) throw new TypeError('fetch failed');
    assert.equal(options.headers.Authorization, 'Bearer prod-token');
    const path = u.pathname.replace('/v1/accounts/acct-1', '');
    if (path === '/licenses/actions/validate-key' && method === 'POST') {
      const l = Object.values(world.licenses).find((x) => x.key === body.meta.key);
      const code = validateCode(l, body.meta.scope && body.meta.scope.fingerprint);
      return kgJson({ data: l ? licDoc(l) : null, meta: { valid: code === 'VALID', code } });
    }
    let m;
    if ((m = path.match(/^\/licenses\/([^/]+)$/))) {
      const l = world.licenses[m[1]];
      if (!l) return err(404, 'NOT_FOUND');
      if (method === 'PATCH') Object.assign(l, body.data.attributes);
      return kgJson({ data: licDoc(l) });
    }
    if ((m = path.match(/^\/policies\/([^/]+)$/))) {
      const p = world.policies[m[1]];
      return p ? kgJson({ data: { id: m[1], type: 'policies', attributes: p } }) : err(404, 'NOT_FOUND');
    }
    if (path === '/machines' && method === 'GET') {
      const items = machinesOf(u.searchParams.get('license')).filter((x) => x.fingerprint === u.searchParams.get('fingerprint'));
      return kgJson({ data: items.map(machDoc) });
    }
    if (path === '/machines' && method === 'POST') {
      const licenseId = body.data.relationships.license.data.id;
      const l = world.licenses[licenseId];
      const fp = body.data.attributes.fingerprint;
      if (machinesOf(licenseId).some((x) => x.fingerprint === fp)) return err(422, 'FINGERPRINT_TAKEN');
      if (machinesOf(licenseId).length >= l.maxMachines) return err(422, 'MACHINE_LIMIT_EXCEEDED');
      const machine = { id: randomUUID(), license: licenseId, fingerprint: fp, name: body.data.attributes.name, metadata: body.data.attributes.metadata };
      if (world.failNextMachineCreate) { world.failNextMachineCreate = false; return err(503, 'UNAVAILABLE'); }
      world.machines[machine.id] = machine;
      if (world.createTimeoutCommits) { world.createTimeoutCommits = false; throw new TypeError('timed out after commit'); }
      return kgJson({ data: machDoc(machine) }, 201);
    }
    if ((m = path.match(/^\/machines\/([^/]+)$/))) {
      const machine = world.machines[m[1]];
      if (!machine) return err(404, 'NOT_FOUND');
      if (method === 'DELETE') { delete world.machines[m[1]]; return new Response(null, { status: 204 }); }
      return kgJson({ data: machDoc(machine) });
    }
    throw new Error('Unexpected Keygen call: ' + method + ' ' + path);
  });

  world.policy = (id, attributes) => { world.policies[id] = attributes; return id; };
  world.license = (fields) => {
    const l = { id: randomUUID(), key: 'KEY-' + randomUUID().slice(0, 8).toUpperCase(), status: 'ACTIVE', expiry: null, maxMachines: 1,
      product: 'kg-product', policy: 'pol-pass-7d', metadata: { publicProductId: WEEKLY }, ...fields };
    world.licenses[l.id] = l;
    world.authority.push({ key_hash: licenceKeyHash(l.key), authority: 'keygen', public_license_id: l.metadata.publicLicenseId || l.id, keygen_license_id: l.id });
    return l;
  };
  world.policy('pol-pass-7d', { duration: 7 * DAY, expirationBasis: 'FROM_CREATION' });
  world.policy('pol-grant-7d', { duration: 7 * DAY, expirationBasis: 'FROM_FIRST_ACTIVATION' });
  return world;
}

function req(body) {
  return { method: 'POST', body, headers: { origin: 'https://ttd-info.vercel.app', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))) } };
}
function res() {
  return { statusCode: 200, headers: {}, body: undefined,
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; }, status(v) { this.statusCode = v; return this; },
    json(v) { this.body = v; return this; }, end() { return this; } };
}
async function call(handler, body) { const r = res(); await handler(req(body), r); return r; }
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();

test('keygen: a fresh pass activates and returns a Dodo-compatible, browser-bound entitlement', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const r = await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.product_id, WEEKLY);
  assert.equal(r.body.license_key_id, l.id);
  assert.equal(r.body.provider_expires_at, l.expiry);
  assert.equal(r.body.activation_limit, 1);
  const machine = Object.values(w.machines)[0];
  assert.equal(r.body.instance_id, machine.id);
  assert.equal(machine.fingerprint, installationRef(INSTALL_A));
  const claims = verifyEntitlement(r.body.entitlement_token);
  assert.equal(claims.product_id, WEEKLY);
  assert.equal(claims.installation_uuid, INSTALL_A);
  assert.equal(claims.activation_instance_id, machine.id);
  assert.equal(claims.provider_expiry, l.expiry);
  assert.ok(!w.calls.some((c) => c.includes('dodopayments')));
});

test('keygen: the same browser re-activating re-attaches to its own slot', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const first = await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
  const again = await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.instance_id, first.body.instance_id);
  assert.equal(Object.keys(w.machines).length, 1);
});

test('keygen: a second browser is told the pass is in use, and no slot is taken', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
  const r = await call(activate, { license_key: l.key, installation_uuid: INSTALL_B });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, 'activation_in_use');
  assert.equal(Object.keys(w.machines).length, 1);
});

test('keygen: a create that times out after committing is recovered, not refused', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  w.createTimeoutCommits = true;
  const r = await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 200);
  assert.equal(Object.keys(w.machines).length, 1);
});

for (const [name, fields, code] of [
  ['expired', { expiry: inDays(-1) }, 'licence_expired'],
  ['suspended', { status: 'SUSPENDED', expiry: inDays(7) }, 'licence_disabled'],
  ['wrong product', { product: 'other-product', expiry: inDays(7) }, 'licence_invalid'],
  ['unmapped public product', { metadata: {}, expiry: inDays(7) }, 'licence_invalid']
]) {
  test('keygen: a ' + name + ' key is rejected with the Dodo-era reason and takes no slot', async (t) => {
    quiet(t);
    const w = fakeWorld(t);
    const l = w.license(fields);
    const r = await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.error, code);
    assert.equal(Object.keys(w.machines).length, 0);
  });
}

test('keygen: a complimentary grant starts its 7-day clock at first activation', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ policy: 'pol-grant-7d', expiry: null });
  const r = await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 200);
  const days = (Date.parse(r.body.provider_expires_at) - Date.now()) / 864e5;
  assert.ok(days > 6.99 && days <= 7, String(days));
  assert.equal(w.licenses[l.id].expiry, r.body.provider_expires_at);
});

test('keygen: refresh re-issues for the bound browser and is terminal once an admin deactivates it', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  const auth = { license_key: l.key, instance_id: a.instance_id, entitlement_token: a.entitlement_token };
  const ok = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.instance_id, a.instance_id);

  delete w.machines[a.instance_id];
  const gone = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(gone.statusCode, 401);
  assert.deepEqual(gone.body, { ok: false, error: 'licence_invalid', provider_status: 'invalid' });
  const v = await call(validate, auth);
  assert.deepEqual(v.body, { ok: true, valid: false });
});

test('keygen: suspend makes refresh terminal; validate reports it', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  const auth = { license_key: l.key, instance_id: a.instance_id, entitlement_token: a.entitlement_token };
  assert.deepEqual((await call(validate, auth)).body, { ok: true, valid: true });
  w.licenses[l.id].status = 'SUSPENDED';
  assert.equal((await call(refresh, { ...auth, installation_uuid: INSTALL_A })).statusCode, 401);
  assert.deepEqual((await call(validate, auth)).body, { ok: true, valid: false });
});

test('keygen: deactivate frees the slot for another browser', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  const d = await call(deactivate, { license_key: l.key, instance_id: a.instance_id, entitlement_token: a.entitlement_token });
  assert.deepEqual(d.body, { ok: true });
  assert.equal(Object.keys(w.machines).length, 0);
  assert.equal((await call(activate, { license_key: l.key, installation_uuid: INSTALL_B })).statusCode, 200);
});

test('keygen: deactivate with another licence key cannot remove the machine', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const other = w.license({ expiry: inDays(7) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  const d = await call(deactivate, { license_key: other.key, instance_id: a.instance_id, entitlement_token: a.entitlement_token });
  assert.equal(d.statusCode, 401);
  assert.equal(Object.keys(w.machines).length, 1);
});

test('keygen: a Keygen outage is an availability failure, never "licence invalid"', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  w.keygenDown = true;
  process.env.LICENSING_OUTAGE_ACCESS = 'false';
  try {
    const r = await call(refresh, { license_key: l.key, instance_id: a.instance_id, entitlement_token: a.entitlement_token, installation_uuid: INSTALL_A });
    assert.equal(r.statusCode, 502);
    assert.equal(r.body.error, 'provider_unavailable');
  } finally { delete process.env.LICENSING_OUTAGE_ACCESS; }
  const act = await call(activate, { license_key: l.key, installation_uuid: INSTALL_B });
  assert.equal(act.statusCode, 502, 'a new activation is never granted during an outage');
});

test('outage grace: an activated browser keeps working on short tokens while Keygen is down, for at most 72 h', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(20) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  w.keygenDown = true;
  const body = (token) => ({ license_key: l.key, instance_id: a.instance_id, entitlement_token: token, installation_uuid: INSTALL_A });
  const g1 = await call(refresh, body(a.entitlement_token));
  assert.equal(g1.statusCode, 200);
  assert.equal(g1.body.outage_grace, true);
  assert.ok(Date.parse(g1.body.token_expires_at) - Date.now() <= 2 * 3600e3 + 5000, '2 h token');
  // A grace token whose grace started 73 h ago is not renewed.
  const claims = JSON.parse(Buffer.from(g1.body.entitlement_token.split('.')[1], 'base64url').toString());
  const old = issueEntitlement({ productId: claims.product_id, licenseKeyId: claims.license_key_id, installationUuid: INSTALL_A,
    activationInstanceId: a.instance_id, providerExpiry: claims.provider_expiry, graceSince: Math.floor(Date.now() / 1000) - 73 * 3600, seconds: 3600 }).token;
  const late = await call(refresh, body(old));
  assert.equal(late.statusCode, 502);
  // Once Keygen is back, a grace token refreshes normally (and loses the grace marker).
  w.keygenDown = false;
  const back = await call(refresh, body(g1.body.entitlement_token));
  assert.equal(back.statusCode, 200);
  assert.equal(back.body.outage_grace, undefined);
});

test('outage grace: never past the pass expiry, and not for a token from another installation', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(20) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  w.keygenDown = true;
  const expired = issueEntitlement({ productId: WEEKLY, licenseKeyId: l.id, installationUuid: INSTALL_A, activationInstanceId: a.instance_id,
    providerExpiry: new Date(Date.now() + 1000).toISOString() }, Date.now() - 3600e3).token;
  await new Promise((r) => setTimeout(r, 1100));
  const r = await call(refresh, { license_key: l.key, instance_id: a.instance_id, entitlement_token: expired, installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 502);
  const other = await call(refresh, { license_key: l.key, instance_id: a.instance_id, entitlement_token: a.entitlement_token, installation_uuid: INSTALL_B });
  assert.equal(other.statusCode, 401);
});

test('keygen: a migrated licence keeps its Dodo IDs and old entitlements refresh through the aliases', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(20), metadata: { publicProductId: WEEKLY, publicLicenseId: 'lic_migrated_1' } });
  const machine = { id: randomUUID(), license: l.id, fingerprint: installationRef(INSTALL_A), name: 'imported', metadata: { publicInstanceId: 'lki_migrated_1' } };
  w.machines[machine.id] = machine;
  w.aliases.push({ public_instance_id: 'lki_migrated_1', public_license_id: 'lic_migrated_1', keygen_machine_id: machine.id, tombstoned_at: null });
  const oldToken = issueEntitlement({ productId: WEEKLY, licenseKeyId: 'lic_migrated_1', installationUuid: INSTALL_A,
    activationInstanceId: 'lki_migrated_1', providerExpiry: l.expiry }, Date.now() - 9 * 3600e3).token;
  const r = await call(refresh, { license_key: l.key, instance_id: 'lki_migrated_1', entitlement_token: oldToken, installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.license_key_id, 'lic_migrated_1');
  assert.equal(r.body.instance_id, 'lki_migrated_1');
  assert.ok(!w.calls.some((c) => c.includes('dodopayments')));

  w.aliases[0].tombstoned_at = new Date().toISOString();
  assert.equal((await call(refresh, { license_key: l.key, instance_id: 'lki_migrated_1', entitlement_token: oldToken, installation_uuid: INSTALL_A })).statusCode, 401);
});

test('routing: with Keygen as the default, a supporter key marked "dodo" in the ledger still goes to Dodo', async (t) => {
  quiet(t);
  process.env.LICENSING_PROVIDER = 'keygen';
  try {
    const w = fakeWorld(t);
    w.authority.push({ key_hash: licenceKeyHash('SUPPORTER-KEY-1'), authority: 'dodo', public_license_id: 'lic_supporter_1', keygen_license_id: null });
    await call(activate, { license_key: 'SUPPORTER-KEY-1', installation_uuid: INSTALL_A });
    assert.ok(!w.calls.some((c) => c.includes('keygen.test')), 'never asked Keygen');
  } finally { delete process.env.LICENSING_PROVIDER; }
});

test('routing: a Dodo licence unknown to the ledger never touches Keygen', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const r = await call(activate, { license_key: 'DODO-ONLY-KEY', installation_uuid: INSTALL_A });
  assert.ok(w.calls.some((c) => c.startsWith('GET ledger.test')));
  assert.ok(!w.calls.some((c) => c.includes('keygen.test')));
  assert.notEqual(r.body.error, undefined);
});

test('routing: a ledger outage fails as unavailable instead of guessing the provider', async (t) => {
  quiet(t);
  const w = fakeWorld(t, { ledgerDown: true });
  const r = await call(activate, { license_key: 'ANY-KEY', installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.error, 'provider_unavailable');
  assert.ok(!w.calls.some((c) => c.includes('keygen.test') || c.includes('dodopayments')));
});

function migratedWithLegacyMachine(w) {
  const l = w.license({ expiry: inDays(20), metadata: { publicProductId: WEEKLY, publicLicenseId: 'lic_legacy_1' } });
  const legacy = { id: randomUUID(), license: l.id, fingerprint: 'legacy:lki_legacy_1', name: 'TTD Autofill - Chrome', metadata: { publicInstanceId: 'lki_legacy_1' } };
  w.machines[legacy.id] = legacy;
  w.aliases.push({ public_instance_id: 'lki_legacy_1', public_license_id: 'lic_legacy_1', keygen_machine_id: legacy.id, tombstoned_at: null });
  const token = issueEntitlement({ productId: WEEKLY, licenseKeyId: 'lic_legacy_1', installationUuid: INSTALL_A,
    activationInstanceId: 'lki_legacy_1', providerExpiry: l.expiry }, Date.now() - 9 * 3600e3).token;
  return { l, legacy, auth: { license_key: l.key, instance_id: 'lki_legacy_1', entitlement_token: token } };
}

test('bridge: a pre-marker Dodo activation re-binds to the browser on its first refresh', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const { l, legacy, auth } = migratedWithLegacyMachine(w);
  const r = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.instance_id, 'lki_legacy_1');
  assert.equal(r.body.license_key_id, 'lic_legacy_1');
  const machines = Object.values(w.machines).filter((m) => m.license === l.id);
  assert.equal(machines.length, 1);
  assert.equal(machines[0].fingerprint, installationRef(INSTALL_A));
  assert.equal(machines[0].metadata.publicInstanceId, 'lki_legacy_1');
  assert.ok(!w.machines[legacy.id]);
  assert.equal(w.aliases[0].keygen_machine_id, machines[0].id);
  assert.equal(w.licenses[l.id].maxMachines, 1);
  const again = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(again.statusCode, 200);
  assert.equal(Object.values(w.machines).filter((m) => m.license === l.id).length, 1);
});

test('bridge: a failed step leaves the customer working and the next refresh finishes it', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const { l, legacy, auth } = migratedWithLegacyMachine(w);
  w.failNextMachineCreate = true;
  const first = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(first.statusCode, 200, 'outage grace keeps the browser working');
  assert.equal(first.body.outage_grace, true);
  assert.ok(w.machines[legacy.id], 'placeholder kept, so the licence is not orphaned');
  assert.equal(w.licenses[l.id].maxMachines, 1, 'limit restored after the failed create');
  const second = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(second.statusCode, 200);
  assert.equal(Object.values(w.machines).filter((m) => m.license === l.id).length, 1);
});

test('bridge: an interrupted alias update never leaves the licence with an extra browser', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const { l, auth } = migratedWithLegacyMachine(w);
  l.metadata.baseMaxMachines = 1;
  w.failNextAliasPatch = true;
  const first = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(first.body.outage_grace, true, 'the browser keeps working meanwhile');
  assert.equal(w.licenses[l.id].maxMachines, 1, 'limit put back when the alias could not be repointed');
  const second = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(second.statusCode, 200);
  assert.equal(w.licenses[l.id].maxMachines, 1);
  assert.equal(Object.values(w.machines).filter((m) => m.license === l.id).length, 1);
});

test('bridge: a limit left raised by an earlier crash is restored to the recorded base, not kept', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const { l, auth } = migratedWithLegacyMachine(w);
  l.metadata.baseMaxMachines = 1;
  l.maxMachines = 2; // an earlier bridge died after raising the limit
  const r = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  assert.equal(r.statusCode, 200);
  assert.equal(w.licenses[l.id].maxMachines, 1);
});

test('bridge: a token for a different installation or Dodo instance never re-binds the slot', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const { legacy, auth } = migratedWithLegacyMachine(w);
  const stolen = await call(refresh, { ...auth, installation_uuid: INSTALL_B });
  assert.equal(stolen.statusCode, 401);
  const otherInstance = await call(refresh, { ...auth, instance_id: 'lki_other', installation_uuid: INSTALL_A });
  assert.equal(otherInstance.statusCode, 401);
  assert.ok(w.machines[legacy.id]);
  assert.equal(Object.keys(w.machines).length, 1);
});

test('cutover fence: activations and deactivations pause; refresh keeps working', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  const a = (await call(activate, { license_key: l.key, installation_uuid: INSTALL_A })).body;
  const auth = { license_key: l.key, instance_id: a.instance_id, entitlement_token: a.entitlement_token };
  process.env.LICENSING_FENCE = 'true';
  try {
    const act = await call(activate, { license_key: l.key, installation_uuid: INSTALL_B });
    assert.equal(act.statusCode, 503);
    assert.equal(act.body.error, 'provider_unavailable');
    assert.equal((await call(deactivate, auth)).statusCode, 503);
    assert.equal((await call(refresh, { ...auth, installation_uuid: INSTALL_A })).statusCode, 200);
    assert.equal(Object.keys(w.machines).length, 1);
  } finally {
    delete process.env.LICENSING_FENCE;
  }
});

test('keygen: a used slot on an expired pass says expired, not "another browser" (as the Dodo path)', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const l = w.license({ expiry: inDays(7) });
  await call(activate, { license_key: l.key, installation_uuid: INSTALL_A });
  w.licenses[l.id].expiry = inDays(-1);
  const r = await call(activate, { license_key: l.key, installation_uuid: INSTALL_B });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'licence_expired');
});

test('bridge: an expired or suspended migrated licence is refused without re-binding its slot', async (t) => {
  quiet(t);
  const w = fakeWorld(t);
  const { l, legacy, auth } = migratedWithLegacyMachine(w);
  w.licenses[l.id].status = 'SUSPENDED';
  assert.equal((await call(refresh, { ...auth, installation_uuid: INSTALL_A })).statusCode, 401);
  w.licenses[l.id].status = 'ACTIVE';
  w.licenses[l.id].expiry = inDays(-1);
  assert.equal((await call(refresh, { ...auth, installation_uuid: INSTALL_A })).statusCode, 401);
  assert.ok(w.machines[legacy.id]);
  assert.equal(w.machines[legacy.id].fingerprint, 'legacy:lki_legacy_1');
  assert.equal(w.aliasPatches || 0, 0);
});
