// Lead importer (I/O boundary — source-agnostic CSV intake + enrollment).
//
// Implements the design's `Lead_Importer`: it parses a CSV upload into candidate
// Leads, normalizes each phone number through the pure `@/core/phone`
// `normalizePhone`, deduplicates against existing Leads by the normalized
// number, creates new Leads in `COLD_QUEUED` recording their originating source,
// enrolls each new Lead into the reactivation cadence, and returns an
// {@link ImportReport} accounting for every row (Req 1, 2.1, 2.2, 2.3).
//
// Source-agnostic by construction (Req 2.2): the per-candidate pipeline
// (normalize → dedup → create-or-update → enroll) is independent of where the
// candidate came from. The CSV reader is the only CSV-specific part; the same
// downstream path serves a future Meta Ads / landing-page source feeding a
// single candidate.
//
// Side-effect boundary: all persistence and orchestration flow through injected
// INTERFACE dependencies only — never concrete Drizzle/DB or pg-boss code:
//   - `LeadRepository`  — look up by normalized number, create new Leads
//                         (Req 1.4, 1.5, 2.1);
//   - `CadenceScheduler`— enroll new Leads into the cadence (Req 2.3, 3.1);
//   - `Clock`           — the injected time source for the enrollment instant
//                         (no direct `Date.now()`), keeping the importer
//                         deterministic under test.
// CSV parsing uses `csv-parse` (the maintained, de-facto-standard Node CSV
// parser) via its synchronous `csv-parse/sync` entry point.

import { parse } from "csv-parse/sync";

import { normalizePhone } from "@/core/phone";
import type { Clock } from "@/core/types";
import type { CadenceScheduler } from "@/services/cadence-scheduler";
import type { LeadRepository } from "@/services/repositories";

// ---------------------------------------------------------------------------
// Report shapes (design "Lead_Importer")
// ---------------------------------------------------------------------------

/**
 * The outcome of a single CSV row in the import (design "Lead_Importer").
 *
 *   - `"created"`  — the row's normalized number was new; a Lead was created in
 *     `COLD_QUEUED` and enrolled into the cadence (Req 1.5, 2.3). `leadId` is
 *     set.
 *   - `"updated"`  — the row's normalized number matched an existing Lead; no
 *     duplicate was created and the row is counted as an update (Req 1.4).
 *     `leadId` is the existing Lead.
 *   - `"rejected"` — the row's phone could not be normalized to E.164; `reason`
 *     explains why and no Lead was touched (Req 1.3). `leadId` is absent.
 */
export interface ImportRowResult {
	/** 1-based position of the row in the parsed file (the header is row 1). */
	rowNumber: number;
	/** What happened to this row. */
	outcome: "created" | "updated" | "rejected";
	/** Human-readable rejection cause; present only when `outcome` is `rejected`. */
	reason?: string;
	/** The created/matched Lead id; present for `created` and `updated`. */
	leadId?: string;
}

/**
 * The result of an import run (design "Lead_Importer", Req 1.6). Carries the
 * created / updated / rejected counts plus a per-row breakdown. The three counts
 * always partition `rows`: `createdCount + updatedCount + rejectedCount ===
 * rows.length`.
 */
export interface ImportReport {
	/** Number of rows that created a new Lead (Req 1.5). */
	createdCount: number;
	/** Number of rows that matched an existing Lead (deduplicated, Req 1.4). */
	updatedCount: number;
	/** Number of rows rejected because the phone could not be normalized (Req 1.3). */
	rejectedCount: number;
	/** Per-row outcomes, in file order. */
	rows: ImportRowResult[];
}

// ---------------------------------------------------------------------------
// Importer interface
// ---------------------------------------------------------------------------

/**
 * The source-agnostic Lead importer (design "Lead_Importer"). Parses a CSV
 * buffer, applies the normalize → dedup → create-or-update → enroll pipeline to
 * each row, and reports the result (Req 1, 2).
 */
export interface LeadImporter {
	/**
	 * Import the Leads described by `csv`, attributing every created Lead to
	 * `source` (Req 2.1).
	 *
	 * For each data row, in order:
	 *   1. read the phone cell and normalize it via `normalizePhone` (Req 1.2);
	 *   2. on a normalization failure, reject the row with its number + reason
	 *      and continue (Req 1.3);
	 *   3. otherwise look up the normalized number; if a Lead exists, count the
	 *      row as `updated` without creating a duplicate (Req 1.4);
	 *   4. if none exists, create a Lead in `COLD_QUEUED` recording `source`
	 *      (Req 1.5, 2.1) and enroll it into the cadence via the injected
	 *      {@link CadenceScheduler} (Req 2.3, 3.1).
	 *
	 * Within-file duplicates are handled by the same lookup: the first
	 * occurrence creates (and enrolls) the Lead, and later occurrences of the
	 * same normalized number match it and are counted as `updated` — so a number
	 * is created and enrolled at most once per import.
	 *
	 * @param csv - The raw CSV upload bytes.
	 * @param source - The originating source recorded on each created Lead
	 *        (e.g. `"csv"`); the same value future real-time sources pass
	 *        (Req 2.1, 2.2).
	 * @returns The {@link ImportReport} for the run (Req 1.6).
	 */
	import(csv: Buffer, source: string): Promise<ImportReport>;
}

// ---------------------------------------------------------------------------
// Construction configuration
// ---------------------------------------------------------------------------

/**
 * Default header-cell tokens that identify the phone column (matched
 * case-insensitively as substrings, so `"Telefone do cliente"` matches
 * `"telefone"`). Covers the common PT-BR and English column labels.
 */
