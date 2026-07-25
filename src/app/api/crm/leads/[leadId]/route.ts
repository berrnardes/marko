// Internal CRM API — lead detail (GET) + manual state change (PATCH).
//
// Guarded by the edge proxy and re-validated server-side here. GET returns a
// single lead's qualification fields and full message history, or `404` when no
// lead matches. PATCH is the consultant's hand on the state machine: the one
// endpoint behind "ganhei", "perdi", and "me enganei" (ADR-003 rules 4–5).
//
// PATCH validates against the lifecycle table AND a narrower allowlist of
// consultant-operable edges, because the table alone is too permissive here:
// `IN_CADENCE → COMPLETED` is lawful but belongs to the cadence worker, and
// `→ OPTED_OUT` is lawful but must go through the Compliance_Manager so the
// lawful-basis record is written and the pending jobs are cancelled. Neither
// is something a PATCH body should be able to trigger.

import { NextResponse, type NextRequest } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { LIFECYCLE_STATES } from "@/core/lifecycle";
import type { LifecycleState } from "@/core/types";
import { getLeadDetail } from "@/db/crm-read";
import { withOrg } from "@/db/with-org";
import { logger } from "@/logger";
import { UnknownLeadError } from "@/services/lifecycle-manager";
import { getRuntime } from "@/services/runtime";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ leadId: string }> },
): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) {
		return auth.denied;
	}

	const { leadId } = await params;
	// Scoped to the caller's organization: a lead id belonging to another tenant
	// reads as `404`, exactly like one that does not exist.
	const { organizationId } = auth.org;
	const lead = await withOrg(organizationId, (tx) =>
		getLeadDetail(organizationId, leadId, tx),
	);
	if (!lead) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	return NextResponse.json({ lead });
}

/**
 * The lifecycle moves a consultant may make by hand (ADR-003 rules 4–5), keyed
 * by target state. A move must appear here AND be lawful in the transition
 * table; this narrows the table rather than duplicating it.
 *
 * Deliberately absent:
 *   - `IN_CADENCE` — enrollment belongs to the scheduler, which also has to
 *     create the five touch jobs. Re-enqueueing is `POST .../reenqueue`.
 *   - `COMPLETED` — the cadence worker sets it after the fifth touch.
 *   - `OPTED_OUT` — must go through the Compliance_Manager, which records the
 *     lawful basis and cancels pending outreach (Req 15). Letting a PATCH set
 *     the state alone would leave the lead silently opted out with the jobs
 *     still queued.
 */
const MANUAL_TRANSITIONS: Partial<
	Record<LifecycleState, readonly LifecycleState[]>
> = {
	// Record the outcome of a conversation.
	WON: ["REPLIED"],
	LOST: ["REPLIED"],
	// Undo a mis-clicked outcome, back through REPLIED.
	REPLIED: ["WON", "LOST"],
	// Put a finished lead back in line; the actual re-enrollment is the
	// `reenqueue` route, which takes it from here to IN_CADENCE.
	QUEUED: ["COMPLETED"],
};

/** Narrow an arbitrary value to a known {@link LifecycleState}. */
function isLifecycleState(value: unknown): value is LifecycleState {
	return (
		typeof value === "string" &&
		(LIFECYCLE_STATES as readonly string[]).includes(value)
	);
}

/**
 * Move a lead to a new lifecycle state by hand (ADR-003 rules 4–5).
 *
 * Body: `{ "lifecycleState": "WON" }`.
 *
 * Statuses: `400` for an unknown state, `403` for a state the consultant may
 * not set directly, `404` for a lead outside the caller's organization, and
 * `409` when the lead is not in a state the move is allowed FROM (e.g. marking
 * `WON` a lead that never replied) — the body then reports the lead's actual
 * state so the UI can refresh instead of guessing.
 */
export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ leadId: string }> },
): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) {
		return auth.denied;
	}

	const { leadId } = await params;
	const body = (await request.json().catch(() => ({}))) as {
		lifecycleState?: unknown;
	};

	if (!isLifecycleState(body.lifecycleState)) {
		return NextResponse.json(
			{ error: "lifecycleState must be a known lifecycle state" },
			{ status: 400 },
		);
	}
	const to = body.lifecycleState;
	const allowedFrom = MANUAL_TRANSITIONS[to];
	if (!allowedFrom) {
		return NextResponse.json(
			{ error: `"${to}" is not a state a consultant can set directly` },
			{ status: 403 },
		);
	}

	const { organizationId, userId } = auth.org;
	const runtime = await getRuntime();

	try {
		const result = await withOrg(organizationId, async (tx) => {
			const org = runtime.forOrg(organizationId, tx);
			// Read first so an out-of-allowlist origin is reported as a conflict
			// rather than as the lifecycle manager's generic rejection — the two
			// have different causes and the UI shows different things.
			const lead = await org.leads.findById(leadId);
			if (!lead) {
				return { kind: "not_found" as const };
			}
			if (!allowedFrom.includes(lead.lifecycleState)) {
				return { kind: "conflict" as const, state: lead.lifecycleState };
			}
			const applied = await org.lifecycle.apply(leadId, to);
			return applied.ok
				? { kind: "ok" as const, from: applied.from }
				: { kind: "conflict" as const, state: applied.state };
		});

		switch (result.kind) {
			case "not_found":
				return NextResponse.json({ error: "not_found" }, { status: 404 });
			case "conflict":
				return NextResponse.json(
					{ error: "invalid_transition", state: result.state },
					{ status: 409 },
				);
			case "ok":
				logger.info(
					{
						event: "lead.manual_transition",
						organizationId,
						userId,
						leadId,
						from: result.from,
						to,
					},
					"consultant changed a lead's state by hand",
				);
				return NextResponse.json({ lifecycleState: to });
		}
	} catch (err) {
		// The lead vanished between the read and the write.
		if (err instanceof UnknownLeadError) {
			return NextResponse.json({ error: "not_found" }, { status: 404 });
		}
		throw err;
	}
}
