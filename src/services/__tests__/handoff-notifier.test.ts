// Unit tests for the WahaHandoffNotifier (consultant alert on handoff).
//
// Exercises the best-effort alert path: recipients are resolved lazily per
// notify and each one is alerted from the resolved sending number; an empty
// recipient list, a missing Lead, or no sending number skips the alert without
// throwing; and one failing recipient never stops the others.

import { describe, expect, it, vi } from "vitest";

import type { LeadSnapshot } from "@/core/types";
import {
	buildHandoffNotificationText,
	createHandoffNotifier,
	type WahaHandoffNotifierConfig,
} from "@/services/handoff-notifier";

const LEAD_ID = "lead-1";

function leadSnapshot(): LeadSnapshot {
	return {
		id: LEAD_ID,
		phoneE164: "+5547999990000",
		source: "landing",
		displayName: null,
		lifecycleState: "HOT",
		optInStatus: "opt_in",
		optInAt: new Date(),
		score: 70,
		blocked: false,
		unreachableAt: null,
		classificationBand: "HOT",
		qualification: {
			segment: null,
			creditValue: null,
			objective: null,
			income: null,
			hasLanceReserve: null,
		},
		assignedConsultantId: null,
		lastOutboundAt: null,
		lastInboundAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

/** Build a notifier over fakes, overridable per test. */
function makeNotifier(overrides: Partial<WahaHandoffNotifierConfig> = {}) {
	const waha = {
		resolveChatId: vi.fn(
			async (_numberId: string, e164: string) => `${e164.slice(1)}@c.us`,
		),
		sendText: vi.fn(async () => ({ waMessageId: "wa-msg-1" })),
	};
	const config: WahaHandoffNotifierConfig = {
		waha,
		leads: { findById: vi.fn(async () => leadSnapshot()) },
		resolveRecipients: vi.fn(async () => ["+5547111111111", "+5547222222222"]),
		resolveFromNumberId: vi.fn(async () => "num-1"),
		...overrides,
	};
	return { notifier: createHandoffNotifier(config), waha, config };
}

describe("WahaHandoffNotifier", () => {
	it("alerts every resolved recipient from the resolved sending number", async () => {
		const { notifier, waha } = makeNotifier();

		await notifier.notify(LEAD_ID, "replied");

		expect(waha.sendText).toHaveBeenCalledTimes(2);
		expect(waha.sendText).toHaveBeenCalledWith(
			"num-1",
			"5547111111111@c.us",
			expect.stringContaining("Novo lead para atendimento"),
		);
		expect(waha.sendText).toHaveBeenCalledWith(
			"num-1",
			"5547222222222@c.us",
			expect.stringContaining("+5547999990000"),
		);
	});

	it("resolves recipients per notify with the handed-off leadId", async () => {
		const { notifier, config } = makeNotifier();

		await notifier.notify(LEAD_ID, "replied");

		expect(config.resolveRecipients).toHaveBeenCalledWith(LEAD_ID);
	});

	it("skips the alert when no recipient resolves", async () => {
		const { notifier, waha } = makeNotifier({
			resolveRecipients: vi.fn(async () => []),
		});

		await expect(notifier.notify(LEAD_ID, "replied")).resolves.toBeUndefined();
		expect(waha.sendText).not.toHaveBeenCalled();
	});

	it("skips the alert when the lead is unknown", async () => {
		const { notifier, waha, config } = makeNotifier({
			leads: { findById: vi.fn(async () => null) },
		});

		await expect(notifier.notify(LEAD_ID, "replied")).resolves.toBeUndefined();
		expect(config.resolveRecipients).not.toHaveBeenCalled();
		expect(waha.sendText).not.toHaveBeenCalled();
	});

	it("skips the alert when no sending number is available", async () => {
		const { notifier, waha } = makeNotifier({
			resolveFromNumberId: vi.fn(async () => undefined),
		});

		await expect(notifier.notify(LEAD_ID, "replied")).resolves.toBeUndefined();
		expect(waha.sendText).not.toHaveBeenCalled();
	});

	it("keeps alerting remaining recipients when one send fails", async () => {
		const { notifier, waha } = makeNotifier();
		waha.sendText.mockRejectedValueOnce(new Error("waha down"));

		await expect(notifier.notify(LEAD_ID, "replied")).resolves.toBeUndefined();
		expect(waha.sendText).toHaveBeenCalledTimes(2);
	});
});

describe("buildHandoffNotificationText", () => {
	it("includes the reason, phone, score, and CRM deep link", () => {
		const text = buildHandoffNotificationText(
			leadSnapshot(),
			"hot_score",
			"https://crm.example.com",
		);

		expect(text).toContain("pontuação atingiu 70 (quente)");
		expect(text).toContain("+5547999990000");
		expect(text).toContain(`https://crm.example.com/crm/leads/${LEAD_ID}`);
	});
});
