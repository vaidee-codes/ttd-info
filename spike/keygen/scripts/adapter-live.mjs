#!/usr/bin/env node
// Runs the real /api/license-* handlers against the live spike Keygen.
// Creates a throwaway product/policies/licences with the admin login from
// ~/.keygen-spike.env, exercises activate/refresh/validate/deactivate, then
// deletes everything. Prints PASS/FAIL only; never prints keys or tokens.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const env = Object.fromEntries(readFileSync(homedir() + '/.keygen-spike.env', 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = 'https://' + env.KEYGEN_HOST;
const API = `${BASE}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const WEEKLY = 'pdt_0Nk4Gw67usedtjPoO6hX2';
const INSTALL_A = '11111111-1111-4111-8111-' + randomBytes(6).toString('hex');
const INSTALL_B = '22222222-2222-4222-8222-' + randomBytes(6).toString('hex');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const realFetch = globalThis.fetch;
async function admin(method, path, body, token) {
  const r = await realFetch(API + path, { method, headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json',
    'Keygen-Version': '1.8', Authorization: token } , body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
}

const basic = 'Basic ' + Buffer.from(`${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const tok = await admin('POST', '/tokens', { data: { type: 'tokens', attributes: { name: 'adapter-live', expiry: new Date(Date.now() + 3600e3).toISOString() } } }, basic);
const adminToken = 'Bearer ' + tok.json.data.attributes.token;
const created = { product: null, policies: [], licenses: [] };

try {
  const product = await admin('POST', '/products', { data: { type: 'products', attributes: { name: 'adapter-live', distributionStrategy: 'CLOSED' } } }, adminToken);
  created.product = product.json.data.id;
  const policy = async (name, basis) => {
    const r = await admin('POST', '/policies', { data: { type: 'policies', attributes: { name, duration: 7 * 86400, maxMachines: 1, floating: true,
      expirationBasis: basis, machineUniquenessStrategy: 'UNIQUE_PER_LICENSE', overageStrategy: 'NO_OVERAGE', authenticationStrategy: 'LICENSE' },
      relationships: { product: { data: { type: 'products', id: created.product } } } } }, adminToken);
    created.policies.push(r.json.data.id);
    return r.json.data.id;
  };
  const pass = await policy('pass-7d', 'FROM_CREATION');
  const grant = await policy('grant-7d', 'FROM_FIRST_ACTIVATION');
  const licence = async (policyId) => {
    const key = 'LIVE-' + randomBytes(8).toString('hex').toUpperCase();
    const r = await admin('POST', '/licenses', { data: { type: 'licenses', attributes: { key, metadata: { publicProductId: WEEKLY } },
      relationships: { policy: { data: { type: 'policies', id: policyId } } } } }, adminToken);
    created.licenses.push(r.json.data.id);
    return { key, id: r.json.data.id };
  };
  const passLic = await licence(pass);
  const grantLic = await licence(grant);
  const ptok = await admin('POST', `/products/${created.product}/tokens`, { data: { type: 'tokens', attributes: { name: 'adapter-live' } } }, adminToken);

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  Object.assign(process.env, {
    TTDAF_ENTITLEMENT_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
    TTDAF_LOG_CORRELATION_SECRET: 'adapter-live-' + randomBytes(4).toString('hex'),
    KEYGEN_API_URL: BASE, KEYGEN_ACCOUNT_ID: env.KEYGEN_ACCOUNT_ID,
    KEYGEN_PRODUCT_TOKEN: ptok.json.data.attributes.token, KEYGEN_PRODUCT_ID: created.product,
    LICENSING_PROVIDER: 'keygen'
  });
  delete process.env.TTD_LEDGER_URL;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  console.log = () => {};
  const activate = (await import('../../../api/license-activate.mjs')).default;
  const refresh = (await import('../../../api/license-refresh.mjs')).default;
  const validate = (await import('../../../api/license-validate.mjs')).default;
  const deactivate = (await import('../../../api/license-deactivate.mjs')).default;
  const { verifyEntitlement } = await import('../../../api/_entitlement.mjs');
  const call = async (handler, body) => {
    const r = { statusCode: 200, body: undefined, setHeader() {}, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
    await handler({ method: 'POST', body, headers: { origin: 'https://ttd-info.vercel.app', 'content-length': String(JSON.stringify(body).length) } }, r);
    return r;
  };
  const out = (...a) => process.stdout.write(a.join(' ') + '\n');
  const say = (name, ok, detail) => { results.push(ok); out(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

  const a = await call(activate, { license_key: passLic.key, installation_uuid: INSTALL_A });
  const claims = a.body && a.body.entitlement_token ? verifyEntitlement(a.body.entitlement_token) : {};
  say('activate (live Keygen)', a.statusCode === 200 && claims.product_id === WEEKLY && a.body.license_key_id === passLic.id, `HTTP ${a.statusCode} ${a.body && a.body.error || ''}`);
  const again = await call(activate, { license_key: passLic.key, installation_uuid: INSTALL_A });
  say('same browser re-activates onto its own slot', again.statusCode === 200 && again.body.instance_id === a.body.instance_id, `HTTP ${again.statusCode}`);
  const b = await call(activate, { license_key: passLic.key, installation_uuid: INSTALL_B });
  say('second browser → activation_in_use', b.statusCode === 409 && b.body.error === 'activation_in_use', `HTTP ${b.statusCode} ${b.body.error}`);
  const auth = { license_key: passLic.key, instance_id: a.body.instance_id, entitlement_token: a.body.entitlement_token };
  const rf = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  say('refresh re-issues', rf.statusCode === 200 && rf.body.provider_expires_at === a.body.provider_expires_at, `HTTP ${rf.statusCode}`);
  const v = await call(validate, auth);
  say('validate → valid', v.body && v.body.valid === true, JSON.stringify(v.body));
  const g = await call(activate, { license_key: grantLic.key, installation_uuid: INSTALL_A });
  const gdays = g.body && g.body.provider_expires_at ? (Date.parse(g.body.provider_expires_at) - Date.now()) / 864e5 : null;
  say('grant clock starts at first activation (adapter PATCH)', g.statusCode === 200 && gdays > 6.99 && gdays <= 7, gdays ? gdays.toFixed(4) + ' days' : `HTTP ${g.statusCode} ${g.body && g.body.error}`);
  const d = await call(deactivate, auth);
  say('deactivate', d.statusCode === 200 && d.body.ok === true, `HTTP ${d.statusCode}`);
  const after = await call(refresh, { ...auth, installation_uuid: INSTALL_A });
  say('refresh after deactivate is terminal', after.statusCode === 401 && after.body.provider_status === 'invalid', `HTTP ${after.statusCode}`);
  const b2 = await call(activate, { license_key: passLic.key, installation_uuid: INSTALL_B });
  say('freed slot → second browser activates', b2.statusCode === 200, `HTTP ${b2.statusCode}`);
  await admin('POST', `/licenses/${passLic.id}/actions/suspend`, null, adminToken);
  const s = await call(refresh, { license_key: passLic.key, instance_id: b2.body.instance_id, entitlement_token: b2.body.entitlement_token, installation_uuid: INSTALL_B });
  say('suspended licence → refresh terminal', s.statusCode === 401, `HTTP ${s.statusCode}`);
} catch (error) {
  check('unexpected error', false, error.message);
} finally {
  for (const id of created.licenses) await admin('DELETE', `/licenses/${id}`, null, adminToken);
  for (const id of created.policies) await admin('DELETE', `/policies/${id}`, null, adminToken);
  if (created.product) await admin('DELETE', `/products/${created.product}`, null, adminToken);
  await admin('DELETE', `/tokens/${tok.json.data.id}`, null, adminToken);
  const failed = results.filter((x) => !x).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} passed; cleaned up\n`);
  process.exitCode = failed ? 1 : 0;
}
