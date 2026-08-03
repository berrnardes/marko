// Unit tests for the webhook's outbound-echo ingestion (beta WhatsApp Web flow).
//
// A consultant's reply typed on a WhatsApp Web linked device arrives as a
// `fromMe: true` echo. These tests cover the three behaviors that close the
// history + anti-ban gaps: a new echo is recorded as outbound history and
// counted against the sending number's cap; our own automated send (same
// `wa_message_id`) dedups to a no-op; and an echo to a non-lead is ignored.
//
// Plus the tenancy gate the retrofit added: a delivery whose WAHA session no
// registered number owns resolves to no organization and is dropped with a
// `200`, before any repository is touched.

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
	displayName: null,
	lifecycleState: "REPLIED",
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

/**
 * Build the webhook dependencies around an in-memory tenant scope.
 *
 * In production `resolveSession` maps the WAHA session to the organization that
 * registered it, and `withScope` opens the RLS transaction that the tenant's
 * repositories run in. Here both are fakes: pass `null` to exercise the
 * unknown-session path, or override individual repositories.
 *
 * `withScope` also records whether it was entered, which is how the tests
 * assert that nothing is read or written before a tenant is known.
 */
function buildDeps(scopeOver: Record<string, unknown> | null = {}): {
	deps: WahaWebhookDeps;
	append: ReturnType<typeof vi.fn>;
	recordSend: ReturnType<typeof vi.fn>;
	findByWaMessageId: ReturnType<typeof vi.fn>;
	resolveSession: ReturnType<typeof vi.fn>;
	withScope: ReturnType<typeof vi.fn>;
} {
	const append = vi.fn(async () => ({ id: "msg-1" }) as MessageRecord);
	const recordSend = vi.fn(async () => 1);
	const findByWaMessageId = vi.fn(async () => null as MessageRecord | null);
	const owner =
		scopeOver === null
			? null
			: { organizationId: "org-1", numberId: "num-1" };
	const scope = {
		leads: {
			findByPhone: vi.fn(async () => LEAD),
			create: vi.fn(async () => LEAD),
		},
		messages: { append, findByWaMessageId },
		antiBan: { recordSend },
		...(scopeOver ?? {}),
	};
	const resolveSession = vi.fn(async () => owner);
	const withScope = vi.fn(
		async (_owner: unknown, fn: (s: unknown) => Promise<unknown>) => fn(scope),
	);
	const deps = {
		secret: SECRET,
		resolveSession,
		withScope,
		queue: () => ({ enqueueInbound: vi.fn(async () => "job-1") }),
	} as unknown as WahaWebhookDeps;
	return {
		deps,
		append,
		recordSend,
		findByWaMessageId,
		resolveSession,
		withScope,
	};
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
		});
		const body = echoBody();

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.body.status).toBe("ignored");
		expect(append).not.toHaveBeenCalled();
		expect(recordSend).not.toHaveBeenCalled();
	});
});

