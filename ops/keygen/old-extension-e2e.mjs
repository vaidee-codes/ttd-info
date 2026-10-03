#!/usr/bin/env node
// Live check that a browser activated through Dodo keeps working after the
// switch to Keygen, without the user doing anything (and across an extension
// update, which keeps chrome.storage). Builds a synthetic migrated licence
// shaped exactly like import.mjs output — one browser with the installation
// marker, one from before it (legacy) — then drives the test app with the
// tokens an old extension holds. Deletes everything afterwards.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const APP = process.argv[2] || 'https://ttd-info-keygen.vercel.app';
const ORIGIN = 'chrome-extension://piiegkjdfbbakjmjdckgdjbbohfjfolg';
const readEnv = (f) => Object.fromEntries(readFileSync(homedir() + '/' + f, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const kgEnv = readEnv('.ttd-keygen-prod.env');
const appEnv = readEnv('.ttd-info-keygen-test.env');
// The test app's signing key and correlation secret, so tokens and markers match it.
process.env.TTDAF_ENTITLEMENT_PRIVATE_KEY = appEnv.TTDAF_ENTITLEMENT_PRIVATE_KEY;
process.env.TTDAF_LOG_CORRELATION_SECRET = appEnv.TTDAF_LOG_CORRELATION_SECRET;
const { issueEntitlement } = await import('../../api/_entitlement.mjs');
const { installationRef } = await import('../../api/_dodo.mjs');

const KG = `https://${kgEnv.KEYGEN_HOST}/v1/accounts/${kgEnv.KEYGEN_ACCOUNT_ID}`;
const H = { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8' };
const kg = async (method, path, body, auth) => {
  const r = await fetch(KG + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...H, Authorization: auth } });
  return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
};
const app = async (path, body) => {
  const r = await fetch(APP + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pw = readFileSync(homedir() + '/.dbpassword', 'utf8').split('\n').find((l) => l.trim()).trim();
const psql = (sql) => { const r = spawnSync('psql', ['host=aws-0-ap-south-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.nfjpzkkqcfgvopijnxtj sslmode=require', '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], { env: { ...process.env, PGPASSWORD: pw }, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

const results = [];
const say = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const tag = randomBytes(5).toString('hex');
const key = 'SIM-OLDEXT-' + tag.toUpperCase();
const lic = 'lic_SIM' + tag, lkiA = 'lki_SIMA' + tag, lkiB = 'lki_SIMB' + tag;
const uuidA = randomUUID(), uuidB = randomUUID();
const WEEKLY = 'pdt_0Nk4Gw67usedtjPoO6hX2';
const expiry = new Date(Date.now() + 6 * 864e5).toISOString();

const basic = 'Basic ' + Buffer.from(`${kgEnv.KEYGEN_ADMIN_EMAIL}:${kgEnv.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const tok = await kg('POST', '/tokens', { data: { type: 'tokens', attributes: { name: 'old-ext-e2e', expiry: new Date(Date.now() + 1800e3).toISOString() } } }, basic);
const ADMIN = 'Bearer ' + tok.json.data.attributes.token;
let licenseId = null;
try {
  const pols = (await kg('GET', `/policies?product=${kgEnv.KEYGEN_PRODUCT_ID}&page[size]=100&page[number]=1`, null, ADMIN)).json.data;
  const policy = pols.find((p) => p.attributes.name === 'pass-7d').id;
  const l = await kg('POST', '/licenses', { data: { type: 'licenses', attributes: { key, expiry, maxMachines: 2,
    metadata: { source: 'dodo-migrated', publicLicenseId: lic, publicProductId: WEEKLY, plan: '7d', email: null, baseMaxMachines: 2, test: 'old-ext-e2e' } },
    relationships: { policy: { data: { type: 'policies', id: policy } } } } }, ADMIN);
  licenseId = l.json.data.id;
  const machine = async (fingerprint, publicInstanceId) => (await kg('POST', '/machines', { data: { type: 'machines',
    attributes: { fingerprint, name: 'TTD Autofill - MacIntel', metadata: { publicInstanceId } },
    relationships: { license: { data: { type: 'licenses', id: licenseId } } } } }, ADMIN)).json.data.id;
  const machineA = await machine(installationRef(uuidA), lkiA);   // activated with the marker
  const machineB = await machine('legacy:' + lkiB, lkiB);           // activated before the marker
  const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');
  psql(`begin;
    insert into licence_authority (key_hash, authority, public_license_id, keygen_license_id, source, migrated_at) values ('${keyHash}', 'keygen', '${lic}', '${licenseId}', 'e2e-old-extension', now());
    insert into instance_alias (public_instance_id, public_license_id, keygen_machine_id) values ('${lkiA}', '${lic}', '${machineA}'), ('${lkiB}', '${lic}', '${machineB}');
  commit;`);

  // Tokens exactly as an old extension stored them (Dodo ids), already expired as after a sleep.
  const tokenFor = (uuid, lki) => issueEntitlement({ productId: WEEKLY, licenseKeyId: lic, installationUuid: uuid, activationInstanceId: lki, providerExpiry: expiry }, Date.now() - 9 * 3600e3).token;
  const refresh = (uuid, lki, token = tokenFor(uuid, lki)) => app('/api/license-refresh', { license_key: key, installation_uuid: uuid, instance_id: lki, entitlement_token: token });

  const a = await refresh(uuidA, lkiA);
  say('marked browser refreshes after the switch', a.status === 200 && a.body.ok === true && !a.body.outage_grace, `HTTP ${a.status} ${a.body.error || ''}`);
  say('…and keeps its Dodo ids (no re-activation)', a.body.license_key_id === lic && a.body.instance_id === lkiA && a.body.product_id === WEEKLY);
  const a2 = await refresh(uuidA, lkiA, a.body.entitlement_token);
  say('…and refreshes again with the new token', a2.status === 200 && a2.body.ok === true, `HTTP ${a2.status}`);

  const b = await refresh(uuidB, lkiB);
  say('legacy browser (pre-marker) refreshes after the switch', b.status === 200 && b.body.ok === true && !b.body.outage_grace, `HTTP ${b.status} ${b.body.error || ''}`);
  const mB = (await kg('GET', `/machines?license=${licenseId}&page[size]=100&page[number]=1`, null, ADMIN)).json.data;
  const bridged = mB.find((m) => m.attributes.metadata && m.attributes.metadata.publicInstanceId === lkiB);
  say('…its slot is re-bound to this browser', !!bridged && bridged.attributes.fingerprint === installationRef(uuidB) && mB.length === 2, `machines ${mB.length}`);
  const lAfter = (await kg('GET', `/licenses/${licenseId}`, null, ADMIN)).json.data.attributes;
  say('…and the browser limit is back to 2', Number(lAfter.maxMachines) === 2, `limit ${lAfter.maxMachines}`);
  const b2 = await refresh(uuidB, lkiB, b.body.entitlement_token);
  say('…and refreshes again with the new token', b2.status === 200 && b2.body.ok === true, `HTTP ${b2.status}`);

  const v = await app('/api/license-validate', { license_key: key, instance_id: lkiA, entitlement_token: a2.body.entitlement_token });
  say('validate (autofill gate) says valid', v.status === 200 && v.body.valid === true, `HTTP ${v.status}`);
  const reAct = await app('/api/license-activate', { license_key: key, installation_uuid: uuidA, device_label: 'TTD Autofill - MacIntel' });
  say('re-entering the key on the same browser reattaches, no new slot', reAct.status === 200 && reAct.body.ok === true, `HTTP ${reAct.status} ${reAct.body.error || ''}`);
  const stolen = await refresh(uuidB, lkiA);
  say('a token for another browser is refused', stolen.status === 401, `HTTP ${stolen.status}`);
  const third = await app('/api/license-activate', { license_key: key, installation_uuid: randomUUID(), device_label: 'x' });
  say('a third browser is refused (limit 2)', third.status === 409, `HTTP ${third.status} ${third.body.error || ''}`);
  const d = await app('/api/license-deactivate', { license_key: key, installation_uuid: uuidB, instance_id: lkiB, entitlement_token: b2.body.entitlement_token });
  say('deactivate from the extension works', d.status === 200 && d.body.ok === true, `HTTP ${d.status}`);
  const after = await refresh(uuidB, lkiB, b2.body.entitlement_token);
  say('…and that browser is then signed out (terminal)', after.status === 401, `HTTP ${after.status}`);
} catch (error) {
  say('unexpected error', false, error.message);
} finally {
  if (licenseId) await kg('DELETE', `/licenses/${licenseId}`, null, ADMIN);
  try { psql(`begin; delete from instance_alias where public_license_id='${lic}'; delete from licence_authority where public_license_id='${lic}'; commit;`); } catch {}
  await kg('DELETE', `/tokens/${tok.json.data.id}`, null, ADMIN);
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed; synthetic licence and its ledger rows deleted`);
  process.exitCode = failed ? 1 : 0;
}
