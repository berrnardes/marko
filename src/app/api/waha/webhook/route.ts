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

import {
	processWahaWebhook,
	WAHA_HMAC_HEADER,
	type WahaWebhookDeps,
} from "@/services";
import { getRuntime } from "@/services/runtime";

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
 * Default production dependency provider (task 23.1). Resolves the shared
 * runtime (`@/services/runtime`) for the Drizzle-backed
 * `LeadRepository`/`MessageRepository` and the pg-boss-backed
 * {@link import("@/services").InboundProcessingQueue}, and reads the HMAC secret
 * from the environment. The webhook therefore verifies, persists, and enqueues
 * inbound deliveries durably; the heavy Inbound_Handler pipeline runs off the
 * inbound queue.
 */
async function defaultWebhookDepsProvider(): Promise<WahaWebhookDeps> {
	const secret = requireWebhookSecret();
	const runtime = await getRuntime();
	return {
		secret,
		leads: runtime.leads,
		messages: runtime.messages,
		queue: runtime.inboundQueue,
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
