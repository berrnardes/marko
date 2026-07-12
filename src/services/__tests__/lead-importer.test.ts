// Unit tests for the Lead_Importer CSV intake (task 15.1).
//
// These exercise the design's importer pipeline against in-memory fakes: phone
// normalization of each row (Req 1.2), rejection of unnormalizable rows with a
// row number + reason (Req 1.3), deduplication by normalized number that counts
// a match as `updated` without creating a duplicate (Req 1.4), creation of new
// Leads in `COLD_QUEUED` recording the source (Req 1.5, 2.1), enrollment of new
// Leads through the injected `CadenceScheduler` (Req 2.3), and the
// created/updated/rejected report accounting (Req 1.6). The named property tests
// (Properties 2 and 3, tasks 15.2/15.3) are separate optional tasks and are not
// implemented here.

import type { Clock, LeadSnapshot } from "@/core/types";
import type {
	CadenceSchedule,
	CadenceScheduler,
} from "@/services/cadence-scheduler";
import { createLeadImporter } from "@/services/lead-importer";
import type { LeadRepository, NewLeadInput } from "@/services/repositories";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Test fixtures / fakes
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-03-10T13:00:00.000Z");
const clock: Clock = { now: () => FIXED_NOW };

/** Build a `COLD_QUEUED` snapshot for a freshly-created Lead. */
function newSnapshot(id: string, input: NewLeadInput): LeadSnapshot {
	return {
		id,
		phoneE164: input.phoneE164,
		source: input.source,
		displayName: input.displayName ?? null,
		lifecycleState: "COLD_QUEUED",
		optInStatus: "opt_in",
		optInAt: null,
		score: 0,
		blocked: false,
		unreachableAt: null,
		classificationBand: null,
		qualification: {
			segment: null,
			creditValue: null,
			objective: null,
			hasLanceReserve: null,
			income: null,
		},
		assignedConsultantId: null,
		lastOutboundAt: null,
		lastInboundAt: null,
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
	};
}

/**
 * An in-memory `LeadRepository` covering exactly what the importer touches:
 * `findByPhone` (dedup lookup) and `create` (new Lead in `COLD_QUEUED`). The
 * remaining methods are present as spies but unused by the importer.
 */
function makeLeadRepo(): {
	repo: LeadRepository;
	creates: NewLeadInput[];
	byPhone: Map<string, LeadSnapshot>;
} {
	const byPhone = new Map<string, LeadSnapshot>();
	const creates: NewLeadInput[] = [];
	let seq = 0;

	const repo = {
		findById: vi.fn(),
		findByPhone: vi.fn(
			async (phoneE164: string) => byPhone.get(phoneE164) ?? null,
		),
		create: vi.fn(async (input: NewLeadInput) => {
			creates.push(input);
			seq += 1;
			const snapshot = newSnapshot(`lead-${seq}`, input);
			byPhone.set(input.phoneE164, snapshot);
			return snapshot;
		}),
		updateQualification: vi.fn(),
		updateScore: vi.fn(),
		updateLifecycleState: vi.fn(),
		setOptInStatus: vi.fn(),
		setBlocked: vi.fn(),
		assignConsultant: vi.fn(),
	} as unknown as LeadRepository;

	return { repo, creates, byPhone };
}

/** A `CadenceScheduler` recording the lead ids it was asked to enroll. */
function makeCadence(): { scheduler: CadenceScheduler; enrolled: string[] } {
	const enrolled: string[] = [];
	const scheduler: CadenceScheduler = {
		enroll: vi.fn(async (leadId: string): Promise<CadenceSchedule[]> => {
			enrolled.push(leadId);
			return [];
		}),
		cancelAll: vi.fn(async () => 0),
	};
	return { scheduler, enrolled };
}

