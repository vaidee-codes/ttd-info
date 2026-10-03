#!/usr/bin/env node
// READ-ONLY: every Dodo payment's id + status (+ product ids), so the planner can
// refuse keys whose payment never succeeded (today's backend rejects those too).
// Writes ~/ttd-migration/dodo-payments-<ts>.json.age; prints counts only.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const KEY = readFileSync(homedir() + '/.dodoenv', 'utf8').split('\n').find((l) => l.trim()).replace(/^[^=]*=\s*/, '').replace(/^"|"$/g, '').trim();
const RECIPIENT = execFileSync('age-keygen', ['-y', homedir() + '/.ttd-backup-age.key'], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const payments = [];
for (let page = 0; ; page++) {
  let j = null;
  for (let attempt = 0; attempt < 5 && !j; attempt++) {
    const r = await fetch(`https://live.dodopayments.com/payments?page_size=100&page_number=${page}`, { headers: { Authorization: 'Bearer ' + KEY }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (r && r.ok) j = await r.json();
    else if (r && r.status !== 429 && r.status < 500) throw new Error('payments list → ' + r.status);
    else await sleep(1000 * 2 ** attempt);
  }
  const batch = (j && j.items) || [];
  for (const p of batch) payments.push({ payment_id: p.payment_id, status: p.status, currency: p.currency, created_at: p.created_at });
  if (batch.length < 100) break;
  await sleep(150);
}
const out = `${homedir()}/ttd-migration/dodo-payments-${new Date().toISOString().replace(/[:.]/g, '-')}.json.age`;
if (spawnSync('age', ['-r', RECIPIENT, '-o', out], { input: JSON.stringify(payments) }).status !== 0) throw new Error('encrypt failed');
const tally = payments.reduce((m, p) => ((m[p.status] = (m[p.status] || 0) + 1), m), {});
console.log(JSON.stringify({ file: out, payments: payments.length, by_status: tally }, null, 2));
