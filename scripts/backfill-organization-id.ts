// Backfill `organization_id` on the domain tables (ADR-001, phase 1).
//
// Runs between the expand migration (0001, which adds the column as nullable)
// and the contract migration (which sets it NOT NULL). Until every row carries
// a tenant, the contract migration cannot apply — this script is what closes
// that gap on an existing database.
//
// Two deliberate safety properties:
//
//   - The target organization is NEVER inferred. It must be passed as
//     `--org-id=<id>`, is verified to exist, and the run is summarized and
//     confirmed before a single row is written. Picking "the first row of
//     ORDER BY created_at" would silently hand one customer's data to another.
//   - Child rows derive their tenant from their parent (messages and
//     scheduled/handoff/compliance rows from `leads`; import rows from
//     `import_reports`), so the result stays correct even if the database
//     already held more than one organization's data. Only rows whose parent
//     is itself unresolved fall back to `--org-id`.
//
// Idempotent: every statement touches only `organization_id IS NULL` rows, so
// re-running after a partial failure resumes rather than corrupts.
//
// Run with:
//   npx tsx --env-file=.env scripts/backfill-organization-id.ts --org-id=<id>
//   (add `--yes` to skip the interactive confirmation, e.g. in a deploy step)

import { createInterface } from "node:readline/promises";

import { pool } from "@/db/client";

/**
 * The backfill statements, in dependency order: parents first, so the child
 * statements below them can read the tenant their parent just received.
 *
 * `$1` is the fallback organization id in every statement. Statements that
 * derive from a parent still take it, for the orphan case (a child whose
 * parent row is missing, which the FK-less `import_rows.lead_id` allows).
 */
const BACKFILL_STEPS: readonly { table: string; sql: string }[] = [
	{
		table: "leads",
		sql: `UPDATE leads SET organization_id = $1 WHERE organization_id IS NULL`,
	},
	{
		table: "whatsapp_numbers",
		sql: `UPDATE whatsapp_numbers SET organization_id = $1 WHERE organization_id IS NULL`,
	},
	{
		table: "import_reports",
		sql: `UPDATE import_reports SET organization_id = $1 WHERE organization_id IS NULL`,
	},
	{
		table: "message_templates",
		sql: `UPDATE message_templates SET organization_id = $1 WHERE organization_id IS NULL`,
	},
	{
		table: "messages",
		sql: `UPDATE messages m SET organization_id = COALESCE(l.organization_id, $1)
		      FROM leads l WHERE m.lead_id = l.id AND m.organization_id IS NULL`,
	},
	{
		table: "scheduled_jobs",
		sql: `UPDATE scheduled_jobs j SET organization_id = COALESCE(l.organization_id, $1)
		      FROM leads l WHERE j.lead_id = l.id AND j.organization_id IS NULL`,
	},
	{
		table: "handoff_events",
		sql: `UPDATE handoff_events h SET organization_id = COALESCE(l.organization_id, $1)
		      FROM leads l WHERE h.lead_id = l.id AND h.organization_id IS NULL`,
	},
	{
		table: "compliance_records",
		sql: `UPDATE compliance_records c SET organization_id = COALESCE(l.organization_id, $1)
		      FROM leads l WHERE c.lead_id = l.id AND c.organization_id IS NULL`,
	},
	{
		table: "import_rows",
		sql: `UPDATE import_rows r SET organization_id = COALESCE(rep.organization_id, $1)
		      FROM import_reports rep WHERE r.report_id = rep.id AND r.organization_id IS NULL`,
	},
	// Orphans: import rows whose report row no longer exists. Kept as a separate
	// trailing step so the derived statement above stays the common path.
	{
		table: "import_rows (orphans)",
		sql: `UPDATE import_rows SET organization_id = $1 WHERE organization_id IS NULL`,
	},
];

/** Read `--org-id=<id>` from argv, or exit with usage. */
function readOrgId(): string {
	const flag = process.argv.find((arg) => arg.startsWith("--org-id="));
	const orgId = flag?.slice("--org-id=".length).trim();
	if (!orgId) {
		console.error(
			"Missing --org-id=<id>.\n\n" +
				"The target organization is never inferred. List the candidates with:\n" +
				"  SELECT id, name, slug, created_at FROM organization ORDER BY created_at;\n",
		);
		process.exit(1);
	}
	return orgId;
}

/** Count rows still missing a tenant, per table, before anything is written. */
async function summarize(): Promise<number> {
	let total = 0;
	console.log("\nRows missing organization_id:");
	for (const { table } of BACKFILL_STEPS) {
		// The orphan pass targets the same table as the derived pass; counting it
		// twice would double-report, so it is summarized only once.
		if (table.includes("(orphans)")) continue;
		const { rows } = await pool.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM ${table} WHERE organization_id IS NULL`,
		);
		const count = Number(rows[0].count);
		total += count;
		console.log(`  ${table.padEnd(20)} ${count}`);
	}
	console.log(`  ${"TOTAL".padEnd(20)} ${total}`);
	return total;
}

async function confirm(orgId: string, orgName: string): Promise<boolean> {
	if (process.argv.includes("--yes")) return true;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(
		`\nAssign every row above to "${orgName}" (${orgId})? [y/N] `,
	);
	rl.close();
	return answer.trim().toLowerCase() === "y";
}

async function main(): Promise<void> {
	const orgId = readOrgId();

	const { rows: orgRows } = await pool.query<{ id: string; name: string }>(
		`SELECT id, name FROM organization WHERE id = $1`,
		[orgId],
	);
	const org = orgRows[0];
	if (!org) {
		console.error(`No organization with id "${orgId}".`);
		process.exit(1);
	}

	const pending = await summarize();
	if (pending === 0) {
		console.log("\nNothing to backfill; every row already carries a tenant.");
		return;
	}

	if (!(await confirm(org.id, org.name))) {
		console.log("Aborted; no rows were written.");
		return;
	}

	// One transaction: a partial backfill would leave the contract migration
	// unable to apply and the data in a state nobody can reason about.
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		console.log("\nUpdated:");
		for (const { table, sql } of BACKFILL_STEPS) {
			const result = await client.query(sql, [orgId]);
			console.log(`  ${table.padEnd(20)} ${result.rowCount}`);
		}
		await client.query("COMMIT");
		console.log("\nBackfill committed. Safe to apply the contract migration.");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

main()
	.catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
