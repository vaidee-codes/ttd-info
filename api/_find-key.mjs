import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { PLANS } from './_dodo.mjs';
import { findLicensesByMetadata } from './_keygen.mjs';
import { insertOne, openSecret, selectMany, sha256Hex, updateWhere } from './_ledger.mjs';

export const CODE_TTL_MS = 10 * 60e3;
export const MAX_ATTEMPTS = 5;
export const MAX_CHALLENGES_PER_HOUR = 3;

export function emailHash(email) {
  return sha256Hex('find-key:' + email);
}

function codeHash(email, code) {
  const secret = String(process.env.LEDGER_ENCRYPTION_KEY || '');
  return createHmac('sha256', secret).update(`${email}|${code}`).digest('hex');
}

export function newCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function recentChallengeCount(email) {
  const since = new Date(Date.now() - 3600e3).toISOString();
  const rows = await selectMany('find_key_challenges', { select: 'id', email_hash: 'eq.' + emailHash(email), created_at: 'gte.' + since });
  return rows.length;
}

export function createChallenge(email, code) {
  return insertOne('find_key_challenges', {
    email_hash: emailHash(email), code_hash: codeHash(email, code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString()
  });
}

// Checks the newest live challenge. Each wrong guess uses an attempt; a right
// guess consumes the challenge so it cannot be replayed.
export async function verifyChallenge(email, code) {
  const [challenge] = await selectMany('find_key_challenges', {
    select: '*', email_hash: 'eq.' + emailHash(email), consumed_at: 'is.null',
    expires_at: 'gt.' + new Date().toISOString(), order: 'created_at.desc', limit: '1'
  });
  if (!challenge || challenge.attempts >= MAX_ATTEMPTS) return false;
  const expected = Buffer.from(challenge.code_hash, 'utf8');
  const given = Buffer.from(codeHash(email, code), 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    await updateWhere('find_key_challenges', { id: challenge.id, attempts: challenge.attempts }, { attempts: challenge.attempts + 1 });
    return false;
  }
  const [consumed] = await updateWhere('find_key_challenges', { id: challenge.id, consumed_at: null }, { consumed_at: new Date().toISOString() });
  return !!consumed;
}

// Licences migrated from Dodo live only in Keygen, with the buyer's email in
// their metadata (as Dodo had it, so try the address as typed and lower-cased).
async function migratedLicences(email) {
  const variants = [...new Set([email, email.toLowerCase()])];
  const seen = new Map();
  for (const variant of variants) {
    for (const license of await findLicensesByMetadata({ email: variant })) {
      const metadata = license.attributes && license.attributes.metadata || {};
      if (metadata.source === 'dodo-migrated' && !seen.has(license.id)) seen.set(license.id, license);
    }
  }
  return [...seen.values()];
}

export async function hasPurchases(email) {
  const [orders, offline] = await Promise.all([
    selectMany('orders', { select: 'id', email: 'eq.' + email, status: 'eq.fulfilled', limit: '1' }),
    selectMany('offline_sales', { select: 'id', email: 'eq.' + email, status: 'eq.provisioned', limit: '1' })
  ]);
  if (orders.length + offline.length > 0) return true;
  return (await migratedLicences(email).catch(() => [])).length > 0;
}

export async function keysForEmail(email) {
  const orders = await selectMany('orders', { select: 'id,plan,fulfilled_at', email: 'eq.' + email, status: 'eq.fulfilled', order: 'fulfilled_at.desc', limit: '20' });
  const keys = [];
  for (const order of orders) {
    const [f] = await selectMany('fulfilments', { select: 'license_key_enc', order_id: 'eq.' + order.id, status: 'eq.provisioned', limit: '1' });
    if (f) keys.push({ license_key: openSecret(f.license_key_enc), plan: order.plan, days: PLANS[order.plan] && PLANS[order.plan].days, purchased_at: order.fulfilled_at, source: 'online' });
  }
  const offline = await selectMany('offline_sales', { select: 'plan,kind,license_key_enc,provisioned_at', email: 'eq.' + email, status: 'eq.provisioned', order: 'provisioned_at.desc', limit: '20' });
  for (const sale of offline) {
    keys.push({ license_key: openSecret(sale.license_key_enc), plan: sale.plan, days: PLANS[sale.plan] && PLANS[sale.plan].days, purchased_at: sale.provisioned_at, source: sale.kind === 'grant' ? 'grant' : 'offline' });
  }
  for (const license of await migratedLicences(email).catch(() => [])) {
    const a = license.attributes || {};
    const plan = a.metadata && a.metadata.plan;
    if (!a.key || keys.some((k) => k.license_key === a.key)) continue;
    keys.push({ license_key: a.key, plan, days: PLANS[plan] && PLANS[plan].days, purchased_at: (a.metadata && a.metadata.dodoCreatedAt) || a.created || null, source: 'earlier' });
  }
  return keys;
}
