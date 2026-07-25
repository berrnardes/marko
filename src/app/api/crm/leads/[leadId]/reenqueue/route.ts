// Internal CRM API — put a finished lead back into the cadence (ADR-003 rule 5).
//
// A separate route from the manual `PATCH`, because this is not a state change:
// it moves the lead `COMPLETED → QUEUED` and then enrolls it, which schedules
// five fresh touch jobs. `PATCH` deliberately refuses to set `IN_CADENCE` for
// exactly that reason — a lead sitting in `IN_CADENCE` with no scheduled jobs
// would look active and never send anything.
//
// Only a `COMPLETED` lead can be re-enqueued. Not `REPLIED`/`WON`/`LOST` (the
// consultant owns those conversations; automated outreach on top would be
// exactly the production bug ADR-003 closes), and not `OPTED_OUT` (terminal).

import { NextResponse } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { withOrg } from "@/db/with-org";
import { logger } from "@/logger";
import { CadenceEnrollmentError } from "@/services/cadence-scheduler";
import { getRuntime } from "@/services/runtime";

export async function POST(
	_request: Request,
	{ params }: { params: Promise<{ leadId: string }> },
): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) {
		return auth.denied;
	}

	const { leadId } = await params;
	const { organizationId, userId } = auth.org;
	const runtime = await getRuntime();

	try {
		const result = await withOrg(organizationId, async (tx) => {
			const org = runtime.forOrg(organizationId, tx);
			const lead = await org.leads.findById(leadId);
			if (!lead) {
				return { kind: "not_found" as const };
			}
			if (lead.lifecycleState !== "COMPLETED") {
				return { kind: "conflict" as const, state: lead.lifecycleState };
			}

			// Two steps, in this order. `enroll` is what moves the lead
			// `QUEUED → IN_CADENCE` and creates T1–T5, so the lead must be back in
			// `QUEUED` first; going straight to `IN_CADENCE` would be rejected by the
			// transition table.
			const requeued = await org.lifecycle.apply(leadId, "QUEUED");
			if (!requeued.ok) {
				return { kind: "conflict" as const, state: requeued.state };
			}
			const schedules = await org.cadenceScheduler.enroll(
				leadId,
				runtime.clock.now(),
			);
			return { kind: "ok" as const, touches: schedules.length };
		});

		switch (result.kind) {
			case "not_found":
				return NextResponse.json({ error: "not_found" }, { status: 404 });
			case "conflict":
				return NextResponse.json(
					{
						error: "only a lead whose cadence has completed can be re-enqueued",
						state: result.state,
					},
					{ status: 409 },
				);
			case "ok":
				logger.info(
					{
						event: "lead.reenqueued",
						organizationId,
						userId,
						leadId,
						touches: result.touches,
					},
					"consultant re-enqueued a completed lead",
				);
				return NextResponse.json({
					lifecycleState: "IN_CADENCE",
					touches: result.touches,
				});
		}
	} catch (err) {
		// Lost the race to something that moved the lead between the read and the
		// enrollment — report it as the same conflict the caller would have seen.
		if (err instanceof CadenceEnrollmentError) {
			return NextResponse.json(
				{ error: "invalid_transition", state: err.state },
				{ status: 409 },
			);
		}
		throw err;
	}
}
