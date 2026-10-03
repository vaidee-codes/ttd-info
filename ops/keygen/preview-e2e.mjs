#!/usr/bin/env node
// End-to-end check of a ttd-info PREVIEW deployment routed to Keygen.
//   node preview-e2e.mjs https://ttd-info-<hash>-….vercel.app
// Creates throwaway licences in production Keygen (admin login from ~/.ttd-keygen-prod.env),
// calls the preview's /api/license-* over HTTPS via `vercel curl` (passes Deployment
// Protection), then deletes the licences. Prints PASS/FAIL only; no keys or tokens.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Agent } from 'undici';

const noKeepAlive = new Agent({ pipelining: 0 });

const DEPLOYMENT = process.argv[2];
if (!DEPLOYMENT || /^https:\/\/ttd-info\.vercel\.app/.test(DEPLOYMENT)) {
  console.error('usage: preview-e2e.mjs <preview deployment URL> (never the production URL)');
  process.exit(2);
}
const env = Object.fromEntries(readFileSync(homedir() + '/.ttd-keygen-prod.env', 'utf8').split('\n').filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `https://${env.KEYGEN_HOST}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const policyByName = {};
const results = [];
const say = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function kg(method, path, body, auth) {
  const r = await fetch(API + path, { dispatcher: noKeepAlive, method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8', Authorization: auth } });
  return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
}

const DIRECT = /^https:\/\/ttd-info-keygen\.vercel\.app\/?$/.test(DEPLOYMENT);
function preview(path, body) {
  if (DIRECT) {
    const out = execFileSync('curl', ['-s', '-X', 'POST', DEPLOYMENT.replace(/\/$/, '') + path, '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(body), '-w', '\n%{http_code}', '--max-time', '40'], { encoding: 'utf8', timeout: 60000 });
    const lines = out.trimEnd().split('\n');
    const status = Number(lines.pop());
    let json = null;
    try { json = JSON.parse(lines.join('\n')); } catch { /* non-JSON */ }
    return { status, body: json };
  }
  const out = execFileSync('vercel', ['curl', path, '--deployment', DEPLOYMENT, '--',
    '-s', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify(body), '-w', '\n%{http_code}'],
  { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
  const lines = out.trimEnd().split('\n');
  const status = Number(lines.pop());
  let json = null;
  try { json = JSON.parse(lines.join('\n')); } catch { /* non-JSON */ }
  return { status, body: json };
}

const basic = 'Basic ' + Buffer.from(`${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const session = await kg('POST', '/tokens', { data: { type: 'tokens', attributes: { name: 'preview-e2e', expiry: new Date(Date.now() + 1800e3).toISOString() } } }, basic);
const admin = 'Bearer ' + session.json.data.attributes.token;
const created = [];
try {
  for (const p of (await kg('GET', `/policies?product=${env.KEYGEN_PRODUCT_ID}&page[size]=100&page[number]=1`, null, admin)).json.data) policyByName[p.attributes.name] = p.id;
  const licence = async (policy) => {
    const key = 'E2E-' + randomBytes(8).toString('hex').toUpperCase();
    const r = await kg('POST', '/licenses', { data: { type: 'licenses', attributes: { key, metadata: { source: 'e2e-test' } },
      relationships: { policy: { data: { type: 'policies', id: policyByName[policy] } } } } }, admin);
    created.push(r.json.data.id);
    return { key, id: r.json.data.id };
  };
  const pass = await licence('pass-7d');
  const grant = await licence('grant-30d');
  const A = '11111111-1111-4111-8111-' + randomBytes(6).toString('hex');
  const B = '22222222-2222-4222-8222-' + randomBytes(6).toString('hex');

  const a = preview('/api/license-activate', { license_key: pass.key, installation_uuid: A });
  say('activate via preview', a.status === 200 && a.body.product_id === 'pdt_0Nk4Gw67usedtjPoO6hX2' && a.body.license_key_id === pass.id,
    `HTTP ${a.status} ${a.body && (a.body.error || a.body.product_id)}`);
  const b = preview('/api/license-activate', { license_key: pass.key, installation_uuid: B });
  say('second browser → activation_in_use', b.status === 409 && b.body.error === 'activation_in_use', `HTTP ${b.status}`);
  const auth = { license_key: pass.key, instance_id: a.body.instance_id, entitlement_token: a.body.entitlement_token };
  const rf = preview('/api/license-refresh', { ...auth, installation_uuid: A });
  say('refresh via preview', rf.status === 200, `HTTP ${rf.status}`);
  const v = preview('/api/license-validate', auth);
  say('validate via preview', v.status === 200 && v.body.valid === true, `HTTP ${v.status}`);
  const g = preview('/api/license-activate', { license_key: grant.key, installation_uuid: A });
  const days = g.body && g.body.provider_expires_at ? (Date.parse(g.body.provider_expires_at) - Date.now()) / 864e5 : null;
  say('30-day grant starts at activation, maps to 30-day product', g.status === 200 && days > 29.99 && days <= 30 && g.body.product_id === 'pdt_0NkvjEpCQNkDuaCT65cFV',
    days ? days.toFixed(3) + ' days' : `HTTP ${g.status}`);
  const d = preview('/api/license-deactivate', auth);
  say('deactivate via preview', d.status === 200 && d.body.ok === true, `HTTP ${d.status}`);
  const after = preview('/api/license-refresh', { ...auth, installation_uuid: A });
  say('refresh after deactivate is terminal', after.status === 401 && after.body.provider_status === 'invalid', `HTTP ${after.status}`);
  const unknown = preview('/api/license-activate', { license_key: 'NOT-A-REAL-KEY-' + randomBytes(4).toString('hex'), installation_uuid: A });
  say('unknown key → licence_invalid', unknown.status === 400 && unknown.body.error === 'licence_invalid', `HTTP ${unknown.status}`);
} catch (error) {
  say('unexpected error', false, error.message);
} finally {
  for (const id of created) await kg('DELETE', `/licenses/${id}`, null, admin);
  await kg('DELETE', `/tokens/${session.json.data.id}`, null, admin);
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed; test licences deleted`);
  process.exitCode = failed ? 1 : 0;
}
