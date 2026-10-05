import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { fromPgError } from '../common/errors';

// DATE columns (date of birth, recall due dates) stay plain YYYY-MM-DD strings; turning them into
// JS Dates at local midnight shifts them by a day in some time zones.
types.setTypeParser(types.builtins.DATE, (v) => v);

/** A query runner bound to one transaction whose tenant is already set. */
export interface Tx {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  one<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R | undefined>;
  readonly orgId: string | null;
}

export interface TenantScope {
  orgId: string | null;
  staffId?: string | null;
  /**
   * Set only for patient-portal requests: the patients this portal identity holds live grants
   * for. Postgres then hides every other patient's rows (restrictive policy in 0006).
   */
  portalPatientIds?: readonly string[];
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Database access. All tenant work runs through tx(): it opens a transaction on the teeth_app
 * role and sets app.org_id / app.actor_id as transaction-local settings, so Postgres row-level
 * security confines every statement to that practice even if a query forgets its WHERE clause.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async tx<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A portal scope with no grants still restricts (to the nil patient), never "everything".
      const portal = scope.portalPatientIds ? `{${(scope.portalPatientIds.length ? scope.portalPatientIds : [NIL_UUID]).join(',')}}` : '';
      await client.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.portal_patients', $3, true)",
        [scope.orgId ?? '', scope.staffId ?? '', portal],
      );
      const result = await fn(wrap(client, scope.orgId));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw fromPgError(err) ?? err;
    } finally {
      client.release();
    }
  }
}

function wrap(client: PoolClient, orgId: string | null): Tx {
  // One connection runs one statement at a time; queue calls so callers may use Promise.all.
  let queue: Promise<unknown> = Promise.resolve();
  const run = (sql: string, params?: unknown[]) => {
    const next = queue.then(() => client.query(sql, params as unknown[]));
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    orgId,
    async query(sql, params) {
      return (await run(sql, params)).rows;
    },
    async one(sql, params) {
      return (await run(sql, params)).rows[0];
    },
  };
}