describe("webhook tenant resolution", () => {
	it("drops a delivery whose session no organization owns, before any read", async () => {
		const { deps, append, recordSend, findByWaMessageId, resolveSession, withScope } =
			buildDeps(null);
		const body = echoBody();

		const result = await processWahaWebhook(deps, body, sign(body));

		// Acknowledged, not 5xx: WAHA retries on error, and an unowned session
		// would be redelivered forever.
		expect(result.status).toBe(200);
		expect(result.body.status).toBe("ignored");
		expect(result.body.reason).toBe("unknown_session");
		expect(resolveSession).toHaveBeenCalledWith("default");
		// No tenant, so no scoped unit of work was ever entered — nothing was
		// read and nothing was written.
		expect(withScope).not.toHaveBeenCalled();
		expect(findByWaMessageId).not.toHaveBeenCalled();
		expect(append).not.toHaveBeenCalled();
		expect(recordSend).not.toHaveBeenCalled();
	});

	it("resolves the tenant before opening the scoped unit of work", async () => {
		const { deps, resolveSession, withScope } = buildDeps();
		const inbound = JSON.stringify({
			event: "message",
			session: "org-b-session",
			payload: {
				id: "wamid-in-1",
				from: "5547996334573@c.us",
				body: "oi",
				timestamp: 1_782_245_765,
			},
		});

		const result = await processWahaWebhook(deps, inbound, sign(inbound));

		expect(result.body.status).toBe("accepted");
		expect(resolveSession).toHaveBeenCalledWith("org-b-session");
		// The persistence work ran as the resolved tenant.
		expect(withScope).toHaveBeenCalledWith(
			{ organizationId: "org-1", numberId: "num-1" },
			expect.any(Function),
		);
	});

	it("resolves a @lid sender BEFORE entering the transaction", async () => {
		// The `@lid` lookup is a WAHA HTTP round trip. Under RLS the scoped unit
		// of work holds a pooled PgBouncer connection, so the resolution must
		// happen outside it — this pins that ordering.
		const { deps, withScope } = buildDeps();
		const calls: string[] = [];
		(deps as { lids?: unknown }).lids = {
			resolveLidToPhone: async () => {
				calls.push("lid");
				return "5547996334573@c.us";
			},
		};
		(deps as { withScope: unknown }).withScope = async (
			_owner: unknown,
			fn: (s: unknown) => Promise<unknown>,
		) => {
			calls.push("scope");
			return fn({
				leads: { findByPhone: async () => LEAD, create: async () => LEAD },
				messages: {
					append: async () => ({ id: "msg-1" }) as MessageRecord,
					findByWaMessageId: async () => null,
				},
			});
		};
		const inbound = JSON.stringify({
			event: "message",
			session: "default",
			payload: {
				id: "wamid-lid-1",
				from: "96817169588265@lid",
				body: "oi",
				timestamp: 1_782_245_765,
			},
		});

		const result = await processWahaWebhook(deps, inbound, sign(inbound));

		expect(result.body.status).toBe("accepted");
		expect(calls).toEqual(["lid", "scope"]);
		expect(withScope).not.toHaveBeenCalled(); // replaced above
	});
});

// ---------------------------------------------------------------------------
// Real GOWS payloads (regression — ADR-005)
// ---------------------------------------------------------------------------
//
// These fixtures are COPIED FROM A LIVE WAHA (2026.7.2, engine GOWS), not
// hand-written. The bug they pin existed precisely because the fixtures above
// were idealized: they always set `to` to a chat id, while GOWS sends
// `"to": null` on every inbound message. `z.string().optional()` accepts
// `undefined` but rejects a present `null`, so every real reply failed
// `safeParse` and was answered `400 invalid_body` — WAHA retried 15 times and
// discarded the message. No inbound was ever persisted or enqueued, so the lead
// never left `IN_CADENCE`, no handoff fired, and the cadence kept sending.

/** An inbound message shaped exactly as the GOWS engine delivers it. */
function inboundBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		event: "message",
		session: "default",
		payload: {
			id: "false_164789355544698@lid_6AD56CCE746613628E4D",
			timestamp: 1_771_855_213,
			from: "5547996334573@c.us",
			fromMe: false,
			source: "app",
			body: "Oi, tenho interesse sim",
			// The field that broke everything: GOWS sends null, not undefined.
			to: null,
			participant: null,
			hasMedia: false,
			media: null,
			ack: null,
			location: null,
			vCards: null,
			ackName: "UNKNOWN",
			replyTo: null,
			...overrides,
		},
	});
}

