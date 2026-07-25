// Unit tests for the Outbound_Worker choke point (task 14.1).
//
// These exercise the design's choke-point ordering and gates against in-memory
// fakes: opt-out drop (Req 15.3), blocked-number stop (Req 18.2), send-window
// and daily-cap deferral (Req 17.4, 16.2), randomized pacing (Req 17.1), typing
// presence before the single send (Req 17.2), and the confirmed-send commit
// that increments the counter while recording the message (Req 16.2). The named
// property test for blocked-number silencing (Property 23) is the separate,
// optional task 14.2 and is not implemented here.

import type { SendDecision } from "@/core/anti-ban";
import type { Clock, LeadSnapshot } from "@/core/types";
import type { AntiBanController } from "@/services/anti-ban-controller";
import { UnknownLeadError } from "@/services/lifecycle-manager";
import {
	createOutboundWorker,
	type ConfirmedSend,
	type ConfirmedSendResult,
	type OutboundSendCommitter,
	type OutboundSendJob,
} from "@/services/outbound-worker";
import type { LeadRepository, MessageRecord } from "@/services/repositories";
import type { WahaClient } from "@/services/waha-client";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2024-03-10T13:00:00.000Z");

function makeLead(overrides: Partial<LeadSnapshot> = {}): LeadSnapshot {
	return {
		id: "lead-1",
		phoneE164: "+5511987654321",
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
		createdAt: FIXED_NOW,
		updatedAt: FIXED_NOW,
		...overrides,
	};
}

const clock: Clock = { now: () => FIXED_NOW };

const JOB: OutboundSendJob = {
	leadId: "lead-1",
	numberId: "number-1",
	content: "Olá! Ainda faz sentido falar de consórcio?",
	kind: "cadence",
};

/** Build a `LeadRepository` whose `findById` returns `lead` (or null). */
function leadRepoReturning(lead: LeadSnapshot | null): LeadRepository {
	return {
		findById: vi.fn(async () => lead),
		findByPhone: vi.fn(),
		create: vi.fn(),
		updateQualification: vi.fn(),
		updateScore: vi.fn(),
		updateLifecycleState: vi.fn(),
		setOptInStatus: vi.fn(),
		setBlocked: vi.fn(),
		assignConsultant: vi.fn(),
	} as unknown as LeadRepository;
}

/**
 * Build a `LeadRepository` whose `findById` returns each entry of `leads` in
 * turn (the last entry repeats once exhausted), so a test can model the lead's
 * state changing between the pre-pacing read and the post-pacing re-read.
 */
function leadRepoSequence(leads: (LeadSnapshot | null)[]): LeadRepository {
	let call = 0;
	return {
		findById: vi.fn(async () => leads[Math.min(call++, leads.length - 1)]),
		findByPhone: vi.fn(),
		create: vi.fn(),
		updateQualification: vi.fn(),
		updateScore: vi.fn(),
		updateLifecycleState: vi.fn(),
		setOptInStatus: vi.fn(),
		setBlocked: vi.fn(),
		assignConsultant: vi.fn(),
	} as unknown as LeadRepository;
}

/** Build an `AntiBanController` whose `evaluate` yields `decision`. */
function antiBanWith(
	decision: SendDecision,
	delayMs = 1234,
): AntiBanController {
	return {
		evaluate: vi.fn(async () => decision),
		canAssignSend: vi.fn(),
		currentCap: vi.fn(),
		recordSend: vi.fn(async () => 1),
		resetDailyCounter: vi.fn(),
		markBlocked: vi.fn(),
		setBlocked: vi.fn(),
		isBlocked: vi.fn(),
		nextDelayMs: vi.fn(() => delayMs),
		withinSendWindow: vi.fn(() => true),
	} as unknown as AntiBanController;
}

/** Build a `WahaClient` recording call order into `order`. */
function wahaRecording(order: string[], waMessageId = "wamid.1"): WahaClient {
	return {
		resolveSendTarget: vi.fn(async () => {
			order.push("resolveSendTarget");
			return { reachable: true, chatId: "5511987654321@c.us" };
		}),
		resolveChatId: vi.fn(async () => {
			order.push("resolveChatId");
			return "5511987654321@c.us";
		}),
		sendText: vi.fn(async () => {
			order.push("sendText");
			return { waMessageId };
		}),
		startTyping: vi.fn(async () => {
			order.push("startTyping");
		}),
		stopTyping: vi.fn(async () => {
			order.push("stopTyping");
		}),
		sendSeen: vi.fn(),
	} as unknown as WahaClient;
}

