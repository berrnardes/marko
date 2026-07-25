// Settings API composition (server-only wiring for /api/crm/settings/*).
//
// Side-effect boundary: builds the concrete dependencies the settings routes
// share — the consultant/verification repositories, a WAHA client, and the
// phone-verification service. Deliberately NOT `@/services/runtime`: these
// routes run in the web process and only need to send a WhatsApp text, so they
// must not open the pg-boss connection the full runtime wiring carries.

import { DrizzleConsultantRepository } from "@/db/consultant-repository";
import { DrizzleNumberRepository } from "@/db/number-repository";
import { DrizzlePhoneVerificationRepository } from "@/db/phone-verification-repository";
import { withOrg } from "@/db/with-org";
import {
	createPhoneVerificationService,
	type PhoneVerificationService,
} from "@/services/phone-verification";
import type { NumberRepository } from "@/services/repositories";
import {
	createWahaClient,
	numberSessionResolverFromRepository,
	type WahaClient,
} from "@/services/waha-client";

/** The concrete dependencies shared by the settings routes. */
export interface SettingsWiring {
	consultants: DrizzleConsultantRepository;
	verifications: DrizzlePhoneVerificationRepository;
	waha: WahaClient;
	verification: PhoneVerificationService;
	/** First available sending number, then any registered one (as the notifier). */
	resolveFromNumberId: () => Promise<string | undefined>;
}

/**
 * A {@link NumberRepository} whose every call is its own short transaction
 * carrying the organization's RLS context (ADR-004).
 *
 * The settings flows interleave database reads with WhatsApp sends — pick a
 * sending number, send the code, record the verification — so they cannot run
 * inside a single `withOrg` callback without holding a pooled connection across
 * a network call. Per-call transactions keep each one brief. There is no
 * atomicity to lose here: these reads are independent lookups, not a unit of
 * work.
 */
function perCallScopedNumbers(organizationId: string): NumberRepository {
	const scoped = <T>(fn: (repo: NumberRepository) => Promise<T>): Promise<T> =>
		withOrg(organizationId, (tx) =>
			fn(new DrizzleNumberRepository(organizationId, tx)),
		);
	return {
		findById: (numberId) => scoped((r) => r.findById(numberId)),
		listAll: () => scoped((r) => r.listAll()),
		listAvailable: () => scoped((r) => r.listAvailable()),
		insert: (record) => scoped((r) => r.insert(record)),
		delete: (numberId) => scoped((r) => r.delete(numberId)),
		setBlocked: (numberId, blocked) =>
			scoped((r) => r.setBlocked(numberId, blocked)),
		incrementDailySent: (numberId, on) =>
			scoped((r) => r.incrementDailySent(numberId, on)),
		resetDailyCounter: (numberId, on) =>
			scoped((r) => r.resetDailyCounter(numberId, on)),
	};
}

/**
 * Build the settings-route dependencies, scoped to the caller's organization
 * (stateless; per-request is fine). The `organizationId` must come from
 * `requireOrgSession`, so the verification code is only ever sent from — and
 * the system-number check only ever runs against — the tenant's own numbers.
 */
export function settingsWiring(organizationId: string): SettingsWiring {
	const numbers = perCallScopedNumbers(organizationId);
	// `member`/`user`/`phone_verifications` carry no organization column and no
	// RLS policy — they are keyed by user id — so these two need no context.
	const consultants = new DrizzleConsultantRepository();
	const verifications = new DrizzlePhoneVerificationRepository();
	const waha = createWahaClient({
		baseUrl: process.env.WAHA_BASE_URL ?? "http://localhost:3000",
		apiKey: process.env.WAHA_API_KEY,
		resolveNumber: numberSessionResolverFromRepository(numbers),
	});
	const resolveFromNumberId = async (): Promise<string | undefined> => {
		const available = await numbers.listAvailable();
		if (available.length > 0) {
			return available[0].id;
		}
		const all = await numbers.listAll();
		return all[0]?.id;
	};
	const verification = createPhoneVerificationService({
		verifications,
		consultants,
		waha,
		resolveFromNumberId,
		listSystemNumbers: async () =>
			(await numbers.listAll()).map((n) => n.msisdn),
		clock: { now: () => new Date() },
	});
	return { consultants, verifications, waha, verification, resolveFromNumberId };
}
