// Guardrail: every query a Drizzle repository issues is filtered by organization.
//
// The tenancy retrofit binds each repository to one `organizationId` at
// construction. The claim that makes that safe is mechanical: EVERY statement a
// repository emits must either carry `organization_id = $org` in its `WHERE`, or
// (for inserts) write `organization_id` into the row. A single method that
// forgets is a cross-tenant leak, and it is exactly the kind of omission a code
// review misses on the fifth near-identical method.
//
// Rather than assert that against a live database — which the suite does not
// have — the repositories are driven against a recording fake `Database` that
// captures the query builder's `where` conditions and inserted values. Each
// captured condition is then rendered to real SQL through Drizzle's own
// `PgDialect`, so the assertion is about the statement that WOULD be sent to
// PostgreSQL, not about how the code happens to be written.
//
// This does not replace the two-organization integration test (it cannot prove
// PostgreSQL applies the filter, only that it is sent); it is the part of that
// guarantee that runs on every commit without infrastructure.

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { Database } from "@/db/client";
import { DrizzleComplianceRepository } from "@/db/compliance-repository";
import { DrizzleHandoffRepository } from "@/db/handoff-repository";
import { DrizzleLeadRepository } from "@/db/lead-repository";
import { DrizzleMessageRepository } from "@/db/message-repository";
import { DrizzleMessageTemplateRepository } from "@/db/message-template-repository";
import { DrizzleNumberRepository } from "@/db/number-repository";
import { DrizzleScheduledJobRepository } from "@/db/scheduled-job-repository";

const ORG = "org-under-test";
const dialect = new PgDialect();

/** What one repository call sent to the database. */
interface Recorded {
	/** Rendered `WHERE` clauses, one per statement that had one. */
	wheres: { sql: string; params: unknown[] }[];
	/** Row objects passed to `.values(...)` on an insert. */
	inserted: Record<string, unknown>[];
}

/**
 * A fake {@link Database} that records instead of executing. Every builder
 * method returns the same thenable stub, so awaiting a chain resolves to `rows`
 * exactly as Drizzle would; `where` and `values` are captured along the way.
 */
function recordingDb(rows: unknown[]): { db: Database; recorded: Recorded } {
	const recorded: Recorded = { wheres: [], inserted: [] };

	const makeChain = (): Record<string, unknown> => {
		const chain: Record<string, unknown> = {
			from: () => chain,
			set: () => chain,
			returning: () => chain,
			orderBy: () => chain,
			limit: () => chain,
			for: () => chain,
			onConflictDoUpdate: () => chain,
			where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
				const query = dialect.sqlToQuery(condition);
				recorded.wheres.push({ sql: query.sql, params: query.params });
				return chain;
			},
			values: (row: Record<string, unknown>) => {
				recorded.inserted.push(row);
				return chain;
			},
			// Thenable: `await builder` yields the canned rows.
			then: (resolve: (value: unknown) => unknown) => resolve(rows),
		};
		return chain;
	};

	const db = {
		select: makeChain,
		selectDistinct: makeChain,
		insert: makeChain,
		update: makeChain,
		delete: makeChain,
		transaction: async (fn: (tx: unknown) => unknown) => fn(db),
	} as unknown as Database;

	return { db, recorded };
}

/**
 * Run `call` against a recording database and assert that every statement it
 * issued is confined to `ORG`: each `WHERE` mentions `organization_id` and binds
 * the org as a parameter, and each inserted row carries `organizationId`.
 */
async function expectScoped(
	call: (db: Database) => Promise<unknown>,
	rows: unknown[] = [],
): Promise<void> {
	const { db, recorded } = recordingDb(rows);
	await call(db);

	expect(
		recorded.wheres.length + recorded.inserted.length,
		"the call issued no statement — the fake did not capture anything",
	).toBeGreaterThan(0);

	for (const where of recorded.wheres) {
		expect(where.sql).toContain('"organization_id"');
		expect(where.params).toContain(ORG);
	}
	for (const row of recorded.inserted) {
		expect(row).toHaveProperty("organizationId", ORG);
	}
}

// A lead row shaped enough for `toSnapshot`, and a number row for the anti-ban
// counter path; both only need the columns the mappers read.
const LEAD_ROW = {
	id: "lead-1",
	organizationId: ORG,
	phoneE164: "+5547996334573",
	source: "csv",
	displayName: null,
	lifecycleState: "IN_CADENCE",
	optInStatus: "opt_in",
	optInAt: null,
	blocked: false,
	unreachableAt: null,
	segment: null,
	creditValue: null,
	objective: null,
	hasLanceReserve: null,
	income: null,
	assignedConsultantId: null,
	lastOutboundAt: null,
	lastInboundAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
};

const NUMBER_ROW = {
	id: "num-1",
	organizationId: ORG,
	sessionName: "default",
	msisdn: "5547999999999",
	blocked: false,
	dailySent: 3,
	dailyCounterDate: "2026-07-25",
	warmupStartDate: "2026-07-01",
	createdAt: new Date(),
};

