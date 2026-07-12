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
import {
	createPhoneVerificationService,
	type PhoneVerificationService,
} from "@/services/phone-verification";
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

/** Build the settings-route dependencies (stateless; per-request is fine). */
export function settingsWiring(): SettingsWiring {
	const numbers = new DrizzleNumberRepository();
	const consultants = new DrizzleConsultantRepository();
	const verifications = new DrizzlePhoneVerificationRepository();
	const waha = createWahaClient({
		baseUrl: process.env.WAHA_BASE_URL ?? "http://localhost:3000",
		apiKey: process.env.WAHA_API_KEY,
		resolveNumber: numberSessionResolverFromRepository(numbers),
		resolutionSession: process.env.WAHA_SESSION,
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
