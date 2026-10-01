#!/usr/bin/env node
// Removes TEST data from the production ledger and production Keygen — and only
// test data. Safe to run at any time, including after real (live) sales:
//   • an order is deleted only if it was taken in Razorpay TEST mode
//     (orders.razorpay_mode = 'test', or — for rows from before that column —
//     Razorpay's TEST account recognises its payment/order);
//   • an offline sale is deleted only if its reference carries an automated-test
//     tag (E2E… / SES…), or its id is passed with --offline <id,id>;
//   • migrated (Dodo) licences and their ledger rows are never touched.
//   node cleanup-test-data.mjs                     # report only
//   node cleanup-test-data.mjs --confirm           # delete
//   node cleanup-test-data.mjs --offline <ids> …   # also delete these offline sales
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const CONFIRM = process.argv.includes('--confirm');
const offlineArg = process.argv.indexOf('--offline');
const EXTRA_OFFLINE = new Set(offlineArg > 0 ? String(process.argv[offlineArg + 1] || '').split(',').filter(Boolean) : []);
const TEST_REFERENCE = /^(UTR-|GRANT-|MULTI-)?(E2E|SES)[0-9A-F]{8,}$/;

const password = readFileSync(homedir() + '/.dbpassword', 'utf8').split('\n').find((l) => l.trim()).trim();
const conn = 'host=aws-0-ap-south-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.nfjpzkkqcfgvopijnxtj sslmode=require';
const psql = (sql) => {
  const r = spawnSync('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '\t', '-c', sql], { env: { ...process.env, PGPASSWORD: password }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').pop());
  return r.stdout.trim();
};
const rows = (sql) => { const out = psql(sql); return out ? out.split('\n').map((l) => l.split('\t')) : []; };
const lit = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const list = (values) => values.length ? values.map(lit).join(',') : 'null';

// Razorpay TEST account: a payment/order it knows is test money by definition.
const rzpEnv = Object.fromEntries(readFileSync(homedir() + '/.razorpay-test.env', 'utf8').split('\n')
  .map((l) => /^\s*([a-z_]+)\s*=\s*"?([^"\s]*)"?/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
if (!String(rzpEnv.api_key || '').startsWith('rzp_test_')) { console.error('~/.razorpay-test.env must hold the TEST key (rzp_test_…).'); process.exit(1); }
const rzpAuth = 'Basic ' + Buffer.from(`${rzpEnv.api_key}:${rzpEnv.api_secret}`).toString('base64');
async function knownToTestAccount(path) {
  const r = await fetch('https://api.razorpay.com/v1/' + path, { headers: { Authorization: rzpAuth }, signal: AbortSignal.timeout(15000) });
  if (r.status === 200) return true;
  if (r.status === 400 || r.status === 404) return false;
  throw new Error(`Razorpay answered ${r.status}; not guessing — try again.`);
}

const env = Object.fromEntries(readFileSync(homedir() + '/.ttd-keygen-prod.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = `https://${env.KEYGEN_HOST}/v1/accounts/${env.KEYGEN_ACCOUNT_ID}`;
const kg = async (method, path, auth, body) => {
  const r = await fetch(API + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Keygen-Version': '1.8', Authorization: auth } });
  return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
};

// ---- decide what is test data ----------------------------------------------
const orders = rows('select id, coalesce(razorpay_mode, \'\'), coalesce(razorpay_order_id, \'\'), coalesce(razorpay_payment_id, \'\'), status from orders');
const testOrders = [];
const keptOrders = [];
for (const [id, mode, rzpOrder, rzpPayment, status] of orders) {
  let isTest = mode === 'test';
  if (!mode) {
    if (rzpPayment) isTest = await knownToTestAccount('payments/' + rzpPayment);
    else if (rzpOrder) isTest = await knownToTestAccount('orders/' + rzpOrder);
    else isTest = status === 'created'; // never reached Razorpay: no money involved
  }
  (isTest ? testOrders : keptOrders).push(id);
}
const sales = rows('select id, reference, kind from offline_sales');
const testSales = sales.filter(([id, ref]) => TEST_REFERENCE.test(ref) || EXTRA_OFFLINE.has(id)).map(([id]) => id);
const keptSales = sales.filter(([id]) => !testSales.includes(id));

const licenceIds = [
  ...rows(`select keygen_license_id from fulfilments where order_id in (${list(testOrders)}) and keygen_license_id is not null`).map((r) => r[0]),
  ...rows(`select keygen_license_id from offline_sales where id in (${list(testSales)}) and keygen_license_id is not null`).map((r) => r[0])
];
const protectedIds = new Set(rows("select keygen_license_id from licence_authority where source in ('dodo-migrated','dodo-supporter') and keygen_license_id is not null").map((r) => r[0]));
const deletable = licenceIds.filter((id) => !protectedIds.has(id));

console.log(JSON.stringify({
  mode: CONFIRM ? 'deleting' : 'report only',
  orders: { test: testOrders.length, kept_live_or_unknown: keptOrders.length },
  offline_sales: { test: testSales.length, kept: keptSales.map(([id, ref, kind]) => ({ id, reference: ref, kind })) },
  keygen_licences_to_delete: deletable.length
}, null, 2));
if (!CONFIRM) process.exit(0);

// ---- delete -----------------------------------------------------------------
const basic = 'Basic ' + Buffer.from(`${env.KEYGEN_ADMIN_EMAIL}:${env.KEYGEN_ADMIN_PASSWORD}`).toString('base64');
const session = await kg('POST', '/tokens', basic, { data: { type: 'tokens', attributes: { name: 'cleanup', expiry: new Date(Date.now() + 1800e3).toISOString() } } });
const ADMIN = 'Bearer ' + session.json.data.attributes.token;
let keygenDeleted = 0;
for (const id of deletable) {
  const r = await kg('DELETE', `/licenses/${id}`, ADMIN);
  if (r.status === 204 || r.status === 404) keygenDeleted++;
}
await kg('DELETE', `/tokens/${session.json.data.id}`, ADMIN).catch(() => {});

const o = list(testOrders);
const s = list(testSales);
psql(`begin;
  delete from email_outbox where order_id in (${o}) or offline_sale_id in (${s});
  delete from invoices where order_id in (${o}) or offline_sale_id in (${s});
  delete from fulfilments where order_id in (${o});
  delete from payment_events where razorpay_order_id in (select razorpay_order_id from orders where id in (${o}));
  delete from orders where id in (${o});
  delete from offline_sales where id in (${s});
  delete from licence_authority where keygen_license_id in (${list(deletable)}) and source not in ('dodo-migrated','dodo-supporter');
  delete from find_key_challenges where created_at < now() - interval '1 day';
  -- Invoice numbering: continue from the highest invoice that remains (0 if none).
  update invoice_counters c set last = coalesce((select max(seq) from invoices i where i.fy = c.fy), 0);
commit;`);
psql("insert into audit_events(actor, action, detail) values ('system', 'test_data_removed', " +
  `${lit(JSON.stringify({ orders: testOrders.length, offline_sales: testSales.length, keygen_licences: keygenDeleted }))}::jsonb)`);
console.log(JSON.stringify({ deleted: { orders: testOrders.length, offline_sales: testSales.length, keygen_licences: keygenDeleted } }));
