import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlan, planLicence, summarise } from '../scripts/migrate/plan.mjs';

const WEEKLY = 'pdt_0Nk4Gw67usedtjPoO6hX2';
const D30 = 'pdt_0NkvjEpCQNkDuaCT65cFV';
const SUPPORTER = 'pdt_0NjbdVzVqfSrrofI36ENV';
const NOW = Date.parse('2026-10-01T00:00:00Z');
const key = (over = {}) => ({ id: 'lic_1', key: 'ABCD-1234', status: 'active', activations_limit: 1, customer_id: 'cus_1', product_id: WEEKLY,
  payment_id: 'pay_1', expires_at: '2026-10-05T00:00:00Z', created_at: '2026-09-28T00:00:00Z', ...over });
const inst = (over = {}) => ({ id: 'lki_1', license_key_id: 'lic_1', name: 'TTD Autofill - Chrome instref:0123456789abcdef0123', created_at: '2026-09-28T01:00:00Z', ...over });

test('plan: a paid pass keeps its exact expiry, product, limit and marked activation', () => {
  const p = planLicence(key(), { instances: [inst()], customer: { email: 'a@b.com' }, payment: { status: 'succeeded' }, now: NOW });
  assert.equal(p.action, 'migrate');
  assert.equal(p.policy, 'pass-7d');
  assert.equal(p.expiry, '2026-10-05T00:00:00Z');
  assert.equal(p.public_license_id, 'lic_1');
  assert.equal(p.public_product_id, WEEKLY);
  assert.equal(p.email, 'a@b.com');
  assert.deepEqual(p.machines.map((m) => [m.public_instance_id, m.fingerprint, m.legacy]), [['lki_1', '0123456789abcdef0123', false]]);
  assert.deepEqual(p.anomalies, []);
});

test('plan: an activated complimentary key expires its tier length after activation (as today)', () => {
  const p = planLicence(key({ product_id: D30, payment_id: null, expires_at: null }), { instances: [inst()], now: NOW });
  assert.equal(p.kind, 'pass');
  assert.equal(p.expiry, new Date(Date.parse('2026-09-28T01:00:00Z') + 30 * 86400e3).toISOString());
});

test('plan: an unused complimentary key becomes a grant whose clock starts at first activation', () => {
  const p = planLicence(key({ payment_id: null, expires_at: null }), { instances: [], now: NOW });
  assert.equal(p.kind, 'grant');
  assert.equal(p.policy, 'grant-7d');
  assert.equal(p.expiry, null);
});

test('plan: supporters stay on Dodo; unknown products, failed payments and over-long keys are quarantined', () => {
  const supporter = planLicence(key({ product_id: SUPPORTER }));
  assert.deepEqual([supporter.action, supporter.reason, supporter.authority], ['skip', 'supporter_left_on_dodo', 'dodo']);
  assert.ok(supporter.key && supporter.public_license_id, 'supporter keeps its key so a Dodo routing row can be written');
  assert.equal(planLicence(key({ product_id: 'pdt_other' })).reason, 'unknown_product');
  assert.equal(planLicence(key(), { payment: { status: 'failed' } }).reason, 'payment_not_succeeded');
  assert.equal(planLicence(key({ key: 'x'.repeat(129) })).reason, 'key_unusable');
});

test('plan: a Dodo-expired key migrates active with its past expiry (not suspended)', () => {
  const p = planLicence(key({ status: 'expired', expires_at: '2026-09-01T00:00:00Z' }), { now: NOW });
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.expired, true);
});

test('plan: disabled keys migrate suspended; expired keys are flagged; pre-marker instances are legacy', () => {
  const p = planLicence(key({ status: 'disabled', expires_at: '2026-09-01T00:00:00Z' }), { instances: [inst({ name: 'TTD Autofill - Chrome' })], now: NOW });
  assert.equal(p.status, 'SUSPENDED');
  assert.equal(p.expired, true);
  assert.equal(p.machines[0].legacy, true);
  assert.equal(p.machines[0].fingerprint, 'legacy:lki_1');
  assert.ok(p.anomalies.includes('legacy_instance_without_marker'));
});

test('plan: more activations than the limit are migrated but flagged', () => {
  const p = planLicence(key(), { instances: [inst(), inst({ id: 'lki_2' })], now: NOW });
  assert.ok(p.anomalies.includes('over_activation_limit'));
  assert.equal(p.machines.length, 2);
});

test('buildPlan: joins instances and customers, refuses duplicate keys, and summarises without secrets', () => {
  const snapshot = {
    license_keys: [key(), key({ id: 'lic_2' }), key({ id: 'lic_3', key: 'OTHER', product_id: SUPPORTER })],
    instances: [inst()], customers: [{ customer_id: 'cus_1', email: 'a@b.com' }]
  };
  const entries = buildPlan(snapshot, [{ payment_id: 'pay_1', status: 'succeeded' }], NOW);
  assert.equal(entries[0].machines.length, 1);
  assert.equal(entries[1].reason, 'duplicate_key');
  const s = summarise(entries);
  assert.equal(s.migrate, 1);
  assert.deepEqual(s.skip, { supporter_left_on_dodo: 1 });
  assert.deepEqual(s.quarantine, { duplicate_key: 1 });
  assert.ok(!JSON.stringify(s).includes('ABCD-1234') && !JSON.stringify(s).includes('a@b.com') && !JSON.stringify(s).includes('lic_2'));
});
