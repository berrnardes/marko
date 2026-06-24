// Runtime composition root (entry-point wiring — task 23.1).
//
// Side-effect boundary: this is the shared composition root that wires the
// pure core + domain services to their concrete data layer (Drizzle
// repositories) and the durable job queue (pg-boss). Like `@/services/auth` and
// `@/services/crm-importer`, it legitimately depends on concrete modules
// (`@/db/*` and `pg-boss`) rather than only on interfaces — it is where the
// interface-typed services are finally given their real implementations.
//
// Both processes call into this module and share the SAME domain modules; only
// the entry point differs (design "Architecture"):
//   - the Next.js web app uses {@link getRuntime} to enroll imported leads
//     through the real `Cadence_Scheduler` (Req 2.3, 3.1) and to enqueue inbound
//     webhook processing onto pg-boss;
//   - the long-running worker calls {@link getRuntime} then
//     {@link registerWorkers} to register the cadence, nurture, and outbound
//     pg-boss handlers (design "Entry points").
//
// It is intentionally NOT re-exported from the `@/services` barrel: importing it
// opens a database pool and a pg-boss connection, so consumers that genuinely
// need the live runtime import `@/services/runtime` explicitly (mirroring how
// `@/db/client` is kept out of the `@/db` barrel).

import { PgBoss } from "pg-boss";

import { CADENCE_TEST_MODE, CADENCE_TOUCHES_COUNT } from "@/core/cadence";
import type { AntiBanConfig, Clock } from "@/core/types";
import { DrizzleComplianceRepository } from "@/db/compliance-repository";
import { DrizzleHandoffRepository } from "@/db/handoff-repository";
import { DrizzleLeadRepository } from "@/db/lead-repository";
import { DrizzleMessageRepository } from "@/db/message-repository";
import { DrizzleNumberRepository } from "@/db/number-repository";
import { DrizzleScheduledJobRepository } from "@/db/scheduled-job-repository";
import {
	createAntiBanController,
	type AntiBanController,
} from "@/services/anti-ban-controller";
import {
	createCadenceScheduler,
	type CadenceJobQueue,
	type CadenceScheduler,
	type CadenceTouchJob,
} from "@/services/cadence-scheduler";
import {
	createCadenceWorker,
	type CadenceWorker,
} from "@/services/cadence-worker";
import {
	createComplianceManager,
	type ComplianceManager,
} from "@/services/compliance-manager";
import {
	createHandoffManager,
	type HandoffManager,
} from "@/services/handoff-manager";
import { createHandoffNotifier } from "@/services/handoff-notifier";
import {
	createInboundHandler,
	type InboundHandler,
	type InboundMessage,
} from "@/services/inbound-handler";
import {
	type InboundProcessingJob,
	type InboundProcessingQueue,
} from "@/services/inbound-webhook";
import {
	createLeadImporter,
	type LeadImporter,
} from "@/services/lead-importer";
import {
	createLifecycleManager,
	type LifecycleManager,
} from "@/services/lifecycle-manager";
import {
	createNurtureScheduler,
	type NurtureJob,
	type NurtureJobQueue,
	type NurtureScheduler,
} from "@/services/nurture-scheduler";
import {
	createNurtureWorker,
	type NurtureWorker,
} from "@/services/nurture-worker";
import {
	createOutboundWorker,
	createSequentialOutboundSendCommitter,
	type OutboundSendQueue,
	type OutboundSendRequest,
	type OutboundWorker,
} from "@/services/outbound-worker";
import type { MessageRepository } from "@/services/repositories";
import {
	createScoringEngine,
	type ScoringEngine,
} from "@/services/scoring-engine";
import {
	createWahaClient,
	numberSessionResolverFromRepository,
	type WahaClient,
} from "@/services/waha-client";

// ---------------------------------------------------------------------------
// Queue names (the durable pg-boss queues backing the schedulers/workers)
// ---------------------------------------------------------------------------

