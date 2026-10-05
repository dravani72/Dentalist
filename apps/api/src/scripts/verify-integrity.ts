/* Nightly integrity job (architecture plan, HIPAA "Integrity" control):
 *   1. re-walks every tenant's audit hash chain;
 *   2. re-verifies every signed encounter version: payload hash, signature, and that each
 *      attested entry still matches its row.
 * Exits non-zero on any finding so the scheduler raises an alert.
 *   npm run verify:integrity
 */
import 'reflect-metadata';
import { Client } from 'pg';
import { loadConfig } from '../config';
import { createApp } from '../main';
import { DbService } from '../db/db.service';
import { SigningService } from '../charting/signing.service';

async function main() {
  const config = loadConfig();
  const owner = new Client({ connectionString: config.databaseOwnerUrl });
  await owner.connect();
  let problems = 0;
  const chains = await owner.query<{ chain_id: string }>('SELECT DISTINCT chain_id FROM audit_event');
  for (const { chain_id } of chains.rows) {
    const broken = await owner.query<{ seq: string | null }>('SELECT audit_verify_chain($1) AS seq', [chain_id]);
    if (broken.rows[0]!.seq) {
      problems++;
      console.log(`audit chain ${chain_id}: broken at seq ${broken.rows[0]!.seq}`);
    }
  }
  console.log(`audit chains checked: ${chains.rowCount}`);

  const app = await createApp({ config: { devTools: false } });
  await app.init();
  const db = app.get(DbService);
  const signing = app.get(SigningService);
  const encounters = await owner.query<{ id: string; org_id: string }>('SELECT DISTINCT encounter_id AS id, org_id FROM encounter_version');
  for (const e of encounters.rows) {
    const r = await db.tx({ orgId: e.org_id }, (tx) => signing.verifyIntegrity(tx, e.id));
    if (!r.ok) {
      problems += r.issues.length;
      for (const i of r.issues) console.log(`encounter ${e.id}: ${i}`);
    }
  }
  console.log(`signed encounters checked: ${encounters.rowCount}`);
  await app.close();
  await owner.end();
  if (problems) {
    console.log(`${problems} integrity problem(s) found`);
    process.exit(2);
  }
  console.log('integrity OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
