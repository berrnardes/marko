// Runtime composition root (entry-point wiring — process-wide half).
//
// Side-effect boundary: this module owns what is genuinely process-wide — the
// pg-boss connection, the anti-ban configuration read from the environment, and
// the clock. The per-tenant half (the Drizzle repositories bound to one
// organization and the domain services over them) lives in
// `@/services/org-runtime` and is reached through {@link Runtime.forOrg}.
//
// That split is the tenancy boundary. `getRuntime()` is a process-wide
// singleton, so nothing it holds may be tenant-specific; conversely nothing
// outside `forOrg` can obtain a repository at all, so a query cannot accidentally
// run unscoped.
//
// Both processes call into this module and share the SAME domain modules; only
// the entry point differs (design "Architecture"):
//   - the Next.js web app uses {@link getRuntime} to enroll imported leads
//     through the real `Cadence_Scheduler` (Req 2.3, 3.1) and to enqueue inbound
//     webhook processing onto pg-boss;
//   - the long-running worker calls {@link getRuntime} then
//     {@link registerWorkers} to register the cadence, outbound, and inbound
//     pg-boss handlers (design "Entry points").
//
// It is intentionally NOT re-exported from the `@/services` barrel: importing it
// opens a database pool and a pg-boss connection, so consumers that genuinely
// need the live runtime import `@/services/runtime` explicitly (mirroring how
// `@/db/client` is kept out of the `@/db` barrel).

import { PgBoss } from "pg-boss";

import { CADENCE_TEST_MODE, CADENCE_TOUCHES_COUNT } from "@/core/cadence";
import type { AntiBanConfig, Clock } from "@/core/types";
import type { Database } from "@/db/client";
import { resolveOrganizationIdForLead } from "@/db/lead-repository";
import { childLogger, logger } from "@/logger";
import type {
	CadenceJobQueue,
	CadenceTouchJob,
} from "@/services/cadence-scheduler";
import type { InboundMessage } from "@/services/inbound-handler";
import {
	type InboundProcessingJob,
	type InboundProcessingQueue,
} from "@/services/inbound-webhook";
import {
	getOrgServices,
	type OrgServices,
	type OrgServicesContext,
} from "@/services/org-runtime";
import type {
	OutboundSendQueue,
	OutboundSendRequest,
} from "@/services/outbound-worker";

// ---------------------------------------------------------------------------
// Queue names (the durable pg-boss queues backing the schedulers/workers)
// ---------------------------------------------------------------------------

/** The durable pg-boss queue names used across the system. */
export const QUEUE_NAMES = {
	/** Delayed cadence touch jobs T1–T5 (Req 3.2, 3.4). */
	cadence: "cadence-touch",
	// The `monthly-nurture` queue was removed with the beta scope cuts
	// (ADR-002). Nothing enqueues or consumes it any more; jobs left in the
	// pg-boss backlog simply age out under its retention policy.
	/** The single outbound send choke point (Req 16, 17, 18). */
	outbound: "outbound-send",
	/** Inbound WAHA message processing handed off from the webhook (Req 7.1). */
	inbound: "inbound-process",
} as const;

// ---------------------------------------------------------------------------
// Configuration helpers (read from the environment, by name)
// ---------------------------------------------------------------------------

/** Connection string for the shared PostgreSQL instance (Tech: `DATABASE_URL`). */
function connectionString(): string {
	return process.env.DATABASE_URL ?? "postgres://localhost:5432/marko";
}

/**
 * Parse the comma-separated consultant alert numbers from
 * `CONSULTANT_NOTIFY_NUMBERS` into a trimmed, non-empty E.164 list.
 *
 * DEPRECATED: recipients now come from the lead's own organization membership
 * (members with a verified phone and alerts on, resolved in
 * `@/services/org-runtime`); this env list is only the migration fallback when
 * no member of that organization qualifies yet. Note it is a SINGLE global list
 * shared by every tenant — which is precisely why it must go: delete it, and the
 * env vars, once every org manages its consultants in the CRM.
 */
