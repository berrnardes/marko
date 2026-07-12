// Unit tests for the PhoneVerificationService (consultant phone verification).
//
// Exercises the code lifecycle over an in-memory verification repository:
// starting saves the normalized phone + hashed code and sends the code by
// WhatsApp; confirming stamps the verification only on a correct, unexpired
// code for the phone it was sent to; wrong guesses count toward the attempt
// cap; and a failed send never leaves a pending code behind.

import { describe, expect, it, vi } from "vitest";

import type { Clock } from "@/core/types";
import {
	buildVerificationText,
	createPhoneVerificationService,
	hashVerificationCode,
	type PhoneVerificationServiceConfig,
} from "@/services/phone-verification";
import type {
	PhoneVerificationRecord,
	PhoneVerificationRepository,
} from "@/services/repositories";

const USER_ID = "user-1";
const NOW = new Date("2026-07-11T12:00:00Z");

/** In-memory {@link PhoneVerificationRepository} (one row per user). */
function memoryVerifications(): PhoneVerificationRepository & {
	rows: Map<string, PhoneVerificationRecord>;
} {
	const rows = new Map<string, PhoneVerificationRecord>();
	return {
		rows,
		async upsert(input) {
			rows.set(input.userId, { ...input, attempts: 0, createdAt: NOW });
		},
		async findByUser(userId) {
			return rows.get(userId) ?? null;
		},
		async incrementAttempts(userId) {
			const row = rows.get(userId);
			if (!row) return 0;
			row.attempts += 1;
			return row.attempts;
		},
		async delete(userId) {
			rows.delete(userId);
		},
	};
}

/** Extract the 6-digit code from the sent WhatsApp text. */
function sentCode(sendText: ReturnType<typeof vi.fn>): string {
	const text = sendText.mock.calls[0][2] as string;
	const match = text.match(/\d{6}/);
	if (!match) throw new Error(`no code in sent text: ${text}`);
	return match[0];
}

function makeService(
	overrides: Partial<PhoneVerificationServiceConfig> = {},
) {
	const verifications = memoryVerifications();
	const consultants = {
		setPhone: vi.fn(async () => {}),
		stampPhoneVerified: vi.fn(async () => true),
	};
	const waha = {
		resolveChatId: vi.fn(async (e164: string) => `${e164.slice(1)}@c.us`),
		sendText: vi.fn(async () => ({ waMessageId: "wa-1" })),
	};
	const clock: Clock = { now: () => NOW };
	const service = createPhoneVerificationService({
		verifications,
		consultants,
		waha,
		resolveFromNumberId: async () => "num-1",
		listSystemNumbers: async () => [],
		clock,
		...overrides,
	});
	return { service, verifications, consultants, waha };
}

