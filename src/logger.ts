// Structured application logger (the single logging seam).
//
// Everything logs through this module — never `console.*` and never `pino`
// directly — so levels, redaction, output format, and (later) transports are
// configured in exactly one place. Wrapping pino this way means the ~dozens of
// call sites are insulated from the engine: swapping pino, adding OpenTelemetry
// trace ids, or shipping to an aggregator is a change here, not everywhere.
//
// Two processes share this code (the Next.js web app and the pg-boss worker).
// Each sets `SVC` in its environment (`web` | `worker`) so every line
// self-identifies which process emitted it — the first step to coherent logs
// across the split. See `docker-compose*.yml`.
//
// Env:
//   LOG_LEVEL  — pino level (default: "info" in prod, "debug" otherwise).
//   SVC        — process name stamped on every line (default: "web").
//   NODE_ENV   — "production" ⇒ raw JSON (for aggregation); else pretty-printed.

import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

/**
 * Fields that must never reach the logs verbatim — lead PII (phone numbers,
 * chat ids), message bodies, and secrets/tokens. Redaction is by property name
 * wherever it appears (top level or one level down), so passing a whole domain
 * object to a log call cannot accidentally leak these. Prefer logging ids
 * (`leadId`, `numberId`) over raw contact details in the first place.
 */
const REDACT_PATHS = [
	"from",
	"to",
	"phone",
	"phoneE164",
	"waMessageId",
	"content",
	"text",
	"*.from",
	"*.to",
	"*.phone",
	"*.phoneE164",
	"*.content",
	"*.text",
	"token",
	"*.token",
	"secret",
	"*.secret",
	'headers["x-webhook-hmac"]',
];

const root = pino({
	level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
	base: { svc: process.env.SVC ?? "web" },
	redact: { paths: REDACT_PATHS, censor: "[redacted]" },
	// Pretty, human-readable output in dev; pure JSON in prod so logs can be
	// grepped and later shipped to an aggregator (Loki / Better Stack / Axiom)
	// without any format change.
	transport: isProd
		? undefined
		: {
				target: "pino-pretty",
				options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
			},
});

export type Logger = pino.Logger;

/** The process-wide root logger. Use {@link childLogger} to bind flow context. */
export const logger: Logger = root;

/**
 * Derive a logger that stamps `bindings` on every line it emits. Bind once at
 * the start of a flow (e.g. `{ correlationId, leadId }` at the webhook / worker
 * job boundary) and pass the child down so a single
 * `grep '"correlationId":"…"'` reconstructs the whole inbound → pipeline →
 * outbound story across both processes.
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
	return root.child(bindings);
}
