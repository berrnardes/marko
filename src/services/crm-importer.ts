// CRM CSV-import composition root (Req 20.3).
//
// Side-effect boundary: like `@/services/auth`, this is a composition root — it
// wires the source-agnostic `Lead_Importer` (which depends only on interfaces)
// to the concrete data layer so the CRM_UI import endpoint can reuse it as-is
// (Req 1, 2.1, 20.3). It constructs a `DrizzleLeadRepository` for the
// create/deduplicate path and a system `Clock`.
//
// Cadence enrollment seam: the importer enrolls each newly-created lead through
// a `CadenceScheduler`. The durable pg-boss-backed scheduler is wired in task
// 23.1; until then this module injects a deferred scheduler that performs no
// enqueue, leaving imported leads in their valid `COLD_QUEUED` state to be
// enrolled once the queue is wired. The import result report (created / updated
// / rejected) — the data the CRM_UI displays — is unaffected by this seam
// (Req 1.6, 20.3).

import type { Clock } from "@/core/types";
import { DrizzleLeadRepository } from "@/db/lead-repository";
import type { CadenceScheduler } from "@/services/cadence-scheduler";
import {
	createLeadImporter,
	type LeadImporter,
} from "@/services/lead-importer";

/**
 * Deferred cadence scheduler: a structurally-complete {@link CadenceScheduler}
 * whose durable enrollment is not yet wired (task 23.1). `enroll` records no
 * jobs and returns an empty schedule; `cancelAll` cancels nothing. Imported
 * leads therefore remain `COLD_QUEUED` rather than being moved into a state
 * with no backing jobs.
 */
const deferredCadenceScheduler: CadenceScheduler = {
	async enroll() {
		return [];
	},
	async cancelAll() {
		return 0;
	},
};

/** System clock seam for the importer's enrollment instant. */
const systemClock: Clock = { now: () => new Date() };

/**
 * Construct a {@link LeadImporter} wired to the live data layer for use by the
 * CRM_UI import endpoint (Req 20.3). Parses CSV uploads, deduplicates by
 * normalized phone, creates new leads in `COLD_QUEUED`, and returns the import
 * report the UI renders.
 */
export function createCrmImporter(): LeadImporter {
	return createLeadImporter({
		leads: new DrizzleLeadRepository(),
		cadence: deferredCadenceScheduler,
		clock: systemClock,
	});
}