function buf(csv: string): Buffer {
	return Buffer.from(csv, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LeadImporter.import", () => {
	let leadRepo: ReturnType<typeof makeLeadRepo>;
	let cadence: ReturnType<typeof makeCadence>;

	beforeEach(() => {
		leadRepo = makeLeadRepo();
		cadence = makeCadence();
	});

	function importer(phoneColumnAliases?: readonly string[]) {
		return createLeadImporter({
			leads: leadRepo.repo,
			cadence: cadence.scheduler,
			clock,
			phoneColumnAliases,
		});
	}

	it("creates new Leads in COLD_QUEUED, records the source, and enrolls them (Req 1.2, 1.5, 2.1, 2.3)", async () => {
		const csv = "telefone\n(11) 98765-4321\n11912345678\n";
		const report = await importer().import(buf(csv), "csv");

		// Both numbers normalized to E.164 and created with the import source. No
		// name column present, so no name is captured.
		expect(leadRepo.creates).toEqual([
			{ phoneE164: "+5511987654321", source: "csv", displayName: null },
			{ phoneE164: "+5511912345678", source: "csv", displayName: null },
		]);
		// Each created Lead starts COLD_QUEUED.
		for (const snapshot of leadRepo.byPhone.values()) {
			expect(snapshot.lifecycleState).toBe("COLD_QUEUED");
		}
		// Every new Lead is enrolled into the cadence (Req 2.3).
		expect(cadence.enrolled).toEqual(["lead-1", "lead-2"]);
		expect(cadence.scheduler.enroll).toHaveBeenCalledWith("lead-1", FIXED_NOW);

		expect(report.createdCount).toBe(2);
		expect(report.updatedCount).toBe(0);
		expect(report.rejectedCount).toBe(0);
		expect(report.rows).toEqual([
			{ rowNumber: 2, outcome: "created", leadId: "lead-1" },
			{ rowNumber: 3, outcome: "created", leadId: "lead-2" },
		]);
	});

	it("rejects rows whose phone cannot be normalized, recording the row number and reason (Req 1.3)", async () => {
		const csv = "telefone\nnot-a-phone\n\n11987654321\n123\n";
		const report = await importer().import(buf(csv), "csv");

		// Only the one valid number created a Lead and enrolled.
		expect(leadRepo.creates).toEqual([
			{ phoneE164: "+5511987654321", source: "csv", displayName: null },
		]);
		expect(cadence.enrolled).toEqual(["lead-1"]);

		expect(report.createdCount).toBe(1);
		expect(report.rejectedCount).toBe(2);
		const rejected = report.rows.filter((r) => r.outcome === "rejected");
		expect(rejected).toHaveLength(2);
		for (const row of rejected) {
			expect(row.reason).toBeTruthy();
			expect(row.leadId).toBeUndefined();
		}
		// Row numbers index the parsed (non-empty) rows: header=1, "not-a-phone"=2,
		// the valid number=3, "123"=4 (the blank line is skipped).
		expect(rejected.map((r) => r.rowNumber)).toEqual([2, 4]);
	});

	it("deduplicates against an existing Lead, counting the row as updated without creating a duplicate or enrolling (Req 1.4)", async () => {
		// Seed an existing Lead at the normalized number.
		leadRepo.byPhone.set(
			"+5511987654321",
			newSnapshot("existing-1", {
				phoneE164: "+5511987654321",
				source: "prior",
			}),
		);

		const csv = "telefone\n11987654321\n";
		const report = await importer().import(buf(csv), "csv");

		expect(leadRepo.repo.create).not.toHaveBeenCalled();
		expect(cadence.scheduler.enroll).not.toHaveBeenCalled();
		expect(report.createdCount).toBe(0);
		expect(report.updatedCount).toBe(1);
		expect(report.rows).toEqual([
			{ rowNumber: 2, outcome: "updated", leadId: "existing-1" },
		]);
	});

	it("treats within-file duplicates as one create then updates, enrolling the number once (Req 1.4)", async () => {
		const csv = "telefone\n11987654321\n(11) 98765-4321\n";
		const report = await importer().import(buf(csv), "csv");

		expect(leadRepo.repo.create).toHaveBeenCalledTimes(1);
		expect(cadence.enrolled).toEqual(["lead-1"]);
		expect(report.createdCount).toBe(1);
		expect(report.updatedCount).toBe(1);
		expect(report.rows).toEqual([
			{ rowNumber: 2, outcome: "created", leadId: "lead-1" },
			{ rowNumber: 3, outcome: "updated", leadId: "lead-1" },
		]);
	});

	it("keeps the report counts partitioning every parsed row (Req 1.6)", async () => {
		const csv = "telefone\n11987654321\n11987654321\nbad\n4133221100\n";
		const report = await importer().import(buf(csv), "csv");

		const total =
			report.createdCount + report.updatedCount + report.rejectedCount;
		expect(total).toBe(report.rows.length);
		expect(report).toMatchObject({
			createdCount: 2,
			updatedCount: 1,
			rejectedCount: 1,
		});
	});

	it("reads a header-less single-column phone list from the first column", async () => {
		const csv = "11987654321\n4133221100\n";
		const report = await importer().import(buf(csv), "landing-page");

		expect(leadRepo.creates).toEqual([
			{ phoneE164: "+5511987654321", source: "landing-page", displayName: null },
			{ phoneE164: "+554133221100", source: "landing-page", displayName: null },
		]);
		// No header, so the first data row is row 1.
		expect(report.rows.map((r) => r.rowNumber)).toEqual([1, 2]);
		expect(report.createdCount).toBe(2);
	});

	it("locates the phone column among other columns via the header alias and captures the name", async () => {
		const csv =
			"nome,telefone,email\nMaria,(11) 98765-4321,maria@example.com\n";
		const report = await importer().import(buf(csv), "csv");

		expect(leadRepo.creates).toEqual([
			{ phoneE164: "+5511987654321", source: "csv", displayName: "Maria" },
		]);
		expect(report.createdCount).toBe(1);
	});

	it("captures the lead name from a name column for each created lead (Req 4.1)", async () => {
		const csv =
			"nome,telefone\nJoão Silva,11987654321\nAna,4133221100\n,11912345678\n";
		await importer().import(buf(csv), "csv");

		// Names captured per row; the blank name cell yields null (name-less).
		expect(leadRepo.creates).toEqual([
			{ phoneE164: "+5511987654321", source: "csv", displayName: "João Silva" },
			{ phoneE164: "+554133221100", source: "csv", displayName: "Ana" },
			{ phoneE164: "+5511912345678", source: "csv", displayName: null },
		]);
	});

	it("recognizes alternate name-column headers (e.g. cliente)", async () => {
		const csv = "cliente,celular\nCarlos,11987654321\n";
		await importer().import(buf(csv), "csv");

		expect(leadRepo.creates).toEqual([
			{ phoneE164: "+5511987654321", source: "csv", displayName: "Carlos" },
		]);
	});

	it("does not capture a name from a header-less phone list", async () => {
		const csv = "11987654321\n";
		await importer().import(buf(csv), "csv");

		expect(leadRepo.creates).toEqual([
			{ phoneE164: "+5511987654321", source: "csv", displayName: null },
		]);
	});

	it("returns an empty report for an empty CSV", async () => {
		const report = await importer().import(buf(""), "csv");
		expect(report).toEqual({
			createdCount: 0,
			updatedCount: 0,
			rejectedCount: 0,
			rows: [],
		});
		expect(leadRepo.repo.create).not.toHaveBeenCalled();
	});
});