describe("webhook GOWS payload compatibility", () => {
	it('accepts an inbound whose "to" is null (the reply-handoff regression)', async () => {
		const { deps, append, findByWaMessageId } = buildDeps();
		const enqueueInbound = vi.fn(async () => "job-1");
		(deps as { queue: unknown }).queue = () => ({ enqueueInbound });
		const body = inboundBody();

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.status).toBe(200);
		expect(result.body.status).toBe("accepted");
		// Persisted as inbound history...
		expect(findByWaMessageId).toHaveBeenCalledWith(
			"false_164789355544698@lid_6AD56CCE746613628E4D",
		);
		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: LEAD.id,
				direction: "inbound",
				content: "Oi, tenho interesse sim",
			}),
		);
		// ...and handed to the worker, which is what runs the handoff pipeline.
		expect(enqueueInbound).toHaveBeenCalledWith(
			expect.objectContaining({ leadId: LEAD.id, text: "Oi, tenho interesse sim" }),
		);
	});

	it('accepts a media-only inbound whose "body" is null, as empty content', async () => {
		const { deps, append } = buildDeps();
		const body = inboundBody({ body: null, hasMedia: true });

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.body.status).toBe("accepted");
		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "inbound", content: "" }),
		);
	});

	it("resolves a null-to inbound from a @lid sender end to end", async () => {
		// The full captured shape: GOWS delivers BOTH a `@lid` sender and a null
		// `to`. Neither may block attribution.
		const { deps, append } = buildDeps();
		(deps as { lids?: unknown }).lids = {
			resolveLidToPhone: async () => "5547996334573@c.us",
		};
		const body = inboundBody({ from: "164789355544698@lid" });

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.body.status).toBe("accepted");
		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "inbound" }),
		);
	});

	it('ignores a fromMe echo whose "to" is null, without touching the tenant', async () => {
		// A `fromMe` echo is attributed by `to`; normalizing null to undefined must
		// still hit the `if (!recipient)` guard rather than attributing to nobody.
		const { deps, append, withScope } = buildDeps();
		const body = inboundBody({ fromMe: true, to: null });

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.status).toBe(200);
		expect(result.body.status).toBe("ignored");
		expect(withScope).not.toHaveBeenCalled();
		expect(append).not.toHaveBeenCalled();
	});
});

describe("webhook un-processable deliveries are acknowledged, not rejected", () => {
	// ADR-005: WAHA retries any non-2xx 15 times and then DISCARDS the event. For
	// a permanently un-processable delivery that trades one dropped message for
	// sixteen, so these are answered 200 + logged instead.

	it("acknowledges a message event with a malformed payload", async () => {
		const { deps, withScope } = buildDeps();
		const body = inboundBody({ from: undefined });

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.status).toBe(200);
		expect(result.body.status).toBe("ignored");
		expect(result.body.reason).toBe("invalid_body");
		expect(withScope).not.toHaveBeenCalled();
	});

	it("acknowledges a sender that cannot be normalized to E.164", async () => {
		const { deps, withScope } = buildDeps();
		const body = inboundBody({ from: "123@c.us" });

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.status).toBe(200);
		expect(result.body.reason).toBe("invalid_sender");
		expect(withScope).not.toHaveBeenCalled();
	});

	it("acknowledges a @lid sender WAHA has no mapping for", async () => {
		const { deps, withScope } = buildDeps();
		(deps as { lids?: unknown }).lids = {
			resolveLidToPhone: async () => null,
		};
		const body = inboundBody({ from: "164789355544698@lid" });

		const result = await processWahaWebhook(deps, body, sign(body));

		expect(result.status).toBe(200);
		expect(result.body.reason).toBe("unresolved_lid");
		expect(withScope).not.toHaveBeenCalled();
	});

	it("still rejects a bad signature with 401, and a non-JSON body with 400", async () => {
		// The two carve-outs: a signature failure is a real security rejection, and
		// a non-JSON body did not come from WAHA's WebhookSender at all.
		const { deps } = buildDeps();

		const badSig = await processWahaWebhook(deps, inboundBody(), "deadbeef");
		expect(badSig.status).toBe(401);
		expect(badSig.body.reason).toBe("invalid_signature");

		const notJson = await processWahaWebhook(deps, "<html>", sign("<html>"));
		expect(notJson.status).toBe(400);
		expect(notJson.body.reason).toBe("invalid_json");
	});
});
