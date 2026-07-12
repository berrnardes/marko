// Consultant phone verification (I/O boundary — prove the alert phone works).
//
// A consultant only receives handoff alerts on a *verified* phone
// (`user.phone_verified_at`), so a typo can never route lead alerts to a
// stranger. This service owns that loop: `start` saves the phone (resetting
// any previous verification), generates a 6-digit code, and sends it by
// WhatsApp from the org's own sending number — which doubles as an end-to-end
// proof that the WAHA pipeline can reach the consultant; `confirm` checks the
// code against the stored SHA-256 hash and stamps the verification.
//
// Side-effect boundary: persists through the injected repositories and sends
// through the injected `WahaClient` only. Codes are stored hashed with a short
// expiry and a wrong-guess cap, and every failure mode is a typed result — the
// API routes translate them to HTTP without this module knowing about HTTP.

import { createHash, randomInt } from "node:crypto";

import { brazilianPhoneVariants, normalizePhone } from "@/core/phone";
import type { Clock } from "@/core/types";
import { logger } from "@/logger";
import type {
	ConsultantRepository,
	PhoneVerificationRepository,
} from "@/services/repositories";
import type { WahaClient } from "@/services/waha-client";

/** How long a sent code stays valid. */
const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses allowed before the pending verification is discarded. */
const DEFAULT_MAX_ATTEMPTS = 5;

/** Construction dependencies for {@link createPhoneVerificationService}. */
export interface PhoneVerificationServiceConfig {
	/** Pending-code persistence (one per user). */
	verifications: PhoneVerificationRepository;
	/** Phone + verification-stamp writes on the user row. */
	consultants: Pick<ConsultantRepository, "setPhone" | "stampPhoneVerified">;
	/** Send the code text and resolve the recipient chat id. */
	waha: Pick<WahaClient, "resolveChatId" | "sendText">;
	/**
	 * Resolve the domain `numberId` the code is sent *from* (the org's first
	 * available number, same default as the handoff notifier). `undefined`
	 * means nothing can send and `start` fails without persisting.
	 */
	resolveFromNumberId: () => Promise<string | undefined>;
	/**
	 * The msisdns of every registered sending number (blocked ones included).
	 * A consultant may never use one as their alert phone: the code would be
	 * sent from the number to itself, and alerts to a bot number would flow
	 * back through the inbound webhook as if a lead had replied.
	 */
	listSystemNumbers: () => Promise<string[]>;
	clock: Clock;
	codeTtlMs?: number;
	maxAttempts?: number;
}

/** Outcome of {@link PhoneVerificationService.start}. */
export type StartVerificationResult =
	| { ok: true; phoneE164: string; expiresAt: Date }
	| {
			ok: false;
			reason:
				| "invalid_phone"
				| "system_number"
				| "no_sending_number"
				| "send_failed";
	  };

/** Outcome of {@link PhoneVerificationService.confirm}. */
export type ConfirmVerificationResult =
	| { ok: true; phoneE164: string }
	| { ok: false; reason: "no_pending" | "expired" | "too_many_attempts" | "phone_changed" }
	| { ok: false; reason: "invalid_code"; attemptsLeft: number };

/** The consultant phone verification loop (see module doc). */
export interface PhoneVerificationService {
	/** Save `rawPhone` (unverified) and send it a fresh 6-digit code. */
	start(userId: string, rawPhone: string): Promise<StartVerificationResult>;
	/** Check `code` against the pending verification and stamp on match. */
	confirm(userId: string, code: string): Promise<ConfirmVerificationResult>;
}

/** SHA-256 hex of a verification code (codes are never stored in the clear). */
export function hashVerificationCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}

/** A cryptographically random zero-padded 6-digit code. */
function generateCode(): string {
	return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Build the PT-BR WhatsApp message carrying the code. */
export function buildVerificationText(code: string): string {
	return (
		`Marko: seu código de verificação é ${code}. ` +
		"Ele expira em 10 minutos. Se você não solicitou, ignore esta mensagem."
	);
}

/** Construct the {@link PhoneVerificationService} over its dependencies. */
export function createPhoneVerificationService(
	config: PhoneVerificationServiceConfig,
): PhoneVerificationService {
	const {
		verifications,
		consultants,
		waha,
		resolveFromNumberId,
		listSystemNumbers,
		clock,
		codeTtlMs = DEFAULT_CODE_TTL_MS,
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
	} = config;

	return {
		async start(userId, rawPhone): Promise<StartVerificationResult> {
			const phoneE164 = normalizePhone(rawPhone, "BR");
			if (phoneE164 === null) {
				return { ok: false, reason: "invalid_phone" };
			}
			// A system sending number is never a valid alert phone. Compare across
			// the 9th-digit variants (Req 1.4): the WAHA-derived msisdn may carry
			// the legacy short form of the same mobile number.
			const inputVariants = new Set(brazilianPhoneVariants(phoneE164));
			const systemNumbers = await listSystemNumbers();
			if (systemNumbers.some((msisdn) => inputVariants.has(msisdn))) {
				return { ok: false, reason: "system_number" };
			}
			// Resolve the sending number before mutating anything, so "no number
			// connected yet" fails cleanly without a half-started verification.
			const fromNumberId = await resolveFromNumberId();
			if (!fromNumberId) {
				return { ok: false, reason: "no_sending_number" };
			}

			const code = generateCode();
			const expiresAt = new Date(clock.now().getTime() + codeTtlMs);
			await consultants.setPhone(userId, phoneE164);
			await verifications.upsert({
				userId,
				phoneE164,
				codeHash: hashVerificationCode(code),
				expiresAt,
			});

			try {
				const chatId = await waha.resolveChatId(fromNumberId, phoneE164);
				await waha.sendText(fromNumberId, chatId, buildVerificationText(code));
			} catch (err) {
				// The code never reached the phone — drop it so the user retries
				// from a clean slate (the unverified phone itself stays saved).
				await verifications.delete(userId);
				logger.error(
					{ event: "phone_verify.send_failed", userId, err },
					"failed to send verification code",
				);
				return { ok: false, reason: "send_failed" };
			}
			logger.info(
				{ event: "phone_verify.started", userId },
				"verification code sent",
			);
			return { ok: true, phoneE164, expiresAt };
		},

		async confirm(userId, code): Promise<ConfirmVerificationResult> {
			const pending = await verifications.findByUser(userId);
			if (!pending) {
				return { ok: false, reason: "no_pending" };
			}
			const now = clock.now();
			if (now.getTime() > pending.expiresAt.getTime()) {
				await verifications.delete(userId);
				return { ok: false, reason: "expired" };
			}
			if (hashVerificationCode(code.trim()) !== pending.codeHash) {
				const attempts = await verifications.incrementAttempts(userId);
				if (attempts >= maxAttempts) {
					await verifications.delete(userId);
					return { ok: false, reason: "too_many_attempts" };
				}
				return {
					ok: false,
					reason: "invalid_code",
					attemptsLeft: maxAttempts - attempts,
				};
			}

			// Stamp only while the user's phone still equals the one the code was
			// sent to — a phone changed mid-verification must re-verify.
			const stamped = await consultants.stampPhoneVerified(
				userId,
				pending.phoneE164,
				now,
			);
			await verifications.delete(userId);
			if (!stamped) {
				return { ok: false, reason: "phone_changed" };
			}
			logger.info(
				{ event: "phone_verify.confirmed", userId },
				"phone verified for handoff alerts",
			);
			return { ok: true, phoneE164: pending.phoneE164 };
		},
	};
}
