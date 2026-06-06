// CRM CSV-import composition root (Req 20.3).
//
// Side-effect boundary: like `@/services/auth`, this is a composition root. It
// resolves the shared runtime (`@/services/runtime`) and returns the
// source-agnostic `Lead_Importer` already wired to the durable
// `Cadence_Scheduler`, so a CSV uploaded through the CRM_UI enrolls each new
// lead into the reactivation cadence through the SAME enrollment path any
// future real-time source will use (Req 1, 2.1, 2.2, 2.3, 3.1).
//
// Enrollment is now live: a newly-created lead is moved `COLD_QUEUED →
// IN_CADENCE` and its five cancellable touch jobs T1–T5 are enqueued onto
// pg-boss (task 23.1). The import result report (created / updated / rejected)
// the CRM_UI displays is produced by the same importer (Req 1.6, 20.3).

import type { LeadImporter } from "@/services/lead-importer";
import { getRuntime } from "@/services/runtime";

/**
 * Resolve the {@link LeadImporter} wired to the live data layer and the durable
 * cadence scheduler for use by the CRM_UI import endpoint (Req 20.3). Parses CSV
 * uploads, deduplicates by normalized phone, creates new leads in `COLD_QUEUED`,
 * enrolls them into the cadence, and returns the import report the UI renders.
 */
export async function createCrmImporter(): Promise<LeadImporter> {
	const runtime = await getRuntime();
	return runtime.importer;
}