describe("DrizzleLeadRepository is confined to its organization", () => {
	const repo = (db: Database) => new DrizzleLeadRepository(ORG, db);

	it("findById", () =>
		expectScoped((db) => repo(db).findById("lead-1"), [LEAD_ROW]));
	it("findByPhone", () =>
		expectScoped((db) => repo(db).findByPhone("+5547996334573"), [LEAD_ROW]));
	it("create", () =>
		expectScoped(
			(db) => repo(db).create({ phoneE164: "+5511999999999", source: "csv" }),
			[LEAD_ROW],
		));
	it("updateQualification", () =>
		expectScoped(
			(db) => repo(db).updateQualification("lead-1", { income: 9000 }),
			[LEAD_ROW],
		));
	it("updateLifecycleState", () =>
		expectScoped(
			(db) => repo(db).updateLifecycleState("lead-1", "IN_CADENCE", "REPLIED"),
			[LEAD_ROW],
		));
	it("setOptInStatus", () =>
		expectScoped((db) => repo(db).setOptInStatus("lead-1", "opt_out", new Date())));
	it("setBlocked", () => expectScoped((db) => repo(db).setBlocked("lead-1", true)));
	it("markUnreachable", () =>
		expectScoped((db) => repo(db).markUnreachable("lead-1", new Date())));
	it("assignConsultant", () =>
		expectScoped((db) => repo(db).assignConsultant("lead-1", "user-1")));
});

describe("DrizzleMessageRepository is confined to its organization", () => {
	const repo = (db: Database) => new DrizzleMessageRepository(ORG, db);
	const MESSAGE_ROW = {
		id: "msg-1",
		organizationId: ORG,
		leadId: "lead-1",
		direction: "inbound",
		content: "oi",
		waMessageId: "wamid-1",
		numberId: null,
		createdAt: new Date(),
	};

	it("append", () =>
		expectScoped(
			(db) =>
				repo(db).append({
					leadId: "lead-1",
					direction: "inbound",
					content: "oi",
					createdAt: new Date(),
				}),
			[MESSAGE_ROW],
		));
	it("listByLead", () =>
		expectScoped((db) => repo(db).listByLead("lead-1"), [MESSAGE_ROW]));
	it("findByWaMessageId", () =>
		expectScoped((db) => repo(db).findByWaMessageId("wamid-1"), [MESSAGE_ROW]));
});

describe("DrizzleScheduledJobRepository is confined to its organization", () => {
	const repo = (db: Database) => new DrizzleScheduledJobRepository(ORG, db);
	const JOB_ROW = {
		id: "row-1",
		organizationId: ORG,
		leadId: "lead-1",
		jobKind: "cadence",
		touch: "T1",
		pgbossJobId: "pgboss-1",
		plannedFor: new Date(),
		status: "pending",
	};

	it("create", () =>
		expectScoped(
			(db) =>
				repo(db).create({
					leadId: "lead-1",
					jobKind: "cadence",
					touch: "T1",
					pgbossJobId: "pgboss-1",
					plannedFor: new Date(),
				}),
			[JOB_ROW],
		));
	it("listByLead (no status filter)", () =>
		expectScoped((db) => repo(db).listByLead("lead-1"), [JOB_ROW]));
	it("listByLead (status filter)", () =>
		expectScoped((db) => repo(db).listByLead("lead-1", "pending"), [JOB_ROW]));
	it("updateStatus", () =>
		expectScoped((db) => repo(db).updateStatus("row-1", "done")));
	it("cancelAllForLead", () =>
		expectScoped((db) => repo(db).cancelAllForLead("lead-1"), []));
});

describe("DrizzleNumberRepository is confined to its organization", () => {
	const repo = (db: Database) => new DrizzleNumberRepository(ORG, db);

	it("findById", () =>
		expectScoped((db) => repo(db).findById("num-1"), [NUMBER_ROW]));
	it("listAll", () => expectScoped((db) => repo(db).listAll(), [NUMBER_ROW]));
	it("listAvailable", () =>
		expectScoped((db) => repo(db).listAvailable(), [NUMBER_ROW]));
	it("insert", () =>
		expectScoped(
			(db) => repo(db).insert({ sessionName: "s1", msisdn: "5547999999999" }),
			[NUMBER_ROW],
		));
	it("delete", () => expectScoped((db) => repo(db).delete("num-1")));
	it("setBlocked", () => expectScoped((db) => repo(db).setBlocked("num-1", true)));
	it("incrementDailySent", () =>
		expectScoped(
			(db) => repo(db).incrementDailySent("num-1", new Date()),
			[NUMBER_ROW],
		));
	it("resetDailyCounter", () =>
		expectScoped((db) => repo(db).resetDailyCounter("num-1", new Date())));
});

describe("DrizzleComplianceRepository is confined to its organization", () => {
	const repo = (db: Database) => new DrizzleComplianceRepository(ORG, db);
	const ROW = {
		id: "c-1",
		organizationId: ORG,
		leadId: "lead-1",
		optInStatus: "opt_out",
		recordedAt: new Date(),
	};

	it("appendRecord", () =>
		expectScoped(
			(db) => repo(db).appendRecord("lead-1", "opt_out", new Date()),
			[ROW],
		));
	it("listByLead", () => expectScoped((db) => repo(db).listByLead("lead-1"), [ROW]));
});

describe("DrizzleHandoffRepository is confined to its organization", () => {
	const repo = (db: Database) => new DrizzleHandoffRepository(ORG, db);
	const ROW = {
		id: "h-1",
		organizationId: ORG,
		leadId: "lead-1",
		reason: "replied",
		createdAt: new Date(),
	};

	it("appendEvent", () =>
		expectScoped(
			(db) => repo(db).appendEvent("lead-1", "replied", new Date()),
			[ROW],
		));
	it("listByLead", () => expectScoped((db) => repo(db).listByLead("lead-1"), [ROW]));
});

describe("DrizzleMessageTemplateRepository is confined to its organization", () => {
	const repo = (db: Database) => new DrizzleMessageTemplateRepository(ORG, db);

	it("getAll", () => expectScoped((db) => repo(db).getAll(), []));
	it("upsert", () => expectScoped((db) => repo(db).upsert("T1", "novo corpo")));
	it("reset", () => expectScoped((db) => repo(db).reset("T1")));
});
