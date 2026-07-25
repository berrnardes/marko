// Guardrail: the tenant context is set TRANSACTION-LOCAL, inside a transaction.
//
// `withOrg` has two load-bearing details, and both are invisible at the call
// site:
//
//   1. the work runs inside a transaction, and
//   2. `set_config(..., true)` — the third argument — scopes the value to that
//      transaction.
//
// Drop the `true` and the setting becomes session-level. The web app reaches
// Postgres through PgBouncer in *transaction* pooling mode, which hands the
// server connection to a different client the moment the transaction ends: one
// tenant's context would then be inherited by whoever borrows that connection
// next. That is the same cross-tenant read the whole retrofit exists to remove,
// reintroduced one layer down and far harder to spot — the code would look
// scoped and behave scoped in any single-user test.
//
// So this asserts the generated SQL rather than the behaviour: rendered through
// Drizzle's own `PgDialect`, the statement must bind the organization and pass
// `true`.

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { Database } from "@/db/client";
import { withOrg } from "@/db/with-org";

const dialect = new PgDialect();

/**
 * A fake {@link Database} that records the statements `withOrg` executes and
 * whether it opened a transaction, without touching a real connection.
 */
function recordingDb(): {
	db: Database;
	executed: { sql: string; params: unknown[] }[];
	transactions: number;
} {
	const executed: { sql: string; params: unknown[] }[] = [];
	const state = { transactions: 0 };

	const tx = {
		execute: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
			const rendered = dialect.sqlToQuery(query);
			executed.push({ sql: rendered.sql, params: rendered.params });
			return Promise.resolve({ rows: [] });
		},
	};

	const db = {
		transaction: async (fn: (t: unknown) => unknown) => {
			state.transactions += 1;
			return fn(tx);
		},
	} as unknown as Database;

	return {
		db,
		executed,
		get transactions() {
			return state.transactions;
		},
	};
}

describe("withOrg", () => {
	it("runs the callback inside a transaction", async () => {
		const recorder = recordingDb();

		await withOrg("org-a", async () => "done", recorder.db);

		expect(recorder.transactions).toBe(1);
	});

	it("sets the tenant context transaction-locally, bound as a parameter", async () => {
		const recorder = recordingDb();

		await withOrg("org-a", async () => undefined, recorder.db);

		expect(recorder.executed).toHaveLength(1);
		const [statement] = recorder.executed;

		expect(statement.sql).toContain("set_config");
		// `true` = transaction-local. Without it the value would outlive the
		// request under PgBouncer's transaction pooling and leak to the next
		// client on that connection.
		expect(statement.sql).toMatch(/set_config\(.+,\s*.+,\s*true\)/);
		// The setting name the RLS policies read through `app.current_org()`.
		expect(statement.params).toContain("app.org_id");
		// The organization is a bound parameter, never interpolated into the SQL.
		expect(statement.params).toContain("org-a");
		expect(statement.sql).not.toContain("org-a");
	});

	it("sets the context BEFORE the callback runs", async () => {
		const recorder = recordingDb();
		let contextSetWhenCallbackRan = false;

		await withOrg(
			"org-a",
			async () => {
				contextSetWhenCallbackRan = recorder.executed.length === 1;
			},
			recorder.db,
		);

		expect(contextSetWhenCallbackRan).toBe(true);
	});

	it("passes the transaction to the callback, not the pool", async () => {
		const recorder = recordingDb();
		let received: unknown;

		await withOrg(
			"org-a",
			async (tx) => {
				received = tx;
			},
			recorder.db,
		);

		// Repositories built over this handle issue their statements inside the
		// context set above; one built over the module-level `db` would not, and
		// under RLS would see nothing.
		expect(received).not.toBe(recorder.db);
		expect(received).toHaveProperty("execute");
	});

	it("propagates the callback's result", async () => {
		const recorder = recordingDb();

		const result = await withOrg("org-a", async () => ({ leads: 3 }), recorder.db);

		expect(result).toEqual({ leads: 3 });
	});
});
