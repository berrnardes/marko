// Tenancy guardrail: every domain table must be scoped to an organization.
//
// The multi-tenant leak that motivated ADR-001 existed because the domain
// tables never got a tenant column while the auth tables did — a gap that
// nothing in the build could see. This test closes that: it reflects over the
// tables actually exported from `@/db/schema` and fails when one of them has
// no `organization_id`, so a new table cannot reach production unscoped.
//
// Adding a table to ORGANIZATION_SCOPE_EXEMPT is the deliberate escape hatch;
// it requires writing down why the table is safe without a tenant.

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";

/**
 * Tables that legitimately carry no `organization_id`, with the reason each is
 * safe. Anything not listed here must be tenant-scoped.
 */
const ORGANIZATION_SCOPE_EXEMPT: Readonly<Record<string, string>> = {
	// Scoped to a single user by its `user_id` primary key, and read only by the
	// verification flow for that user — never listed across a tenant.
	phone_verifications: "keyed by user_id; never queried tenant-wide",
};

/**
 * Every PgTable exported from the domain schema, keyed by its SQL name. The
 * module also exports enum tuples and helpers, so the exports are widened to
 * `unknown` before filtering — `is()` is what decides what is really a table.
 */
function domainTables(): { name: string; table: PgTable }[] {
	const exported: unknown[] = Object.values(schema);
	return exported
		.filter((value): value is PgTable => is(value, PgTable))
		.map((table) => ({ name: getTableName(table), table }));
}

describe("domain schema tenancy", () => {
	const tables = domainTables();

	it("exports at least the known domain tables", () => {
		// Guards the reflection itself: if the filter silently matched nothing,
		// every assertion below would vacuously pass.
		expect(tables.length).toBeGreaterThanOrEqual(10);
	});

	it.each(tables.map(({ name }) => name))(
		"%s is scoped to an organization",
		(name) => {
			if (name in ORGANIZATION_SCOPE_EXEMPT) return;

			const entry = tables.find((candidate) => candidate.name === name);
			const columns = getTableColumns(entry!.table);

			expect(
				Object.values(columns).some(
					(column) => column.name === "organization_id",
				),
				`Table "${name}" has no organization_id column. Domain tables must ` +
					"be tenant-scoped (ADR-001); if this one genuinely cannot be, add " +
					"it to ORGANIZATION_SCOPE_EXEMPT with the reason.",
			).toBe(true);
		},
	);

	it.each(
		tables
			.map(({ name }) => name)
			.filter((name) => !(name in ORGANIZATION_SCOPE_EXEMPT)),
	)("%s requires organization_id to be NOT NULL", (name) => {
		const entry = tables.find((candidate) => candidate.name === name);
		const column = Object.values(getTableColumns(entry!.table)).find(
			(candidate) => candidate.name === "organization_id",
		);

		expect(
			column?.notNull,
			`Table "${name}" allows a NULL organization_id, so a row can exist ` +
				"outside every tenant and escape row-level security.",
		).toBe(true);
	});

	it("does not exempt a table that no longer exists", () => {
		const names = new Set(tables.map(({ name }) => name));
		for (const exempt of Object.keys(ORGANIZATION_SCOPE_EXEMPT)) {
			expect(names, `Stale exemption for "${exempt}"`).toContain(exempt);
		}
	});
});