/** A committer that records the confirmed send and reports a daily count. */
function recordingCommitter(dailyCount = 7): {
	committer: OutboundSendCommitter;
	calls: ConfirmedSend[];
} {
	const calls: ConfirmedSend[] = [];
	const committer: OutboundSendCommitter = {
		commit: vi.fn(async (send: ConfirmedSend): Promise<ConfirmedSendResult> => {
			calls.push(send);
			const message: MessageRecord = {
				id: "msg-1",
				leadId: send.leadId,
				direction: "outbound",
				content: send.content,
				waMessageId: send.waMessageId,
				numberId: send.numberId,
				createdAt: send.sentAt,
			};
			return { dailyCount, message };
		}),
	};
	return { committer, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OutboundWorker.process", () => {
	let sleep: Mock<(ms: number) => Promise<void>>;

	beforeEach(() => {
		sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
	});

	it("drops the send when the lead has opted out and never goes outbound (Req 15.3)", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		const { committer, calls } = recordingCommitter();
		const antiBan = antiBanWith("allow");
		const worker = createOutboundWorker({
			leads: leadRepoReturning(makeLead({ optInStatus: "opt_out" })),
			antiBan,
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		expect(outcome).toEqual({ status: "dropped_opt_out", leadId: "lead-1" });
		expect(antiBan.evaluate).not.toHaveBeenCalled();
		expect(waha.sendText).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
		expect(order).toEqual([]);
	});

	it("drops a queued send when the lead reached a stop state after enqueue, e.g. handed off to a consultant (Req 5.2, 13.4)", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		const { committer, calls } = recordingCommitter();
		const antiBan = antiBanWith("allow");
		const worker = createOutboundWorker({
			// The lead replied and was handed off (→ HOT) after the cadence touch
			// enqueued this send but before the choke point drained it.
			leads: leadRepoReturning(makeLead({ lifecycleState: "REPLIED" })),
			antiBan,
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		expect(outcome).toEqual({ status: "dropped_stopped", leadId: "lead-1" });
		expect(antiBan.evaluate).not.toHaveBeenCalled();
		expect(waha.sendText).not.toHaveBeenCalled();
		expect(sleep).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
		expect(order).toEqual([]);
	});

	it("drops the send when the lead is handed off DURING the pacing wait, re-reading fresh state before sending (Req 5.2, 13.4)", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		const { committer, calls } = recordingCommitter();
		const antiBan = antiBanWith("allow");
		// First read (pre-pacing) sees an in-cadence lead and proceeds; the lead
		// replies and is handed off (→ HOT) while the pacing sleep is awaited, so
		// the second read (post-pacing) must see HOT and drop before the send.
		const leads = leadRepoSequence([
			makeLead({ lifecycleState: "IN_CADENCE" }),
			makeLead({ lifecycleState: "REPLIED" }),
		]);
		const worker = createOutboundWorker({
			leads,
			antiBan,
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		expect(outcome).toEqual({ status: "dropped_stopped", leadId: "lead-1" });
		// It passed the early gate and the anti-ban evaluate, paced, then re-read.
		expect(antiBan.evaluate).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(leads.findById).toHaveBeenCalledTimes(2);
		// No message ever went out and nothing was committed.
		expect(waha.sendText).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
		expect(order).toEqual([]);
	});

	it("stops without sending when the number's block flag is set (Req 18.2, 18.3)", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		const { committer, calls } = recordingCommitter();
		const worker = createOutboundWorker({
			leads: leadRepoReturning(makeLead()),
			antiBan: antiBanWith("blocked"),
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		expect(outcome).toEqual({
			status: "blocked",
			leadId: "lead-1",
			numberId: "number-1",
		});
		expect(waha.sendText).not.toHaveBeenCalled();
		expect(sleep).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it("defers outside the send window without sending (Req 17.4)", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		const { committer } = recordingCommitter();
		const worker = createOutboundWorker({
			leads: leadRepoReturning(makeLead()),
			antiBan: antiBanWith("defer_window"),
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		expect(outcome).toEqual({
			status: "deferred_window",
			leadId: "lead-1",
			numberId: "number-1",
		});
		expect(waha.sendText).not.toHaveBeenCalled();
	});

	it("defers to the next day when the daily cap is reached (Req 16.2)", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		const { committer } = recordingCommitter();
		const worker = createOutboundWorker({
			leads: leadRepoReturning(makeLead()),
			antiBan: antiBanWith("defer_cap"),
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		expect(outcome).toEqual({
			status: "deferred_cap",
			leadId: "lead-1",
			numberId: "number-1",
		});
		expect(waha.sendText).not.toHaveBeenCalled();
	});

	it("paces, simulates typing before sending, then commits the confirmed send (Req 17.1, 17.2, 16.2)", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order, "wamid.42");
		const { committer, calls } = recordingCommitter(7);
		const antiBan = antiBanWith("allow", 999);
		const worker = createOutboundWorker({
			leads: leadRepoReturning(makeLead()),
			antiBan,
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		// Randomized delay (Req 17.1) waited before the send.
		expect(antiBan.nextDelayMs).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(999);

		// Typing presence is started before the single send (Req 17.2), and the
		// indicator is stopped afterwards.
		expect(order).toEqual([
			"resolveSendTarget",
			"startTyping",
			"sendText",
			"stopTyping",
		]);

		// Confirmed send committed once with the sent message's id + timestamp.
		expect(calls).toEqual([
			{
				leadId: "lead-1",
				numberId: "number-1",
				content: JOB.content,
				waMessageId: "wamid.42",
				sentAt: FIXED_NOW,
			},
		]);

		expect(outcome).toEqual({
			status: "sent",
			leadId: "lead-1",
			numberId: "number-1",
			waMessageId: "wamid.42",
			dailyCount: 7,
		});
	});

	it("stops the typing indicator even when the send fails, and propagates the error", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		(waha.sendText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("sendText");
			throw new Error("WAHA 500");
		});
		const { committer, calls } = recordingCommitter();
		const worker = createOutboundWorker({
			leads: leadRepoReturning(makeLead()),
			antiBan: antiBanWith("allow"),
			waha,
			commit: committer,
			clock,
			sleep,
		});

		await expect(worker.process(JOB)).rejects.toThrow("WAHA 500");
		// Counter is incremented only on a confirmed send: no commit on failure.
		expect(calls).toHaveLength(0);
		expect(order).toEqual([
			"resolveSendTarget",
			"startTyping",
			"sendText",
			"stopTyping",
		]);
	});

	it("throws UnknownLeadError when the lead does not exist", async () => {
		const worker = createOutboundWorker({
			leads: leadRepoReturning(null),
			antiBan: antiBanWith("allow"),
			waha: wahaRecording([]),
			commit: recordingCommitter().committer,
			clock,
			sleep,
		});

		await expect(worker.process(JOB)).rejects.toBeInstanceOf(UnknownLeadError);
	});

	it("drops as dropped_unreachable when WAHA reports the number does not exist — no send, no commit", async () => {
		const order: string[] = [];
		const waha = wahaRecording(order);
		// The existence gate reports the number is not on WhatsApp.
		(
			waha.resolveSendTarget as ReturnType<typeof vi.fn>
		).mockImplementation(async () => {
			order.push("resolveSendTarget");
			return { reachable: false };
		});
		const { committer, calls } = recordingCommitter();
		const worker = createOutboundWorker({
			leads: leadRepoReturning(makeLead()),
			antiBan: antiBanWith("allow"),
			waha,
			commit: committer,
			clock,
			sleep,
		});

		const outcome = await worker.process(JOB);

		expect(outcome).toEqual({ status: "dropped_unreachable", leadId: "lead-1" });
		// No send is attempted and the daily cap is never incremented.
		expect(waha.sendText).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
		// The gate ran but typing/sending never started.
		expect(order).toEqual(["resolveSendTarget"]);
	});
});
