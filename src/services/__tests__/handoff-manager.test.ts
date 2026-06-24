// Unit tests for the HandoffManager (HOT transition + event + cancel + notify).
//
// Exercises the ordered consequences of a handoff (Req 13): the Lead is moved to
// HOT before its outreach is cancelled, the handoff event is recorded with its
// reason, the consultant is alerted only when the Lead *newly* becomes HOT, a
// notifier failure never fails the handoff, and an unknown Lead surfaces the
// UnknownLeadError without recording an event.

import { describe, expect, it, vi } from "vitest";

import type { LifecycleState } from "@/core/types";
import type { TransitionResult } from "@/core/lifecycle";
import {
	createHandoffManager,
	type HandoffNotifier,
} from "@/services/handoff-manager";
import { UnknownLeadError, type LifecycleManager } from "@/services/lifecycle-manager";
import type {
	HandoffRecord,
	HandoffRepository,
	ScheduledJobRepository,
} from "@/services/repositories";

const LEAD_ID = "lead-1";

/** A lifecycle manager whose `apply` returns a scripted result and logs calls. */
function fakeLifecycle(
	result: TransitionResult | (() => TransitionResult),
	calls: string[],
): LifecycleManager {
	return {
		apply: vi.fn(async (leadId: string, to: LifecycleState) => {
			calls.push(`apply:${to}`);
			expect(leadId).toBe(LEAD_ID);
			return typeof result === "function" ? result() : result;
		}),
	} as unknown as LifecycleManager;
}

function fakeHandoffEvents(
	calls: string[],
): HandoffRepository & { appendEvent: ReturnType<typeof vi.fn> } {
	return {
		appendEvent: vi.fn(async (leadId: string, reason: string) => {
			calls.push("append");
			return {
				id: "evt-1",
				leadId,
				reason,
				createdAt: new Date(),
			} as HandoffRecord;
		}),
		listByLead: vi.fn(async () => []),
	} as unknown as HandoffRepository & { appendEvent: ReturnType<typeof vi.fn> };
}

function fakeScheduledJobs(
	calls: string[],
): ScheduledJobRepository & { cancelAllForLead: ReturnType<typeof vi.fn> } {
	return {
		cancelAllForLead: vi.fn(async () => {
			calls.push("cancel");
			return 0;
		}),
	} as unknown as ScheduledJobRepository & {
		cancelAllForLead: ReturnType<typeof vi.fn>;
	};
}

const okToHot: TransitionResult = { ok: true, from: "REPLIED", to: "HOT" };
const rejectedAlreadyHot: TransitionResult = {
	ok: false,
	reason: "invalid_transition",
	state: "HOT",
};

describe("HandoffManager", () => {
	it("moves the lead to HOT before cancelling outreach and records the event", async () => {
		const calls: string[] = [];
		const lifecycle = fakeLifecycle(okToHot, calls);
		const handoffEvents = fakeHandoffEvents(calls);
		const scheduledJobs = fakeScheduledJobs(calls);
		const manager = createHandoffManager({
			lifecycle,
			handoffEvents,
			scheduledJobs,
		});

		await manager.handoff(LEAD_ID, "replied");

		expect(lifecycle.apply).toHaveBeenCalledWith(LEAD_ID, "HOT");
		expect(handoffEvents.appendEvent).toHaveBeenCalledWith(
			LEAD_ID,
			"replied",
			expect.any(Date),
		);
		expect(scheduledJobs.cancelAllForLead).toHaveBeenCalledWith(LEAD_ID);
		// HOT (the silencing signal) must be persisted before the cancel runs.
		expect(calls.indexOf("apply:HOT")).toBeLessThan(calls.indexOf("cancel"));
	});

	it("alerts the consultant when the lead newly becomes HOT", async () => {
		const calls: string[] = [];
		const notifier: HandoffNotifier = { notify: vi.fn(async () => {}) };
		const manager = createHandoffManager({
			lifecycle: fakeLifecycle(okToHot, calls),
			handoffEvents: fakeHandoffEvents(calls),
			scheduledJobs: fakeScheduledJobs(calls),
			notifier,
		});

		await manager.handoff(LEAD_ID, "replied");

		expect(notifier.notify).toHaveBeenCalledWith(LEAD_ID, "replied");
	});

	it("does not re-alert when the lead is already HOT (transition rejected)", async () => {
		const calls: string[] = [];
		const notifier: HandoffNotifier = { notify: vi.fn(async () => {}) };
		const manager = createHandoffManager({
			lifecycle: fakeLifecycle(rejectedAlreadyHot, calls),
			handoffEvents: fakeHandoffEvents(calls),
			scheduledJobs: fakeScheduledJobs(calls),
			notifier,
		});

		await manager.handoff(LEAD_ID, "replied");

		// The event is still recorded and jobs re-cancelled, but no second alert.
		expect(notifier.notify).not.toHaveBeenCalled();
	});

	it("does not fail the handoff when the notifier throws", async () => {
		const calls: string[] = [];
		const notifier: HandoffNotifier = {
			notify: vi.fn(async () => {
				throw new Error("waha down");
			}),
		};
		const scheduledJobs = fakeScheduledJobs(calls);
		const manager = createHandoffManager({
			lifecycle: fakeLifecycle(okToHot, calls),
			handoffEvents: fakeHandoffEvents(calls),
			scheduledJobs,
			notifier,
		});

		await expect(manager.handoff(LEAD_ID, "replied")).resolves.toBeUndefined();
		expect(scheduledJobs.cancelAllForLead).toHaveBeenCalled();
	});

	it("propagates UnknownLeadError and records no event", async () => {
		const calls: string[] = [];
		const handoffEvents = fakeHandoffEvents(calls);
		const manager = createHandoffManager({
			lifecycle: fakeLifecycle(() => {
				throw new UnknownLeadError(LEAD_ID);
			}, calls),
			handoffEvents,
			scheduledJobs: fakeScheduledJobs(calls),
		});

		await expect(manager.handoff(LEAD_ID, "replied")).rejects.toBeInstanceOf(
			UnknownLeadError,
		);
		expect(handoffEvents.appendEvent).not.toHaveBeenCalled();
	});
});
