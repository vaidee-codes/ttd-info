#!/usr/bin/env node
// DRY RUN: turns an encrypted Dodo snapshot into a migration plan. Writes the plan
// (contains keys + emails) age-encrypted next to the snapshot, and prints counts and
// anomaly categories only (with HMAC references, never raw ids, keys or emails).
//   node plan.mjs [~/ttd-migration/dodo-snapshot-….json.age] [--payments payments.json.age]
import { createHmac } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const DIR = homedir() + '/ttd-migration';
const AGE_KEY = homedir() + '/.ttd-backup-age.key';
const DAY_MS = 86400e3;

export const TIERS = {
  pdt_0Nk4Gw67usedtjPoO6hX2: { plan: '7d', days: 7 },
  pdt_0NkvjEpCQNkDuaCT65cFV: { plan: '30d', days: 30 },
  pdt_0NkvjEr1l8rhSF6Ibxlj3: { plan: '90d', days: 90 }
};
export const SUPPORTER = 'pdt_0NjbdVzVqfSrrofI36ENV';
const INSTREF = /instref:([0-9a-f]{20})\b/;

function decrypt(file) {
  return JSON.parse(execFileSync('age', ['-d', '-i', AGE_KEY, file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
}
function encryptTo(file, value) {
  const recipient = execFileSync('age-keygen', ['-y', AGE_KEY], { encoding: 'utf8' }).trim();
  const r = spawnSync('age', ['-r', recipient, '-o', file], { input: JSON.stringify(value) });
  if (r.status !== 0) throw new Error('encrypt failed');
}
const ref = (kind, value) => createHmac('sha256', 'migration-report').update(kind + '\0' + value).digest('hex').slice(0, 12);

// Pure: one Dodo licence (+ its instances, customer, payment) → a plan entry.
export function planLicence(k, { instances = [], customer = null, payment = null, now = Date.now() } = {}) {
  const tier = TIERS[k.product_id];
  const anomalies = [];
  // Supporters stay on Dodo, but get a ledger row saying so: once Keygen is the
  // default provider, an unknown key would otherwise be sent to Keygen and refused.
  if (k.product_id === SUPPORTER) return { action: 'skip', reason: 'supporter_left_on_dodo', authority: 'dodo', key: k.key, public_license_id: k.id };
  if (!tier) return { action: 'quarantine', reason: 'unknown_product' };
  if (!k.key || k.key.length > 128) return { action: 'quarantine', reason: 'key_unusable' };
  if (payment && payment.status !== 'succeeded') return { action: 'quarantine', reason: 'payment_not_succeeded' };

  const limit = Number(k.activations_limit) || 1;
  if (instances.length > limit) anomalies.push('over_activation_limit');
  const earliest = instances.map((i) => Date.parse(i.created_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];

  let expiry = null;
  let kind = 'pass';
  if (k.expires_at) {
    expiry = k.expires_at;
  } else if (k.payment_id) {
    if (!earliest) return { action: 'quarantine', reason: 'paid_without_expiry_or_activation' };
    expiry = new Date(earliest + tier.days * DAY_MS).toISOString();
    anomalies.push('paid_expiry_from_activation');
  } else if (earliest) {
    expiry = new Date(earliest + tier.days * DAY_MS).toISOString();
  } else {
    kind = 'grant';
  }

  const machines = instances.map((i) => {
    const m = INSTREF.exec(String(i.name || ''));
    return { public_instance_id: i.id, name: String(i.name || 'Migrated browser').slice(0, 120), created_at: i.created_at,
      fingerprint: m ? m[1] : `legacy:${i.id}`, legacy: !m };
  });
  if (machines.some((m) => m.legacy)) anomalies.push('legacy_instance_without_marker');

  return {
    action: 'migrate',
    kind,
    plan: tier.plan,
    policy: `${kind === 'grant' ? 'grant' : 'pass'}-${tier.plan}`,
    key: k.key,
    public_license_id: k.id,
    public_product_id: k.product_id,
    // Dodo 'expired' is a natural expiry (kept via `expiry`); only 'disabled' is a suspension.
    status: k.status === 'disabled' ? 'SUSPENDED' : 'ACTIVE',
    expiry,
    expired: !!(expiry && Date.parse(expiry) <= now),
    max_machines: limit,
    email: customer && customer.email || null,
    dodo: { payment_id: k.payment_id || null, customer_id: k.customer_id || null, created_at: k.created_at, source: k.source || null },
    machines,
    anomalies
  };
}

export function buildPlan(snapshot, payments = null, now = Date.now()) {
  const instancesBy = new Map();
  for (const i of snapshot.instances) {
    if (!instancesBy.has(i.license_key_id)) instancesBy.set(i.license_key_id, []);
    instancesBy.get(i.license_key_id).push(i);
  }
  const customers = new Map(snapshot.customers.map((c) => [c.customer_id, c]));
  const paymentBy = payments ? new Map(payments.map((p) => [p.payment_id, p])) : null;
  const seenKeys = new Set();
  const entries = [];
  for (const k of snapshot.license_keys) {
    if (seenKeys.has(k.key)) { entries.push({ id: k.id, action: 'quarantine', reason: 'duplicate_key' }); continue; }
    seenKeys.add(k.key);
    const payment = paymentBy && k.payment_id ? paymentBy.get(k.payment_id) || { status: 'missing' } : null;
    entries.push({ id: k.id, ...planLicence(k, { instances: instancesBy.get(k.id) || [], customer: customers.get(k.customer_id), payment, now }) });
  }
  return entries;
}

export function summarise(entries) {
  const count = (f) => entries.filter(f).length;
  const tally = (list) => list.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
  const migrate = entries.filter((e) => e.action === 'migrate');
  return {
    total: entries.length,
    migrate: migrate.length,
    skip: tally(entries.filter((e) => e.action === 'skip').map((e) => e.reason)),
    quarantine: tally(entries.filter((e) => e.action === 'quarantine').map((e) => e.reason)),
    migrate_by_policy: tally(migrate.map((e) => e.policy)),
    migrate_active_unexpired: count((e) => e.action === 'migrate' && e.status === 'ACTIVE' && !e.expired),
    migrate_expired: count((e) => e.action === 'migrate' && e.expired),
    migrate_suspended: count((e) => e.action === 'migrate' && e.status === 'SUSPENDED'),
    machines: migrate.reduce((n, e) => n + e.machines.length, 0),
    live_licences_with_legacy_machines: count((e) => e.action === 'migrate' && e.status === 'ACTIVE' && !e.expired && e.machines.some((m) => m.legacy)),
    live_licences_with_marked_machines: count((e) => e.action === 'migrate' && e.status === 'ACTIVE' && !e.expired && e.machines.length && e.machines.every((m) => !m.legacy)),
    live_licences_unactivated: count((e) => e.action === 'migrate' && e.status === 'ACTIVE' && !e.expired && !e.machines.length),
    legacy_machines: migrate.reduce((n, e) => n + e.machines.filter((m) => m.legacy).length, 0),
    without_email: count((e) => e.action === 'migrate' && !e.email),
    anomalies: tally(migrate.flatMap((e) => e.anomalies)),
    quarantine_refs: entries.filter((e) => e.action === 'quarantine').slice(0, 30).map((e) => ({ ref: ref('dodo_license', e.id), reason: e.reason }))
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const snapFile = args.find((a) => a.endsWith('.age') && !a.includes('payments')) ||
    DIR + '/' + readdirSync(DIR).filter((f) => f.startsWith('dodo-snapshot-')).sort().pop();
  const payIdx = args.indexOf('--payments');
  const payments = payIdx >= 0 ? decrypt(args[payIdx + 1]) : null;
  const entries = buildPlan(decrypt(snapFile), payments);
  const planFile = snapFile.replace('dodo-snapshot-', 'migration-plan-');
  encryptTo(planFile, { schema: 1, snapshot: snapFile.split('/').pop(), payments_checked: !!payments, entries });
  console.log(JSON.stringify({ plan: planFile, payments_checked: !!payments, ...summarise(entries) }, null, 2));
}
