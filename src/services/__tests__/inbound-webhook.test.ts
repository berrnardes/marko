// Unit tests for the webhook's outbound-echo ingestion (beta WhatsApp Web flow).
//
// A consultant's reply typed on a WhatsApp Web linked device arrives as a
// `fromMe: true` echo. These tests cover the three behaviors that close the
// history + anti-ban gaps: a new echo is recorded as outbound history and
// counted against the sending number's cap; our own automated send (same
// `wa_message_id`) dedups to a no-op; and an echo to a non-lead is ignored.

import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { LeadSnapshot } from "@/core/types";
import {
	processWahaWebhook,
	type WahaWebhookDeps,
} from "@/services/inbound-webhook";
import type { MessageRecord } from "@/services/repositories";

const SECRET = "test-secret";

const LEAD: LeadSnapshot = {
	id: "lead-1",
	phoneE164: "+5547996334573",
	source: "csv",
	lifecycleState: "HOT",
	optInStatus: "opt_in",
	optInAt: null,
	score: 0,
	blocked: false,
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

function sign(body: string): string {
	return createHmac("sha512", SECRET).update(body, "utf8").digest("hex");
}

function echoBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		event: "message",
		session: "default",
		payload: {
			id: "wamid-echo-1",
			from: "5547999999999@c.us", // our own number for a fromMe echo
			to: "5547996334573@c.us", // the lead (recipient)
			body: "Oi! Sou o consultor, podemos falar?",
			timestamp: 1_782_245_765,
			fromMe: true,
			...overrides,
		},
	});
}

function buildDeps(over: Partial<WahaWebhookDeps> = {}): {
	deps: WahaWebhookDeps;
	append: ReturnType<typeof vi.fn>;
	recordSend: ReturnType<typeof vi.fn>;
	findByWaMessageId: ReturnType<typeof vi.fn>;
} {
	const append = vi.fn(async () => ({ id: "msg-1" }) as MessageRecord);
	const recordSend = vi.fn(async () => 1);
	const findByWaMessageId = vi.fn(async () => null as MessageRecord | null);
	const deps = {
		secret: SECRET,
		leads: {
			findByPhone: vi.fn(async () => LEAD),
			create: vi.fn(async () => LEAD),
		},
		messages: { append, findByWaMessageId },
		queue: { enqueueInbound: vi.fn(async () => "job-1") },
		antiBan: { recordSend },
		resolveNumberId: vi.fn(async () => "num-1"),
		...over,
	} as unknown as WahaWebhookDeps;
	return { deps, append, recordSend, findByWaMessageId };
}

describe("webhook outbound-echo ingestion", () => {
	it("records a new fromMe echo as outbound history and counts it", async () => {
		const { deps, append, recordSend } = buildDeps();
		const body = echoBody();

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.status).toBe(200);
		expect(result.body.status).toBe("accepted");
		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: LEAD.id,
				direction: "outbound",
				waMessageId: "wamid-echo-1",
			}),
		);
		expect(recordSend).toHaveBeenCalledWith("num-1");
	});

	it("dedups our own automated send (existing wa_message_id) without double-counting", async () => {
		const { deps, append, recordSend, findByWaMessageId } = buildDeps();
		findByWaMessageId.mockResolvedValueOnce({
			id: "already",
			leadId: LEAD.id,
			direction: "outbound",
			content: "x",
			waMessageId: "wamid-echo-1",
			numberId: "num-1",
			createdAt: new Date(),
		} as MessageRecord);
		const body = echoBody();

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.body.status).toBe("duplicate");
		expect(append).not.toHaveBeenCalled();
		expect(recordSend).not.toHaveBeenCalled();
	});

	it("ignores an echo to a recipient that is not a known lead", async () => {
		const { deps, append, recordSend } = buildDeps({
			leads: {
				findByPhone: vi.fn(async () => null),
				create: vi.fn(async () => LEAD),
			},
		} as unknown as Partial<WahaWebhookDeps>);
		const body = echoBody();

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.body.status).toBe("ignored");
		expect(append).not.toHaveBeenCalled();
		expect(recordSend).not.toHaveBeenCalled();
	});
});
