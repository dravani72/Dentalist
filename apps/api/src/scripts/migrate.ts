/* Applies db/migrations/*.sql in order as teeth_owner, then loads reference data.
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --reset drop and recreate the schema first (local development only)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { DENTAL_POSITIONS } from '@teeth/shared';
import { loadConfig } from '../config';
import { loadJurisdictionRegistry } from '../telehealth/registry';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/migrations');

export async function migrate(opts: { reset?: boolean; ownerUrl?: string; quiet?: boolean } = {}) {
  const config = loadConfig();
  const client = new Client({ connectionString: opts.ownerUrl ?? config.databaseOwnerUrl });
  await client.connect();
  const log = (m: string) => !opts.quiet && console.log(m);
  try {
    if (opts.reset) {
      if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
      // Drops every object the migration role owns; extensions (created at bootstrap) stay.
      await client.query('DROP OWNED BY CURRENT_USER CASCADE');
      log('schema reset');
    }
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`applied ${f}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${f}: ${(err as Error).message}`);
      }
    }
    for (const p of DENTAL_POSITIONS) {
      await client.query(
        `INSERT INTO dental_position (id, dentition, universal, fdi, palmer, arch, quadrant, position_in_quadrant, tooth_class, name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [p.code, p.dentition, p.universal, p.fdi, p.palmer, p.arch, p.quadrant, p.positionInQuadrant, p.toothClass, p.name],
      );
    }
    log(`reference data: ${DENTAL_POSITIONS.length} dental positions`);
    const jurisdictions = await loadJurisdictionRegistry(client);
    log(`reference data: ${jurisdictions} telehealth jurisdiction slots (all disabled until reviewed)`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate({ reset: process.argv.includes('--reset') }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
