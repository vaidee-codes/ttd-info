#!/usr/bin/env node
// CUTOVER STEP: loads the licence_authority + instance_alias rows produced by import.mjs
// into the ttd-ledger database. Idempotent (upsert). After this, the listed Dodo licences
// are served by Keygen wherever TTD_LEDGER_URL is configured.
//   node apply-ledger-rows.mjs <ledger-rows-<target>.json.age> [--dry-run]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [file] = process.argv.slice(2);
const dry = process.argv.includes('--dry-run');
const rows = JSON.parse(execFileSync('age', ['-d', '-i', homedir() + '/.ttd-backup-age.key', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
const password = readFileSync(homedir() + '/.dbpassword', 'utf8').split('\n').find((l) => l.trim()).trim();
const conn = 'host=aws-0-ap-south-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.nfjpzkkqcfgvopijnxtj sslmode=require';

const lit = (v) => v == null ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";
const sql = ['begin;'];
for (const r of rows.licence_authority) {
  const authority = r.authority === 'dodo' ? 'dodo' : 'keygen';
  const source = authority === 'dodo' ? 'dodo-supporter' : 'dodo-migrated';
  sql.push(`insert into public.licence_authority (key_hash, authority, public_license_id, keygen_license_id, source, migrated_at) values (${lit(r.key_hash)}, '${authority}', ${lit(r.public_license_id)}, ${lit(r.keygen_license_id)}, '${source}', now())
 on conflict (key_hash) do update set authority = excluded.authority, public_license_id = excluded.public_license_id, keygen_license_id = excluded.keygen_license_id, source = excluded.source, migrated_at = now(), updated_at = now();`);
}
for (const r of rows.instance_alias) {
  sql.push(`insert into public.instance_alias (public_instance_id, public_license_id, keygen_machine_id) values (${lit(r.public_instance_id)}, ${lit(r.public_license_id)}, ${lit(r.keygen_machine_id)})
 on conflict (public_instance_id) do update set keygen_machine_id = excluded.keygen_machine_id where public.instance_alias.tombstoned_at is null;`);
}
sql.push(dry ? 'rollback;' : 'commit;');
const r = spawnSync('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql.join('\n'), env: { ...process.env, PGPASSWORD: password }, encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr.split('\n').slice(-5).join('\n')); process.exit(1); }
console.log(JSON.stringify({ mode: dry ? 'dry-run (rolled back)' : 'applied', licence_authority: rows.licence_authority.length,
  stay_on_dodo: rows.licence_authority.filter((r) => r.authority === 'dodo').length, instance_alias: rows.instance_alias.length }));
