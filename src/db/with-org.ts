// Per-transaction tenant context for Row-Level Security (PR3 / ADR-004).
//
// Side-effect boundary: opens a database transaction and stamps the acting
// organization onto it, so the policies installed by `docs/ops/rls-policies.sql`
// can see which tenant a statement belongs to.
//
// Why a TRANSACTION and not a session variable: the web app reaches Postgres
// through PgBouncer in `transaction` pooling mode (`docker-compose.yml`), where
// a server connection is handed to a different client the moment a transaction
// ends. A `SET SESSION app.org_id` would therefore leak one tenant's context
// into the next request that borrowed the same connection — the same bug class
// this whole retrofit exists to remove, reintroduced one layer down.
// `set_config(..., true)` is transaction-local and dies at COMMIT/ROLLBACK.
//
// Layering: this is the DATABASE half of the tenancy story. The application
// half (repositories bound to one organization, PR2) is what actually filters
// today; RLS is the net for the query that forgets. Both are cheap, and
// neither is trusted alone.

import { sql } from "drizzle-orm";

import { db, type Database } from "@/db/client";

/**
 * The Postgres setting the RLS policies read through `app.current_org()`.
 * Changing it means changing the policies too.
 */
export const ORG_CONTEXT_SETTING = "app.org_id";

/**
 * Run `fn` inside a transaction whose tenant context is `organizationId`.
 *
 * Every statement `fn` issues through the supplied `tx` is visible to the RLS
 * policies as belonging to that organization; statements issued through any
 * OTHER handle (the module-level `db`, a second connection) are not, and under
 * RLS will see nothing. So `fn` must use the `tx` it is given:
 *
 * ```ts
 * const leads = await withOrg(organizationId, (tx) =>
 *   listLeadSummaries(organizationId, tx),
 * );
 * ```
 *
 * Keep the callback short and free of network I/O. It holds a pooled server
 * connection for its whole duration, and under PgBouncer's transaction mode a
 * long callback occupies a slot other requests are waiting for. Work that
 * sleeps or calls WAHA belongs outside — which is precisely why the worker
 * process uses a `BYPASSRLS` role instead of this helper (ADR-004).
 *
 * Safe to call before the policies exist: `set_config` on an unknown setting
 * is a no-op, so this behaves exactly like a plain transaction until
 * `rls-policies.sql` is applied.
 */
export async function withOrg<T>(
	organizationId: string,
	fn: (tx: Database) => Promise<T>,
	database: Database = db,
): Promise<T> {
	return database.transaction(async (tx) => {
		// `true` = transaction-local. Never drop it: a session-scoped value would
		// outlive the request under transaction pooling.
		await tx.execute(
			sql`select set_config(${ORG_CONTEXT_SETTING}, ${organizationId}, true)`,
		);
		return fn(tx as unknown as Database);
	});
}
