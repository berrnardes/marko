// Unit tests for the InboundHandler (beta flow: reply -> handoff).
//
// Exercises the ordered inbound pipeline (Req 7, 11.1, 13, 15.1): a normal reply
// is recorded, rescored, and handed straight off to a consultant with reason
// `replied`; an opt-out message short-circuits before any handoff.

import { describe, expect, it, vi } from "vitest";

import type { LeadSnapshot } from "@/core/types";
import type { HandoffManager } from "@/services/handoff-manager";
import {
	createInboundHandler,
	type InboundMessage,
} from "@/services/inbound-handler";
import type { ScoringEngine } from "@/services/scoring-engine";

const LEAD: LeadSnapshot = {
	id: "lead-1",
	phoneE164: "+5547996334573",
	source: "csv",
	lifecycleState: "IN_CADENCE",
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
	createdAt: new Date(),
	updatedAt: new Date(),
};

function buildDeps() {
	const leads = {
		findByPhone: vi.fn(async () => LEAD),
		create: vi.fn(async () => LEAD),
	};
	const messages = { append: vi.fn(async () => ({})) };
	const waha = {
		resolveChatId: vi.fn(async () => "chat-1"),
		sendSeen: vi.fn(async () => {}),
	};
	const compliance = { applyOptOut: vi.fn(async () => {}) };
	const cadence = { cancelAll: vi.fn(async () => {}) };
	const nurture = { cancel: vi.fn(async () => {}) };
	const scoring: ScoringEngine = {
		recompute: vi.fn(async () => ({ score: 0, band: "cold" as const })),
	};
	const handoff: HandoffManager = { handoff: vi.fn(async () => {}) };
	return { leads, messages, waha, compliance, cadence, nurture, scoring, handoff };
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
		expect(deps.nurture.cancel).toHaveBeenCalledWith(LEAD.id);
		expect(deps.scoring.recompute).toHaveBeenCalledWith(LEAD.id);
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
		expect(deps.scoring.recompute).not.toHaveBeenCalled();
	});
});