describe("PhoneVerificationService.start", () => {
	it("saves the normalized phone, stores a hashed code, and sends it", async () => {
		const { service, verifications, consultants, waha } = makeService();

		const result = await service.start(USER_ID, "(47) 99633-4573");

		expect(result).toMatchObject({ ok: true, phoneE164: "+5547996334573" });
		expect(consultants.setPhone).toHaveBeenCalledWith(
			USER_ID,
			"+5547996334573",
		);
		const row = verifications.rows.get(USER_ID);
		const code = sentCode(waha.sendText);
		expect(row?.codeHash).toBe(hashVerificationCode(code));
		expect(row?.codeHash).not.toContain(code);
		expect(waha.sendText).toHaveBeenCalledWith(
			"num-1",
			"5547996334573@c.us",
			buildVerificationText(code),
		);
	});

	it("rejects an invalid phone without mutating anything", async () => {
		const { service, verifications, consultants, waha } = makeService();

		const result = await service.start(USER_ID, "123");

		expect(result).toEqual({ ok: false, reason: "invalid_phone" });
		expect(consultants.setPhone).not.toHaveBeenCalled();
		expect(verifications.rows.size).toBe(0);
		expect(waha.sendText).not.toHaveBeenCalled();
	});

	it("rejects a system sending number without mutating anything", async () => {
		const { service, verifications, consultants, waha } = makeService({
			listSystemNumbers: async () => ["+5547996334573"],
		});

		const result = await service.start(USER_ID, "(47) 99633-4573");

		expect(result).toEqual({ ok: false, reason: "system_number" });
		expect(consultants.setPhone).not.toHaveBeenCalled();
		expect(verifications.rows.size).toBe(0);
		expect(waha.sendText).not.toHaveBeenCalled();
	});

	it("rejects a system number stored in the legacy 9th-digit-less form", async () => {
		const { service } = makeService({
			listSystemNumbers: async () => ["+554796334573"],
		});

		const result = await service.start(USER_ID, "47996334573");

		expect(result).toEqual({ ok: false, reason: "system_number" });
	});

	it("fails cleanly when no sending number is registered", async () => {
		const { service, consultants } = makeService({
			resolveFromNumberId: async () => undefined,
		});

		const result = await service.start(USER_ID, "47996334573");

		expect(result).toEqual({ ok: false, reason: "no_sending_number" });
		expect(consultants.setPhone).not.toHaveBeenCalled();
	});

	it("drops the pending code when the WhatsApp send fails", async () => {
		const { service, verifications, waha } = makeService();
		waha.sendText.mockRejectedValueOnce(new Error("waha down"));

		const result = await service.start(USER_ID, "47996334573");

		expect(result).toEqual({ ok: false, reason: "send_failed" });
		expect(verifications.rows.size).toBe(0);
	});

	it("replaces a previous pending verification on restart", async () => {
		const { service, verifications, waha } = makeService();

		await service.start(USER_ID, "47996334573");
		const firstCode = sentCode(waha.sendText);
		await service.start(USER_ID, "47996334573");

		const row = verifications.rows.get(USER_ID);
		expect(row?.attempts).toBe(0);
		expect(row?.codeHash).not.toBe(hashVerificationCode(firstCode));
	});
});

describe("PhoneVerificationService.confirm", () => {
	it("stamps the verification and drops the pending code on a match", async () => {
		const { service, verifications, consultants, waha } = makeService();
		await service.start(USER_ID, "47996334573");
		const code = sentCode(waha.sendText);

		const result = await service.confirm(USER_ID, ` ${code} `);

		expect(result).toEqual({ ok: true, phoneE164: "+5547996334573" });
		expect(consultants.stampPhoneVerified).toHaveBeenCalledWith(
			USER_ID,
			"+5547996334573",
			NOW,
		);
		expect(verifications.rows.size).toBe(0);
	});

	it("reports no pending verification", async () => {
		const { service } = makeService();

		expect(await service.confirm(USER_ID, "000000")).toEqual({
			ok: false,
			reason: "no_pending",
		});
	});

	it("expires a stale code and drops it", async () => {
		const { service, verifications, waha } = makeService({ codeTtlMs: -1 });
		await service.start(USER_ID, "47996334573");
		const code = sentCode(waha.sendText);

		const result = await service.confirm(USER_ID, code);

		expect(result).toEqual({ ok: false, reason: "expired" });
		expect(verifications.rows.size).toBe(0);
	});

	it("counts wrong guesses and discards the code at the attempt cap", async () => {
		const { service, verifications, waha } = makeService({ maxAttempts: 2 });
		await service.start(USER_ID, "47996334573");
		const code = sentCode(waha.sendText);
		const wrong = code === "000000" ? "000001" : "000000";

		expect(await service.confirm(USER_ID, wrong)).toEqual({
			ok: false,
			reason: "invalid_code",
			attemptsLeft: 1,
		});
		expect(await service.confirm(USER_ID, wrong)).toEqual({
			ok: false,
			reason: "too_many_attempts",
		});
		expect(verifications.rows.size).toBe(0);
		// The correct code no longer works once the verification is discarded.
		expect(await service.confirm(USER_ID, code)).toEqual({
			ok: false,
			reason: "no_pending",
		});
	});

	it("does not stamp when the phone changed since the code was sent", async () => {
		const { service, verifications, consultants, waha } = makeService();
		consultants.stampPhoneVerified.mockResolvedValueOnce(false);
		await service.start(USER_ID, "47996334573");
		const code = sentCode(waha.sendText);

		const result = await service.confirm(USER_ID, code);

		expect(result).toEqual({ ok: false, reason: "phone_changed" });
		expect(verifications.rows.size).toBe(0);
	});
});
