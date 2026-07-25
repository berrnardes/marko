// WAHA inbound webhook route (Next.js App Router entry point).
//
// `POST /api/waha/webhook` is the HTTP entry point WAHA delivers inbound
// `message` events to. As an entry point it is deliberately THIN: it reads the
// raw request body and the `X-Webhook-Hmac` header, resolves the configured
// dependencies, and delegates the verify → validate → idempotency → persist →
// enqueue contract to `processWahaWebhook` in the services layer (Req 7.1, 7.4).
// All testable logic lives in the service so this file stays a wiring adapter.
//
// Side-effect boundary: this module performs HTTP I/O only. It reads the raw
// body with `req.text()` BEFORE any JSON parsing so the HMAC is verified over
// the exact bytes WAHA signed, then hands those raw bytes to the service. The
// shared HMAC secret comes from the `WAHA_WEBHOOK_HMAC_SECRET` environment
// variable (referenced by name, never hard-coded). The repositories and the
// durable inbound queue are provided through {@link getWebhookDeps}; their
// concrete (Drizzle + pg-boss) wiring is registered by task 23.1, and tests
// (task 21.5) override the provider with in-memory fakes via
// {@link setWebhookDepsProvider}.

import { findNumberBySessionName } from "@/db/number-repository";
import { withOrg } from "@/db/with-org";
import {
	processWahaWebhook,
	WAHA_HMAC_HEADER,
	type LidResolver,
	type WahaWebhookDeps,
} from "@/services";
import { getRuntime } from "@/services/runtime";
import { createWahaClient } from "@/services/waha-client";

/**
 * Force the Node.js runtime: signature verification uses `node:crypto`
 * (`createHmac` / `timingSafeEqual`), which is unavailable on the Edge runtime.
 */
export const runtime = "nodejs";

/**
 * Provider for the webhook's injected dependencies (the secret, the
 * Lead/Message repositories, and the durable inbound queue). Resolving them
 * lazily — rather than at module load — lets the concrete composition root be
 * wired in task 23.1 and lets tests substitute fakes via
 * {@link setWebhookDepsProvider} without standing up a database or pg-boss.
 */
export type WebhookDepsProvider = () =>
	| WahaWebhookDeps
	| Promise<WahaWebhookDeps>;

/**
 * The active dependency provider. Defaults to {@link defaultWebhookDepsProvider},
 * which constructs the production dependencies once they are wired (task 23.1).
 */
let depsProvider: WebhookDepsProvider = defaultWebhookDepsProvider;

/**
 * Override the dependency provider (used by tests, task 21.5, to inject
 * in-memory repositories and a fake queue). Returns a restore function that
 * reinstates the previous provider.
 */
export function setWebhookDepsProvider(
	provider: WebhookDepsProvider,
): () => void {
	const previous = depsProvider;
	depsProvider = provider;
	return () => {
		depsProvider = previous;
	};
}

/** Process-wide client used only to resolve `@lid` senders. */
let lidResolverClient: LidResolver | undefined;

/**
 * A WAHA client for the single purpose of resolving a hidden Linked ID to a
 * phone-number chat id.
 *
 * It is deliberately NOT tenant-bound, and safe not to be: `resolveLidToPhone`
 * addresses WAHA by session name, which the delivery already carries, and never
 * touches the database. Its `resolveNumber` seam — the only tenant-sensitive
 * part of the client — maps a domain `numberId` to a session and is unreachable
 * on this path, so it is wired to throw rather than to a repository. Every other
 * WAHA call the system makes goes through an organization-scoped client built by
 * `getOrgServices`.
 */
function lidResolver(): LidResolver {
	lidResolverClient ??= createWahaClient({
		baseUrl: process.env.WAHA_BASE_URL ?? "http://localhost:3000",
		apiKey: process.env.WAHA_API_KEY,
		resolveNumber: () => {
			throw new Error(
				"the webhook's lid resolver has no tenant context; resolve the " +
					"organization first and use its client from getOrgServices",
			);
		},
	});
	return lidResolverClient;
}

/**
 * Read the configured shared HMAC secret from the environment (Req 7.1). Throws
 * when unset so a misconfigured deployment fails loudly rather than silently
 * accepting unverifiable webhooks.
 */
export function requireWebhookSecret(): string {
	const secret = process.env.WAHA_WEBHOOK_HMAC_SECRET;
	if (!secret) {
		throw new Error(
			"WAHA_WEBHOOK_HMAC_SECRET is not set; cannot verify inbound webhook signatures (Req 7.1)",
		);
	}
	return secret;
}

/**
 * Default production dependency provider. Supplies the HMAC secret from the
 * environment and the session→tenant resolver the webhook scopes itself with.
 *
 * The resolver is where inbound multi-tenancy is decided: a delivery names only
 * a WAHA `session`, so it is looked up in `whatsapp_numbers` (whose
 * `session_name` is globally unique) to find the organization that registered
 * it, and the tenant's own repositories, queue, and WAHA client are handed back.
 * A session no number claims resolves to `null` and the delivery is dropped with
 * a `200`.
 */
async function defaultWebhookDepsProvider(): Promise<WahaWebhookDeps> {
	const secret = requireWebhookSecret();
	const runtime = await getRuntime();
	return {
		secret,
		// Runs before any tenant context exists, so under RLS it goes through the
		// `SECURITY DEFINER` resolver rather than reading `whatsapp_numbers`
		// directly (ADR-004).
		resolveSession: (session) => findNumberBySessionName(session),
		// The persistence unit of work. This route runs in the web process, whose
		// pool connects as the RLS-enforced role, so the repositories must issue
		// their statements inside a transaction carrying the tenant context.
		withScope: (owner, fn) =>
			withOrg(owner.organizationId, (tx) => {
				const org = runtime.forOrg(owner.organizationId, tx);
				return fn({
					leads: org.leads,
					messages: org.messages,
					// Outbound-echo ingestion: count a consultant's WhatsApp Web reply
					// against the sending number's anti-ban cap (its history row is
					// written by the service).
					antiBan: org.antiBan,
				});
			}),
		queue: (organizationId) => runtime.inboundQueue(organizationId),
		lids: lidResolver(),
	};
}

/**
 * Handle a WAHA inbound `message` webhook delivery (Req 7.1, 7.4).
 *
 * Reads the raw body and the `X-Webhook-Hmac` header, then delegates to
 * `processWahaWebhook`, which verifies the signature, validates the body,
 * enforces `wa_message_id` idempotency, persists the raw inbound, and enqueues
 * processing — returning a fast `2xx` so WAHA does not retry on timeout. Maps
 * the service's {@link import("@/services").WebhookResult} to a JSON `Response`.
 *
 * @param req - The incoming WAHA webhook request.
 * @returns The HTTP response: `401` (bad signature), `400` (malformed), or
 *   `200` (accepted / acknowledged duplicate).
 */
export async function POST(req: Request): Promise<Response> {
	// Read the RAW body first so the HMAC is computed over the exact bytes WAHA
	// signed; never parse before verifying.
	const rawBody = await req.text();
	const signature = req.headers.get(WAHA_HMAC_HEADER);

	const deps = await depsProvider();
	const result = await processWahaWebhook(deps, rawBody, signature);

	return Response.json(result.body, { status: result.status });
}