export const DEFAULT_PHONE_COLUMN_ALIASES: readonly string[] = [
	"phone",
	"telefone",
	"celular",
	"whatsapp",
	"msisdn",
	"fone",
	"numero",
	"número",
	"mobile",
];

/** Construction dependencies for {@link LeadImporterService}. */
export interface LeadImporterConfig {
	/** Persistence boundary: look up by phone, create new Leads (Req 1.4, 1.5). */
	leads: LeadRepository;
	/** Enrollment boundary: enroll each new Lead into the cadence (Req 2.3). */
	cadence: CadenceScheduler;
	/** Injected time source for the enrollment instant (no direct `Date.now()`). */
	clock: Clock;
	/**
	 * Optional override of the header tokens used to locate the phone column.
	 * Defaults to {@link DEFAULT_PHONE_COLUMN_ALIASES}.
	 */
	phoneColumnAliases?: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal CSV helpers
// ---------------------------------------------------------------------------

/**
 * Parse the CSV bytes into raw string rows. Tolerant of the common real-world
 * shapes: a UTF-8 BOM is stripped, blank lines are skipped, cells are trimmed,
 * and rows of varying column counts are accepted so a short row simply yields a
 * missing phone cell (rejected downstream) rather than aborting the import.
 */
function parseRows(csv: Buffer): string[][] {
	return parse(csv, {
		bom: true,
		skip_empty_lines: true,
		relax_column_count: true,
		trim: true,
	}) as string[][];
}

/** Location of the phone column and the index at which data rows begin. */
interface PhoneColumnLocation {
	/** Column index holding the phone number in each data row. */
	phoneColumnIndex: number;
	/** Index of the first data row in the parsed rows (1 with a header, else 0). */
	dataStartIndex: number;
}

/**
 * Locate the phone column. When the first row contains a recognizable phone
 * header (a cell whose lowercased text includes one of `aliases`), that column
 * is used and data starts on the next row; otherwise the file is treated as a
 * header-less single/first-column phone list and every row is a data row.
 */
function locatePhoneColumn(
	rows: string[][],
	aliases: readonly string[],
): PhoneColumnLocation {
	const header = rows[0] ?? [];
	const headerIndex = header.findIndex((cell) => {
		const c = cell.trim().toLowerCase();
		return aliases.some((alias) => c.includes(alias));
	});
	if (headerIndex >= 0) {
		return { phoneColumnIndex: headerIndex, dataStartIndex: 1 };
	}
	return { phoneColumnIndex: 0, dataStartIndex: 0 };
}

// ---------------------------------------------------------------------------
// LeadImporterService
// ---------------------------------------------------------------------------

/**
 * Concrete {@link LeadImporter} backed by the injected {@link LeadRepository}
 * and {@link CadenceScheduler}. Stateless beyond its dependencies; each
 * {@link import} call parses afresh and processes rows sequentially so that
 * within-file duplicates resolve against Leads created earlier in the same run.
 */
export class LeadImporterService implements LeadImporter {
	private readonly leads: LeadRepository;
	private readonly cadence: CadenceScheduler;
	private readonly clock: Clock;
	private readonly phoneColumnAliases: readonly string[];

	constructor(deps: LeadImporterConfig) {
		this.leads = deps.leads;
		this.cadence = deps.cadence;
		this.clock = deps.clock;
		this.phoneColumnAliases =
			deps.phoneColumnAliases ?? DEFAULT_PHONE_COLUMN_ALIASES;
	}

	/** @inheritdoc */
	async import(csv: Buffer, source: string): Promise<ImportReport> {
		const report: ImportReport = {
			createdCount: 0,
			updatedCount: 0,
			rejectedCount: 0,
			rows: [],
		};

		const rows = parseRows(csv);
		if (rows.length === 0) {
			return report;
		}

		const { phoneColumnIndex, dataStartIndex } = locatePhoneColumn(
			rows,
			this.phoneColumnAliases,
		);

		for (let i = dataStartIndex; i < rows.length; i++) {
			// 1-based row number within the parsed file; with a header present the
			// header occupies row 1, so the first data row reports as row 2.
			const rowNumber = i + 1;
			const rawPhone = (rows[i][phoneColumnIndex] ?? "").trim();

			// (1)+(2) Normalize the phone; a failure rejects the row with a reason
			// and never touches the data store (Req 1.2, 1.3).
			const normalized = normalizePhone(rawPhone, "BR");
			if (normalized === null) {
				report.rejectedCount += 1;
				report.rows.push({
					rowNumber,
					outcome: "rejected",
					reason:
						rawPhone.length === 0
							? "missing phone number"
							: `phone number "${rawPhone}" could not be normalized to E.164`,
				});
				continue;
			}

			// (3) Deduplicate by normalized number: an existing Lead is updated
			// rather than duplicated, and counted as updated (Req 1.4).
			const existing = await this.leads.findByPhone(normalized);
			if (existing) {
				report.updatedCount += 1;
				report.rows.push({
					rowNumber,
					outcome: "updated",
					leadId: existing.id,
				});
				continue;
			}

			// (4) Create the new Lead in COLD_QUEUED recording its source (Req 1.5,
			// 2.1), then enroll it into the cadence via the injected scheduler — the
			// same enrollment path any future source uses (Req 2.2, 2.3, 3.1).
			const created = await this.leads.create({
				phoneE164: normalized,
				source,
			});
			await this.cadence.enroll(created.id, this.clock.now());

			report.createdCount += 1;
			report.rows.push({
				rowNumber,
				outcome: "created",
				leadId: created.id,
			});
		}

		return report;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct a {@link LeadImporter} from {@link LeadImporterConfig}. */
export function createLeadImporter(config: LeadImporterConfig): LeadImporter {
	return new LeadImporterService(config);
}
