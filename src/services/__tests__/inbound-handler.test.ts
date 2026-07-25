// Unit tests for the InboundHandler (beta flow: reply -> handoff).
//
// Exercises the ordered inbound pipeline (Req 7, 13, 15.1): a normal reply is
// recorded, silences the cadence, and is handed straight off to a consultant
// with reason `replied`; an opt-out message short-circuits before any handoff.
//
// The second describe block is the regression suite ADR-003 asks for by name.
// The production bug was that a lead which had already replied kept receiving
// cadence touches, and its mirror image — re-alerting the consultant on every
// subsequent message — is just as bad in the other direction. Rule 2 fixes both
// with one predicate, so these tests pin it per originating state.

import { describe, expect, it, vi } from "vitest";

import type { LeadSnapshot } from "@/core/types";
import type { HandoffManager } from "@/services/handoff-manager";
import {
	createInboundHandler,
	type InboundMessage,
} from "@/services/inbound-handler";

const LEAD: LeadSnapshot = {
	id: "lead-1",
	phoneE164: "+5547996334573",
	source: "csv",
	displayName: null,
	lifecycleState: "IN_CADENCE",
	optInStatus: "opt_in",
	optInAt: null,
	blocked: false,
	unreachableAt: null,
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
	createdAt: new Date(),
	updatedAt: new Date(),
};

function buildDeps(lead: LeadSnapshot = LEAD) {
	const leads = {
		findByPhone: vi.fn(async () => lead),
		create: vi.fn(async () => lead),
	};
	const messages = { append: vi.fn(async () => ({})) };
	const waha = {
		resolveChatId: vi.fn(async () => "chat-1"),
		sendSeen: vi.fn(async () => {}),
	};
	const compliance = { applyOptOut: vi.fn(async () => {}) };
	const cadence = { cancelAll: vi.fn(async () => {}) };
	const handoff: HandoffManager = { handoff: vi.fn(async () => {}) };
	return { leads, messages, waha, compliance, cadence, handoff };
}

function message(text: string): InboundMessage {
	return {
		from: "+5547996334573",
		text,
		receivedAt: new Date(),
		waMessageId: "wamid-1",
		numberId: "num-1",
	};
}

// The deps interface is wider than the fakes' surface; the handler only calls
// the methods stubbed above, so a structural cast keeps the tests focused.
function handlerFrom(deps: ReturnType<typeof buildDeps>) {
	return createInboundHandler(
		deps as unknown as Parameters<typeof createInboundHandler>[0],
	);
}

describe("InboundHandler (reply -> handoff)", () => {
	it("records the reply, rescores, and hands the lead off with reason 'replied'", async () => {
		const deps = buildDeps();
		const handler = handlerFrom(deps);

		await handler.handle(message("tenho interesse, me liga"));

		expect(deps.messages.append).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "inbound", content: "tenho interesse, me liga" }),
		);
		expect(deps.cadence.cancelAll).toHaveBeenCalledWith(LEAD.id);
		expect(deps.handoff.handoff).toHaveBeenCalledWith(LEAD.id, "replied");
	});

	it("short-circuits on opt-out: applies opt-out and does not hand off", async () => {
		const deps = buildDeps();
		const handler = handlerFrom(deps);

		await handler.handle(message("pare"));

		expect(deps.compliance.applyOptOut).toHaveBeenCalledWith(
			LEAD.id,
			expect.any(Date),
		);
		expect(deps.handoff.handoff).not.toHaveBeenCalled();
		expect(deps.cadence.cancelAll).not.toHaveBeenCalled();
	});
});

describe("InboundHandler reply rule (ADR-003 rule 2)", () => {
	/** The lead as it would be in `state` when the reply lands. */
	function leadIn(state: LeadSnapshot["lifecycleState"]): LeadSnapshot {
		return { ...LEAD, lifecycleState: state };
	}

	it("a reply IN_CADENCE cancels the pending touches and hands off", async () => {
		// The original production bug: the cadence kept firing at a lead that had
		// already answered.
		const deps = buildDeps(leadIn("IN_CADENCE"));
		const handler = handlerFrom(deps);

		await handler.handle(message("pode me ligar?"));

		expect(deps.cadence.cancelAll).toHaveBeenCalledWith(LEAD.id);
		expect(deps.handoff.handoff).toHaveBeenCalledWith(LEAD.id, "replied");
	});

	it("a LATE reply (COMPLETED) hands off too — there is just nothing left to cancel", async () => {
		// Covered by the single `COMPLETED → REPLIED` edge rather than a special
		// case in the webhook. `cancelAll` still runs and is a no-op, because the
		// five touches are already spent.
		const deps = buildDeps(leadIn("COMPLETED"));
		const handler = handlerFrom(deps);

		await handler.handle(message("desculpa a demora, ainda tenho interesse"));

		expect(deps.handoff.handoff).toHaveBeenCalledWith(LEAD.id, "replied");
		expect(deps.cadence.cancelAll).toHaveBeenCalledWith(LEAD.id);
	});

	it.each<LeadSnapshot["lifecycleState"]>(["REPLIED", "WON", "LOST"])(
		"a reply from a lead already with its consultant (%s) records only — no handoff, no alert",
		async (state) => {
			const deps = buildDeps(leadIn(state));
			const handler = handlerFrom(deps);

			await handler.handle(message("mais uma mensagem"));

			// The message is still persisted — the conversation history stays whole.
			expect(deps.messages.append).toHaveBeenCalledWith(
				expect.objectContaining({ direction: "inbound" }),
			);
			// But nothing else happens: no state change, no cancel, and above all no
			// second WhatsApp alert to the consultant.
			expect(deps.handoff.handoff).not.toHaveBeenCalled();
			expect(deps.cadence.cancelAll).not.toHaveBeenCalled();
		},
	);
});
