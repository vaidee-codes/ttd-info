#!/usr/bin/env node
// Live check of /api/ops/* on the test app against production Keygen + ledger.
// Gets a short-lived admin token directly from Keygen (never through the ops login form),
// exercises offline sale / grant / lookup / reset, then deletes the Keygen licences it created.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const APP = process.argv[2] || 'https://ttd-info-keygen.vercel.app';
const env = Object.fromEntries(readFileSync(homedir() + '/.ttd-keygen-prod.env', 'utf8').split('\n').filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const KG = `https://${env.KEYGEN_HOST}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const results = [];
const say = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const kg = async (method, path, body, auth) => {
  const r = await fetch(KG + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8', Authorization: auth } });
  return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
};
const basic = 'Basic ' + Buffer.from(`${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const session = await kg('POST', '/tokens', { data: { type: 'tokens', attributes: { name: 'ops-e2e', expiry: new Date(Date.now() + 1800e3).toISOString() } } }, basic);
const TOKEN = session.json.data.attributes.token;
const ops = async (path, body, token = TOKEN) => {
  const r = await fetch(APP + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const created = [];
const tag = 'E2E' + randomBytes(4).toString('hex').toUpperCase();
try {
  say('no token → 401', (await ops('/api/ops/lookup', { query: 'x@example.com' }, null)).status === 401);
  say('bad token → 401', (await ops('/api/ops/lookup', { query: 'x@example.com' }, 'forged')).status === 401);

  const sale = { plan: '7d', kind: 'paid', method: 'upi', reference: 'UTR-' + tag, amount_inr: 99, email: `ops-${tag.toLowerCase()}@example.com`, note: 'ops e2e' };
  const a = await ops('/api/ops/offline-sale', sale);
  say('offline UPI sale issues a licence', a.status === 200 && /^TTD-/.test(a.body.license_key || ''), `HTTP ${a.status} ${a.body.message || ''}`);
  if (a.body.license_id) created.push(a.body.license_id);
  const again = await ops('/api/ops/offline-sale', sale);
  say('same sale again → same key', again.body.license_key === a.body.license_key);
  const dup = await ops('/api/ops/offline-sale', { ...sale, plan: '90d', amount_inr: 699 });
  say('reused UTR for a different sale → 409', dup.status === 409, dup.body.error);

  const g = await ops('/api/ops/offline-sale', { plan: '30d', kind: 'grant', method: 'other', reference: 'GRANT-' + tag, amount_inr: 0 });
  say('grant issues a licence', g.status === 200, `HTTP ${g.status}`);
  if (g.body.license_id) created.push(g.body.license_id);

  const act = await fetch(APP + '/api/license-activate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP },
    body: JSON.stringify({ license_key: a.body.license_key, installation_uuid: '11111111-1111-4111-8111-' + randomBytes(6).toString('hex') }) }).then((r) => r.json());
  say('offline key activates through the licence API', act.ok === true && act.product_id === 'pdt_0Nk4Gw67usedtjPoO6hX2', act.error || '');

  const byEmail = await ops('/api/ops/lookup', { query: sale.email });
  const hit = byEmail.body.results && byEmail.body.results[0];
  say('lookup by email finds it with its activation', !!hit && hit.reference === sale.reference && hit.machines.length === 1, `results ${byEmail.body.results && byEmail.body.results.length}`);
  const byKey = await ops('/api/ops/lookup', { query: a.body.license_key });
  say('lookup by key finds it', byKey.body.results && byKey.body.results.length === 1);

  const r = await ops('/api/ops/reset-activations', { license_id: a.body.license_id, reason: 'ops e2e reset' });
  say('reset frees the activation', r.status === 200 && r.body.removed === 1, `HTTP ${r.status}`);
  const after = await ops('/api/ops/lookup', { query: a.body.license_key });
  say('no activations after reset', after.body.results[0].machines.length === 0);

  // One key for several browsers.
  const multi = await ops('/api/ops/offline-sale', { plan: '7d', kind: 'paid', method: 'other', reference: 'MULTI-' + tag, amount_inr: 200, activations: 3, note: '3 passes, one key' });
  say('offline sale for 3 browsers', multi.status === 200 && multi.body.activations === 3, `HTTP ${multi.status}`);
  if (multi.body.license_id) created.push(multi.body.license_id);
  const activateOn = () => fetch(APP + '/api/license-activate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP },
    body: JSON.stringify({ license_key: multi.body.license_key, installation_uuid: '22222222-2222-4222-8222-' + randomBytes(6).toString('hex') }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const three = [await activateOn(), await activateOn(), await activateOn()];
  say('the same key activates on 3 different browsers', three.every((x) => x.status === 200 && x.body.activation_limit === 3), three.map((x) => x.status).join(','));
  const fourth = await activateOn();
  say('a 4th browser is refused', fourth.status === 409 && fourth.body.error === 'activation_in_use', `HTTP ${fourth.status}`);
  const low = await ops('/api/ops/set-activation-limit', { license_id: multi.body.license_id, activations: 2, reason: 'e2e: too low' });
  say('limit cannot go below browsers in use', low.status === 409, low.body.error);
  const raise = await ops('/api/ops/set-activation-limit', { license_id: multi.body.license_id, activations: 4, reason: 'e2e: one more pass' });
  say('limit raised to 4', raise.status === 200 && raise.body.previous === 3 && raise.body.activations === 4, `HTTP ${raise.status}`);
  say('…and the 4th browser now activates', (await activateOn()).status === 200);
} catch (e) {
  say('unexpected error', false, e.message);
} finally {
  const admin = 'Bearer ' + TOKEN;
  for (const id of created) await kg('DELETE', `/licenses/${id}`, null, admin);
  await kg('DELETE', `/tokens/${session.json.data.id}`, null, admin);
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed; Keygen test licences deleted (ledger rows tagged ${tag} remain for audit)`);
  process.exitCode = failed ? 1 : 0;
}