/** The durable pg-boss queue names used across the system. */
export const QUEUE_NAMES = {
	/** Delayed cadence touch jobs T1–T5 (Req 3.2, 3.4). */
	cadence: "cadence-touch",
	/** Self-perpetuating monthly nurture jobs (Req 6.3). */
	nurture: "monthly-nurture",
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
 * `CONSULTANT_NOTIFY_NUMBERS` into a trimmed, non-empty E.164 list. An unset or
 * empty value yields `[]`, which disables the handoff notifier entirely.
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

/**
 * Resolve the domain `numberId` the consultant alert is sent *from*. When
 * `CONSULTANT_NOTIFY_FROM_NUMBER` is set it matches a registered number by
 * session name or msisdn; otherwise (or on no match) it falls back to the first
 * available number, then any registered number. Returns `undefined` when no
 * number is registered, in which case the alert is skipped.
 */
async function resolveNotifyFromNumberId(
	numbers: DrizzleNumberRepository,
	configured: string | undefined,
): Promise<string | undefined> {
	if (configured) {
		const all = await numbers.listAll();
		const match = all.find(
			(n) => n.sessionName === configured || n.msisdn === configured,
		);
		if (match) {
			return match.id;
		}
	}
	const available = await numbers.listAvailable();
	if (available.length > 0) {
		return available[0].id;
	}
	const all = await numbers.listAll();
	return all[0]?.id;
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
		warmupRampDays: envInt("ANTIBAN_WARMUP_RAMP_DAYS", 14),
		delayMinMs: envInt("ANTIBAN_DELAY_MIN_MS", 30_000),
		delayMaxMs: envInt("ANTIBAN_DELAY_MAX_MS", 120_000),
		sendWindow: {
			startHour: envInt("ANTIBAN_SEND_WINDOW_START_HOUR", 9),
			endHour: envInt("ANTIBAN_SEND_WINDOW_END_HOUR", 20),
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
				console.error("[pg-boss] error:", err);
			});
			await boss.start();
			await Promise.all(
				Object.values(QUEUE_NAMES).map((name) => boss.createQueue(name)),
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

/** Adapt the cadence pg-boss queue to the scheduler's {@link CadenceJobQueue}. */
function cadenceJobQueue(boss: PgBoss): CadenceJobQueue {
	return {
		async enqueueTouch(job: CadenceTouchJob, fireAt: Date): Promise<string> {
			const jobId = await boss.send(QUEUE_NAMES.cadence, job, {
				startAfter: fireAt,
			});
			return requireJobId(jobId, QUEUE_NAMES.cadence);
		},
		async cancel(jobId: string): Promise<void> {
			await boss.cancel(QUEUE_NAMES.cadence, jobId);
		},
	};
}

/** Adapt the nurture pg-boss queue to the scheduler's {@link NurtureJobQueue}. */
function nurtureJobQueue(boss: PgBoss): NurtureJobQueue {
	return {
		async enqueueNurture(job: NurtureJob, fireAt: Date): Promise<string> {
			const jobId = await boss.send(QUEUE_NAMES.nurture, job, {
				startAfter: fireAt,
			});
			return requireJobId(jobId, QUEUE_NAMES.nurture);
		},
		async cancel(jobId: string): Promise<void> {
			await boss.cancel(QUEUE_NAMES.nurture, jobId);
		},
	};
}

/** Adapt the outbound pg-boss queue to the features' {@link OutboundSendQueue}. */
function outboundSendQueue(boss: PgBoss): OutboundSendQueue {
	return {
		async enqueueSend(request: OutboundSendRequest): Promise<string> {
			// Features (cadence/nurture/qualification) enqueue only the request; the
			// physical sending number is assigned when the job is dequeued by the
			// outbound handler (design "Enqueue outbound send job").
			const jobId = await boss.send(QUEUE_NAMES.outbound, request);
			return requireJobId(jobId, QUEUE_NAMES.outbound);
		},
	};
}

/** Adapt the inbound pg-boss queue to the webhook's {@link InboundProcessingQueue}. */
function inboundProcessingQueue(boss: PgBoss): InboundProcessingQueue {
	return {
		async enqueueInbound(job: InboundProcessingJob): Promise<string> {
			const jobId = await boss.send(QUEUE_NAMES.inbound, job);
			return requireJobId(jobId, QUEUE_NAMES.inbound);
		},
	};
}

// ---------------------------------------------------------------------------
// Runtime assembly
// ---------------------------------------------------------------------------

/**
 * The fully-wired runtime: the started pg-boss instance, the concrete
 * repositories, the domain services, and the durable queues. Built once per
 * process by {@link getRuntime} and shared by the web and worker entry points.
 */
export interface Runtime {
	boss: PgBoss;
	antiBanConfig: AntiBanConfig;
	clock: Clock;
	leads: DrizzleLeadRepository;
	messages: DrizzleMessageRepository;
	numbers: DrizzleNumberRepository;
	scheduledJobs: DrizzleScheduledJobRepository;
	waha: WahaClient;
	antiBan: AntiBanController;
	lifecycle: LifecycleManager;
	compliance: ComplianceManager;
	handoff: HandoffManager;
	scoring: ScoringEngine;
	cadenceScheduler: CadenceScheduler;
	nurtureScheduler: NurtureScheduler;
	cadenceWorker: CadenceWorker;
	nurtureWorker: NurtureWorker;
	outboundWorker: OutboundWorker;
	outboundQueue: OutboundSendQueue;
	inboundQueue: InboundProcessingQueue;
	importer: LeadImporter;
}

const globalForRuntime = globalThis as unknown as {
	__markoRuntime?: Promise<Runtime>;
};

/**
 * Build (once) the shared runtime over a started pg-boss instance and the live
 * Drizzle data layer. Wires the enrollment path (`Lead_Importer` →
 * `Cadence_Scheduler`, Req 2.3, 3.1), the cadence/nurture/outbound workers'
 * domain logic, and the outbound choke point (Req 16, 17, 18) so the web app
 * and the worker share exactly the same domain wiring.
 */
export function getRuntime(): Promise<Runtime> {
	if (!globalForRuntime.__markoRuntime) {
		globalForRuntime.__markoRuntime = (async () => {
			if (CADENCE_TEST_MODE) {
				console.warn(
					"[runtime] ⚠️  CADENCE_TEST_MODE is ON — offsets are in seconds, touches limited to",
					CADENCE_TOUCHES_COUNT,
				);
			}

			const boss = await getBoss();
			const antiBanConfig = defaultAntiBanConfig();
			const clock: Clock = { now: () => new Date() };

			// Concrete repositories (data layer).
			const leads = new DrizzleLeadRepository();
			const messages = new DrizzleMessageRepository();
			const numbers = new DrizzleNumberRepository();
			const scheduledJobs = new DrizzleScheduledJobRepository();

			// Pure-core-backed managers and controllers.
			const lifecycle = createLifecycleManager({ leads });
			const complianceRepo = new DrizzleComplianceRepository();
			const handoffRepo = new DrizzleHandoffRepository();
			const compliance = createComplianceManager({
				leads,
				compliance: complianceRepo,
				scheduledJobs,
				lifecycle,
			});
			const waha = createWahaClient({
				baseUrl: process.env.WAHA_BASE_URL ?? "http://localhost:3000",
				apiKey: process.env.WAHA_API_KEY,
				resolveNumber: numberSessionResolverFromRepository(numbers),
				resolutionSession: process.env.WAHA_SESSION,
			});
			// Best-effort consultant alert on handoff (beta: env-configured). Only
			// constructed when at least one consultant number is configured, so the
			// handoff path stays a no-op for the notifier otherwise.
			const consultantNumbers = parseConsultantNumbers(
				process.env.CONSULTANT_NOTIFY_NUMBERS,
			);
			const handoffNotifier =
				consultantNumbers.length > 0
					? createHandoffNotifier({
							waha,
							leads,
							consultantNumbers,
							resolveFromNumberId: () =>
								resolveNotifyFromNumberId(
									numbers,
									process.env.CONSULTANT_NOTIFY_FROM_NUMBER,
								),
							crmBaseUrl: process.env.CRM_BASE_URL,
						})
					: undefined;
			const handoff = createHandoffManager({
				lifecycle,
				handoffEvents: handoffRepo,
				scheduledJobs,
				notifier: handoffNotifier,
			});
			const scoring = createScoringEngine({
				leads,
				clock,
				sendWindow: {
					startHour: antiBanConfig.sendWindow.startHour,
					endHour: antiBanConfig.sendWindow.endHour,
				},
			});
			const antiBan = createAntiBanController({
				numbers,
				config: antiBanConfig,
				clock,
			});

			// Durable queues.
			const outboundQueue = outboundSendQueue(boss);
			const inboundQueue = inboundProcessingQueue(boss);

			// Schedulers (enrollment + monthly nurture) over the durable queues.
			const cadenceScheduler = createCadenceScheduler({
				lifecycle,
				scheduledJobs,
				queue: cadenceJobQueue(boss),
			});
			const nurtureScheduler = createNurtureScheduler({
				lifecycle,
				scheduledJobs,
				queue: nurtureJobQueue(boss),
				clock,
			});

			// Workers (the pg-boss handler domain logic).
			const cadenceWorker = createCadenceWorker({
				leads,
				cadence: cadenceScheduler,
				outbound: outboundQueue,
				lifecycle,
				nurture: nurtureScheduler,
				scheduledJobs,
			});
			const nurtureWorker = createNurtureWorker({
				leads,
				outbound: outboundQueue,
				nurture: nurtureScheduler,
			});
			const outboundWorker = createOutboundWorker({
				leads,
				antiBan,
				waha,
				commit: createSequentialOutboundSendCommitter({ antiBan, messages }),
				clock,
			});

			// The source-agnostic importer, enrolling new leads through the same
			// `Cadence_Scheduler` every future real-time source will use (Req 2.2,
			// 2.3, 3.1).
			const importer = createLeadImporter({
				leads,
				cadence: cadenceScheduler,
				clock,
			});

			return {
				boss,
				antiBanConfig,
				clock,
				leads,
				messages,
				numbers,
				scheduledJobs,
				antiBan,
				lifecycle,
				compliance,
				handoff,
				scoring,
				cadenceScheduler,
				nurtureScheduler,
				cadenceWorker,
				nurtureWorker,
				outboundWorker,
				outboundQueue,
				inboundQueue,
				importer,
				waha,
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
	request: OutboundSendRequest,
): Promise<void> {
	const now = rt.clock.now();
	console.log("[outbound] processing send", {
		leadId: request.leadId,
		kind: request.kind,
	});

	// Outside the global send window → defer to the window reopening (Req 17.4).
	if (!rt.antiBan.withinSendWindow()) {
		console.warn(
			"[outbound] outside send window; deferring",
			request.leadId,
			request.kind,
		);
		await rt.boss.send(QUEUE_NAMES.outbound, request, {
			startAfter: nextSendWindowStart(rt.antiBanConfig, now),
		});
		return;
	}

	const candidates = await rt.numbers.listAvailable();
	if (candidates.length === 0) {
		console.warn(
			"[outbound] no available WhatsApp numbers registered — nothing can be " +
				"sent. Add a sending number in the CRM (Numbers page) / `numbers` table.",
		);
	}
	for (const number of candidates) {
		if (!(await rt.antiBan.canAssignSend(number.id))) {
			continue;
		}
		const outcome = await rt.outboundWorker.process({
			leadId: request.leadId,
			numberId: number.id,
			content: request.content,
			kind: request.kind,
		});
		console.log("[outbound] send outcome", {
			leadId: request.leadId,
			numberId: number.id,
			status: outcome.status,
		});
		switch (outcome.status) {
			case "sent":
			case "dropped_opt_out":
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
	console.warn(
		"[outbound] no sendable number right now (none available, blocked, or " +
			"at daily cap); deferring to next day",
		{ leadId: request.leadId, kind: request.kind },
	);
	await rt.boss.send(QUEUE_NAMES.outbound, request, {
		startAfter: nextLocalMidnight(now),
	});
}

// ---------------------------------------------------------------------------
// Inbound consumer wiring (worker entry point only)
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link MessageRepository} so `append` is idempotent on the inbound
 * `wa_message_id`: the webhook already persisted the raw inbound message before
 * enqueuing, so the worker-side {@link InboundHandler} must NOT insert it again
 * (GUIA_ARQUITETURA_COMPLETO §14.2 #3). When a message with the same
 * `wa_message_id` already exists, the existing record is returned instead of a
 * second insert; everything else delegates unchanged.
 */
function idempotentInboundMessages(
	messages: MessageRepository,
): MessageRepository {
	return {
		listByLead: (leadId) => messages.listByLead(leadId),
		findByWaMessageId: (waMessageId) => messages.findByWaMessageId(waMessageId),
		async append(input) {
			if (input.waMessageId) {
				const existing = await messages.findByWaMessageId(input.waMessageId);
				if (existing) {
					return existing;
				}
			}
			return messages.append(input);
		},
	};
}

/** Resolve the domain `numberId` for the WAHA session that received a message. */
export async function resolveNumberIdForSession(
	rt: Runtime,
	session: string,
): Promise<string | undefined> {
	const all = await rt.numbers.listAll();
	return all.find((n) => n.sessionName === session)?.id;
}

/**
 * Compose the {@link InboundHandler} for the worker: wires the already-built
 * managers/repositories from the runtime, with the idempotent message wrapper so
 * the webhook's raw inbound is not re-persisted. In the beta flow a reply hands
 * the Lead straight off to a consultant via {@link Runtime.handoff}; there is no
 * AI qualification turn.
 */
export function createRuntimeInboundHandler(rt: Runtime): InboundHandler {
	return createInboundHandler({
		leads: rt.leads,
		messages: idempotentInboundMessages(rt.messages),
		waha: rt.waha,
		compliance: rt.compliance,
		cadence: rt.cadenceScheduler,
		nurture: rt.nurtureScheduler,
		scoring: rt.scoring,
		handoff: rt.handoff,
	});
}

// ---------------------------------------------------------------------------
// Worker handler registration (worker entry point only)
// ---------------------------------------------------------------------------

/**
 * Register the cadence, nurture, and outbound pg-boss job handlers on the
 * worker process (design "Entry points"). Each handler delegates to the
 * already-wired worker domain logic; this function only adapts the pg-boss job
 * envelope (an array of jobs carrying the typed payload) to a `process` call.
 *
 * Only the long-running worker calls this — the web app enqueues but never
 * consumes. This includes the inbound queue: its pipeline (scoring and the
 * handoff to a consultant) runs here via {@link createRuntimeInboundHandler},
 * while the webhook only persists and enqueues durably so no inbound delivery is
 * lost.
 */
export async function registerWorkers(rt: Runtime): Promise<void> {
	await rt.boss.work<CadenceTouchJob>(QUEUE_NAMES.cadence, async (jobs) => {
		for (const job of jobs) {
			console.log("Processing job:", job.data);
			await rt.cadenceWorker.process(job.data);
		}
	});

	await rt.boss.work<NurtureJob>(QUEUE_NAMES.nurture, async (jobs) => {
		for (const job of jobs) {
			await rt.nurtureWorker.process(job.data);
		}
	});

	await rt.boss.work<OutboundSendRequest>(
		QUEUE_NAMES.outbound,
		async (jobs) => {
			for (const job of jobs) {
				await processOutboundRequest(rt, job.data);
			}
		},
	);

	// Inbound processing: the webhook persists + enqueues each inbound message;
	// this is the consumer that runs the Inbound_Handler pipeline (sendSeen,
	// opt-out, cadence/nurture cancellation, scoring, and the handoff to a
	// consultant). Previously unregistered, so replies were enqueued but never
	// processed (GUIA_ARQUITETURA_COMPLETO §14.2 #2). The message append is made
	// idempotent so the raw inbound persisted at the webhook is not double-written
	// (#3).
	const inboundHandler = createRuntimeInboundHandler(rt);
	await rt.boss.work<InboundProcessingJob>(
		QUEUE_NAMES.inbound,
		async (jobs) => {
			for (const job of jobs) {
				const numberId = await resolveNumberIdForSession(rt, job.data.session);
				const msg: InboundMessage = {
					from: job.data.from,
					text: job.data.text,
					// pg-boss round-trips the payload through JSON, so `receivedAt`
					// arrives as a string; rehydrate it to a Date.
					receivedAt: new Date(job.data.receivedAt),
					waMessageId: job.data.waMessageId,
					numberId,
				};
				console.log("[inbound] processing reply", {
					leadId: job.data.leadId,
					from: job.data.from,
					numberId: numberId ?? "(no number matched session)",
					session: job.data.session,
				});
				try {
					await inboundHandler.handle(msg);
					console.log("[inbound] pipeline completed", {
						leadId: job.data.leadId,
					});
				} catch (err) {
					// Surface the real failure rather than letting pg-boss retry it
					// silently. Rethrow so the job is marked failed instead of
					// acknowledged as done.
					console.error(
						"[inbound] pipeline FAILED for lead",
						job.data.leadId,
						err,
					);
					throw err;
				}
			}
		},
	);
}