function parseConsultantNumbers(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Read a positive integer env var, falling back to `fallback` when unset/invalid. */
function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The anti-ban configuration driving the per-number daily cap, warm-up ramp,
 * randomized send pacing, and send-window restriction (Req 16, 17). Defaults
 * are conservative and overridable by environment variable so a deployment can
 * tune them without code changes.
 */
export function defaultAntiBanConfig(): AntiBanConfig {
	return {
		baseDailyCap: envInt("ANTIBAN_BASE_DAILY_CAP", 40),
		warmupInitialCap: envInt("ANTIBAN_WARMUP_INITIAL_CAP", 10),
		warmupRampDays: envInt("ANTIBAN_WARMUP_RAMP_DAYS", 7),
		delayMinMs: envInt("ANTIBAN_DELAY_MIN_MS", 30_000),
		delayMaxMs: envInt("ANTIBAN_DELAY_MAX_MS", 120_000),
		sendWindow: {
			startHour: envInt("ANTIBAN_SEND_WINDOW_START_HOUR", 8),
			endHour: envInt("ANTIBAN_SEND_WINDOW_END_HOUR", 19),
		},
	};
}

// ---------------------------------------------------------------------------
// pg-boss singleton
// ---------------------------------------------------------------------------

const globalForBoss = globalThis as unknown as {
	__markoBoss?: Promise<PgBoss>;
};

/**
 * Start (once) the shared pg-boss instance and ensure every durable queue
 * exists before any `send`/`work` call (pg-boss v12 requires queues to be
 * created up front). A module-level singleton promise is reused across hot
 * reloads in development so repeated imports do not open extra connections.
 */
function getBoss(): Promise<PgBoss> {
	if (!globalForBoss.__markoBoss) {
		globalForBoss.__markoBoss = (async () => {
			const boss = new PgBoss(connectionString());
			boss.on("error", (err) => {
				logger.error({ event: "pgboss.error", err }, "pg-boss emitted error");
			});
			await boss.start();
			await Promise.all(
				Object.values(QUEUE_NAMES).map((name) =>
					// Retry only the outbound send queue: a transient WAHA/network
					// failure in `sendText` should be retried (3 attempts, exponential
					// backoff) rather than silently dropped. A non-existent number is
					// NOT a throw here — the worker returns `dropped_unreachable` and
					// the job is acknowledged — so it is never retried.
					name === QUEUE_NAMES.outbound
						? boss.createQueue(name, { retryLimit: 3, retryBackoff: true })
						: boss.createQueue(name),
				),
			);
			return boss;
		})();
	}
	return globalForBoss.__markoBoss;
}

// ---------------------------------------------------------------------------
// pg-boss-backed queue adapters
// ---------------------------------------------------------------------------

/** Throw a descriptive error when pg-boss returns no id for an enqueue. */
function requireJobId(jobId: string | null, queue: string): string {
	if (jobId === null) {
		throw new Error(`pg-boss returned no job id when enqueuing to "${queue}"`);
	}
	return jobId;
}

/**
 * A durable job payload as it is stored in pg-boss: whatever the domain service
 * produced, plus the organization that owns it. The domain services are built
 * over repositories already bound to one tenant and so never name it; the queue
 * adapters below stamp it on enqueue, and the consumers read it back to rebuild
 * that tenant's services (`getOrgServices`) before acting.
 */
export type Tenanted<T> = T & { organizationId: string };

/** The durable cadence touch payload: `{ leadId, touch }` + its organization. */
export type CadenceTouchJobPayload = Tenanted<CadenceTouchJob>;
/** The durable outbound send payload + its organization. */
export type OutboundSendPayload = Tenanted<OutboundSendRequest>;
/** The durable inbound processing payload + its organization. */
export type InboundProcessingPayload = Tenanted<InboundProcessingJob>;

/**
 * Adapt the cadence pg-boss queue to the scheduler's {@link CadenceJobQueue} for
 * one organization, stamping `organizationId` onto every enqueued touch.
 */
function cadenceJobQueue(
	boss: PgBoss,
	organizationId: string,
): CadenceJobQueue {
	return {
		async enqueueTouch(job: CadenceTouchJob, fireAt: Date): Promise<string> {
			const payload: CadenceTouchJobPayload = { ...job, organizationId };
			const jobId = await boss.send(QUEUE_NAMES.cadence, payload, {
				startAfter: fireAt,
			});
			return requireJobId(jobId, QUEUE_NAMES.cadence);
		},
		async cancel(jobId: string): Promise<void> {
			await boss.cancel(QUEUE_NAMES.cadence, jobId);
		},
	};
}

/**
 * Adapt the outbound pg-boss queue to the features' {@link OutboundSendQueue}
 * for one organization, stamping `organizationId` onto every enqueued send.
 */
function outboundSendQueue(
	boss: PgBoss,
	organizationId: string,
): OutboundSendQueue {
	return {
		async enqueueSend(request: OutboundSendRequest): Promise<string> {
			// The cadence enqueues only the request; the physical sending number is
			// assigned when the job is dequeued by the outbound handler (design
			// "Enqueue outbound send job") — from the same organization's numbers.
			const payload: OutboundSendPayload = { ...request, organizationId };
			const jobId = await boss.send(QUEUE_NAMES.outbound, payload);
			return requireJobId(jobId, QUEUE_NAMES.outbound);
		},
	};
}

/** Adapt the inbound pg-boss queue to the webhook's {@link InboundProcessingQueue}. */
function inboundProcessingQueue(
	boss: PgBoss,
	organizationId: string,
): InboundProcessingQueue {
	return {
		async enqueueInbound(job: InboundProcessingJob): Promise<string> {
			const payload: InboundProcessingPayload = { ...job, organizationId };
			const jobId = await boss.send(QUEUE_NAMES.inbound, payload);
			return requireJobId(jobId, QUEUE_NAMES.inbound);
		},
	};
}

// ---------------------------------------------------------------------------
// Runtime assembly
// ---------------------------------------------------------------------------

/**
 * The process-wide runtime: the started pg-boss instance, the configuration and
 * clock shared by every tenant, and the factory that builds a tenant's domain
 * layer.
 *
 * It deliberately exposes NO repositories or domain services of its own. Those
 * are per-organization and are reached through {@link Runtime.forOrg}, which
 * binds them to one `organizationId`; there is no unscoped `leads` or
 * `messages` here that a caller could reach for by accident.
 */
export interface Runtime {
	boss: PgBoss;
	antiBanConfig: AntiBanConfig;
	clock: Clock;
	/**
	 * Build the domain layer (repositories + services) for one organization.
	 * Cheap — everything it constructs is stateless — so callers build it per
	 * request or per job rather than caching it.
	 *
	 * Pass the `database` when running under RLS: web routes hand in the
	 * transaction opened by `withOrg`, so the repositories issue their statements
	 * inside the tenant context the policies read (ADR-004). Omitting it uses the
	 * shared pool, which is what the worker does — it connects as the
	 * `BYPASSRLS` role and cannot hold a transaction across its pacing sleeps.
	 */
	forOrg: (organizationId: string, database?: Database) => OrgServices;
	/**
	 * The durable inbound queue for one organization, used by the WAHA webhook
	 * once it has resolved which tenant the delivering session belongs to.
	 */
	inboundQueue: (organizationId: string) => InboundProcessingQueue;
}

const globalForRuntime = globalThis as unknown as {
	__markoRuntime?: Promise<Runtime>;
};

/**
 * Build (once) the shared runtime over a started pg-boss instance and the live
 * Drizzle data layer. Wires the enrollment path (`Lead_Importer` →
 * `Cadence_Scheduler`, Req 2.3, 3.1), the cadence/outbound workers' domain
 * logic, and the outbound choke point (Req 16, 17, 18) so the web app and the
 * worker share exactly the same domain wiring.
 */
export function getRuntime(): Promise<Runtime> {
	if (!globalForRuntime.__markoRuntime) {
		globalForRuntime.__markoRuntime = (async () => {
			if (CADENCE_TEST_MODE) {
				logger.warn(
					{
						event: "runtime.cadence_test_mode",
						touches: CADENCE_TOUCHES_COUNT,
					},
					"CADENCE_TEST_MODE is ON — offsets are in seconds",
				);
			}

			const boss = await getBoss();
			const antiBanConfig = defaultAntiBanConfig();
			const clock: Clock = { now: () => new Date() };

			// The process-wide context every tenant's domain layer is built over:
			// shared configuration, the shared clock, and the pg-boss queue adapters
			// (as per-organization factories, so each enqueued job carries its
			// tenant).
			const context: OrgServicesContext = {
				antiBanConfig,
				clock,
				cadenceQueue: (organizationId) => cadenceJobQueue(boss, organizationId),
				outboundQueue: (organizationId) =>
					outboundSendQueue(boss, organizationId),
				envNotifyNumbers: parseConsultantNumbers(
					process.env.CONSULTANT_NOTIFY_NUMBERS,
				),
				notifyFromNumber: process.env.CONSULTANT_NOTIFY_FROM_NUMBER,
				crmBaseUrl: process.env.CRM_BASE_URL,
			};

			return {
				boss,
				antiBanConfig,
				clock,
				forOrg: (organizationId, database) =>
					getOrgServices(organizationId, context, database),
				inboundQueue: (organizationId) =>
					inboundProcessingQueue(boss, organizationId),
			};
		})();
	}
	return globalForRuntime.__markoRuntime;
}

// ---------------------------------------------------------------------------
// Outbound number assignment + deferral (worker-side)
// ---------------------------------------------------------------------------

/** The next instant the local send window opens at/after `now` (Req 17.4). */
function nextSendWindowStart(config: AntiBanConfig, now: Date): Date {
	const start = new Date(now);
	if (now.getHours() < config.sendWindow.startHour) {
		start.setHours(config.sendWindow.startHour, 0, 0, 0);
		return start;
	}
	start.setDate(start.getDate() + 1);
	start.setHours(config.sendWindow.startHour, 0, 0, 0);
	return start;
}

/** The next local midnight after `now` (the next-day cap reset, Req 16.2). */
function nextLocalMidnight(now: Date): Date {
	const midnight = new Date(now);
	midnight.setDate(midnight.getDate() + 1);
	midnight.setHours(0, 0, 0, 0);
	return midnight;
}

/**
 * Process one dequeued outbound send request: assign an available, sendable
 * number and run it through the {@link OutboundWorker} choke point, deferring
 * the whole request when nothing can send right now.
 *
 * Number assignment honors the anti-ban invariants directly: only non-blocked
 * numbers are ever considered (Req 18.3), and each is re-checked with
 * `canAssignSend` (block flag → send window → daily cap, Req 16.2) before it is
 * used. The first number that the choke point actually sends from wins; a
 * number that turns out blocked or capped at send time is skipped in favor of
 * the next, and when no number can send the request is re-enqueued for the next
 * window/day rather than dropped.
 */
async function processOutboundRequest(
	rt: Runtime,
	org: OrgServices,
	request: OutboundSendPayload,
): Promise<void> {
	const now = rt.clock.now();
	const log = childLogger({
		correlationId: request.correlationId,
		leadId: request.leadId,
	});
	log.info(
		{
			event: "outbound.processing",
			kind: request.kind,
			organizationId: org.organizationId,
		},
		"processing outbound send",
	);

	// Outside the global send window → defer to the window reopening (Req 17.4).
	if (!org.antiBan.withinSendWindow()) {
		log.warn(
			{ event: "outbound.deferred", kind: request.kind, reason: "window" },
			"outside send window; deferring",
		);
		await rt.boss.send(QUEUE_NAMES.outbound, request, {
			startAfter: nextSendWindowStart(rt.antiBanConfig, now),
		});
		return;
	}

	// Only this organization's numbers are ever candidates: `org.numbers` is
	// bound to the tenant, so a send can never go out from another tenant's
	// WhatsApp number.
	const candidates = await org.numbers.listAvailable();
	if (candidates.length === 0) {
		log.warn(
			{ event: "outbound.no_number", organizationId: org.organizationId },
			"no available WhatsApp numbers registered — nothing can be sent. Add a " +
				"sending number in the CRM (Numbers page) / `numbers` table.",
		);
	}
	for (const number of candidates) {
		if (!(await org.antiBan.canAssignSend(number.id))) {
			continue;
		}
		const outcome = await org.outboundWorker.process({
			leadId: request.leadId,
			numberId: number.id,
			content: request.content,
			kind: request.kind,
		});
		log.info(
			{
				event: "outbound.outcome",
				numberId: number.id,
				status: outcome.status,
			},
			"outbound send outcome",
		);
		switch (outcome.status) {
			case "sent":
			case "dropped_opt_out":
			case "dropped_stopped":
				return;
			case "dropped_unreachable":
				// WAHA confirmed the number does not exist on WhatsApp. Mark the lead
				// unreachable and cancel its pending cadence jobs so no further
				// automated outreach is attempted (same outreach-stopping pattern the
				// inbound handler uses on a reply). Terminal: the job is
				// acknowledged (no throw), so it is never retried.
				await org.leads.markUnreachable(request.leadId, now);
				await org.cadenceScheduler.cancelAll(request.leadId);
				log.warn(
					{ event: "outbound.unreachable", numberId: number.id },
					"number unreachable on WhatsApp; lead marked + outreach cancelled",
				);
				return;
			case "blocked":
			case "deferred_cap":
				continue; // try another number
			case "deferred_window":
				await rt.boss.send(QUEUE_NAMES.outbound, request, {
					startAfter: nextSendWindowStart(rt.antiBanConfig, now),
				});
				return;
		}
	}

	// Every available number is blocked or at its daily cap → defer to the next
	// day so the per-number cap is never exceeded (Req 16.2, 18.3).
	log.warn(
		{ event: "outbound.deferred", kind: request.kind, reason: "cap" },
		"no sendable number right now (none available, blocked, or at daily cap); " +
			"deferring to next day",
	);
	await rt.boss.send(QUEUE_NAMES.outbound, request, {
		startAfter: nextLocalMidnight(now),
	});
}

// ---------------------------------------------------------------------------
// Tenant resolution for dequeued jobs (worker entry point only)
// ---------------------------------------------------------------------------

/**
 * Resolve which organization a dequeued job belongs to.
 *
 * Jobs enqueued from this deploy onward carry `organizationId` in the payload.
 * pg-boss still holds up to a retention window of jobs enqueued BEFORE the
 * tenancy retrofit, whose payloads have only a `leadId`; for those the tenant is
 * recovered from the lead itself so the backlog drains instead of failing.
 *
 * Remove the fallback (and `resolveOrganizationIdForLead`) once the
 * pre-retrofit backlog has aged out.
 *
 * @returns The organization, or `null` when it cannot be determined — the caller
 *   acknowledges the job rather than retrying it forever.
 */
async function resolveJobOrganization(
	payload: { organizationId?: string; leadId: string },
	queue: string,
): Promise<string | null> {
	if (payload.organizationId) {
		return payload.organizationId;
	}
	const recovered = await resolveOrganizationIdForLead(payload.leadId);
	if (recovered) {
		logger.warn(
			{
				event: "job.org_backfilled",
				queue,
				leadId: payload.leadId,
				organizationId: recovered,
			},
			"job predates the tenancy retrofit; organization recovered from its lead",
		);
		return recovered;
	}
	logger.error(
		{ event: "job.org_unresolved", queue, leadId: payload.leadId },
		"cannot determine the organization for this job; dropping it",
	);
	return null;
}

// ---------------------------------------------------------------------------
// Worker handler registration (worker entry point only)
// ---------------------------------------------------------------------------

/**
 * Register the cadence, outbound, and inbound pg-boss job handlers on the
 * worker process (design "Entry points"). Each handler adapts the pg-boss job
 * envelope to a `process` call on the domain logic.
 *
 * Every handler starts by resolving the job's organization and rebuilding that
 * tenant's domain layer (`rt.forOrg`). The worker process therefore serves all
 * organizations while each individual job acts through repositories bound to
 * exactly one — a job can neither read nor write another tenant's rows, and a
 * job whose tenant cannot be resolved is dropped rather than run unscoped.
 *
 * Only the long-running worker calls this — the web app enqueues but never
 * consumes. This includes the inbound queue: its pipeline runs here, while the
 * webhook only persists and enqueues durably so no inbound delivery is lost.
 */
export async function registerWorkers(rt: Runtime): Promise<void> {
	await rt.boss.work<CadenceTouchJobPayload>(
		QUEUE_NAMES.cadence,
		async (jobs) => {
			for (const job of jobs) {
				const organizationId = await resolveJobOrganization(
					job.data,
					QUEUE_NAMES.cadence,
				);
				if (!organizationId) {
					continue;
				}
				logger.debug(
					{
						event: "job.processing",
						queue: QUEUE_NAMES.cadence,
						jobId: job.id,
						organizationId,
					},
					"processing cadence job",
				);
				const org = rt.forOrg(organizationId);
				// Load this organization's own template customizations before
				// rendering, so operator edits apply on the next job without
				// restarting the worker — and so one tenant's templates are never
				// rendered for another's lead.
				await org.refreshTemplates();
				await org.cadenceWorker.process(job.data);
			}
		},
	);

	await rt.boss.work<OutboundSendPayload>(QUEUE_NAMES.outbound, async (jobs) => {
		for (const job of jobs) {
			const organizationId = await resolveJobOrganization(
				job.data,
				QUEUE_NAMES.outbound,
			);
			if (!organizationId) {
				continue;
			}
			await processOutboundRequest(rt, rt.forOrg(organizationId), {
				...job.data,
				organizationId,
			});
		}
	});

	// Inbound processing: the webhook persists + enqueues each inbound message;
	// this is the consumer that runs the Inbound_Handler pipeline (sendSeen,
	// opt-out, cadence cancellation, and the handoff to a consultant). The
	// message append is made idempotent (inside `getOrgServices`) so the raw
	// inbound persisted at the webhook is not double-written.
	await rt.boss.work<InboundProcessingPayload>(
		QUEUE_NAMES.inbound,
		async (jobs) => {
			for (const job of jobs) {
				const organizationId = await resolveJobOrganization(
					job.data,
					QUEUE_NAMES.inbound,
				);
				if (!organizationId) {
					continue;
				}
				const org = rt.forOrg(organizationId);
				// The receiving number is looked up within the organization, so a
				// session name is only honored for the tenant that registered it.
				const numberId = (await org.numbers.listAll()).find(
					(n) => n.sessionName === job.data.session,
				)?.id;
				const msg: InboundMessage = {
					from: job.data.from,
					text: job.data.text,
					// pg-boss round-trips the payload through JSON, so `receivedAt`
					// arrives as a string; rehydrate it to a Date.
					receivedAt: new Date(job.data.receivedAt),
					waMessageId: job.data.waMessageId,
					numberId,
				};
				const log = childLogger({
					correlationId: job.data.correlationId,
					leadId: job.data.leadId,
				});
				const startedAt = Date.now();
				log.info(
					{
						event: "inbound.processing",
						numberId: numberId ?? null,
						session: job.data.session,
						organizationId,
					},
					"processing inbound reply",
				);
				try {
					await org.inboundHandler.handle(msg);
					log.info(
						{ event: "inbound.completed", durationMs: Date.now() - startedAt },
						"inbound pipeline completed",
					);
				} catch (err) {
					// Surface the real failure rather than letting pg-boss retry it
					// silently. Rethrow so the job is marked failed instead of
					// acknowledged as done.
					log.error(
						{ event: "inbound.failed", err },
						"inbound pipeline failed",
					);
					throw err;
				}
			}
		},
	);
}
