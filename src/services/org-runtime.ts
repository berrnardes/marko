// Per-organization domain wiring (composition root, tenant slice).
//
// Side-effect boundary: this is the second half of the composition root. Where
// `@/services/runtime` owns what is genuinely process-wide — the pg-boss
// connection, the anti-ban configuration, the clock — this module owns what is
// per-tenant: the Drizzle repositories bound to one `organizationId` and the
// domain services wired over them.
//
// Why the split. `getRuntime()` is a process-wide singleton (one pg-boss
// connection per process), so its repositories cannot carry a tenant. Rather
// than thread an `organizationId` argument through every method of every domain
// service — each one only forwarding it to the repository underneath — the
// tenant is fixed at CONSTRUCTION: a repository is built for exactly one
// organization and physically cannot read or write another's rows. The services
// above them keep their existing signatures and stay tenant-unaware, which is
// what makes this cheap: `getOrgServices` allocates a handful of stateless
// objects and reuses the shared pg-boss instance.
//
// Every caller must name an organization to get here:
//   - CRM routes take it from `requireOrgSession()` (the session, never the
//     request body);
//   - the workers take it from the job payload, which the enqueuing side
//     stamped;
//   - the inbound webhook resolves it from the WAHA session name via
//     `findNumberBySessionName`.

import { createRefreshableMessageGenerator } from "@/core/messages";
import type { AntiBanConfig, Clock } from "@/core/types";
import { db, type Database } from "@/db/client";
import { DrizzleComplianceRepository } from "@/db/compliance-repository";
import { DrizzleConsultantRepository } from "@/db/consultant-repository";
import { DrizzleHandoffRepository } from "@/db/handoff-repository";
import { DrizzleLeadRepository } from "@/db/lead-repository";
import { DrizzleMessageRepository } from "@/db/message-repository";
import { DrizzleMessageTemplateRepository } from "@/db/message-template-repository";
import { DrizzleNumberRepository } from "@/db/number-repository";
import { DrizzleScheduledJobRepository } from "@/db/scheduled-job-repository";
import { logger } from "@/logger";
import {
	createAntiBanController,
	type AntiBanController,
} from "@/services/anti-ban-controller";
import {
	createCadenceScheduler,
	type CadenceJobQueue,
	type CadenceScheduler,
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
} from "@/services/inbound-handler";
import {
	createLeadImporter,
	type LeadImporter,
} from "@/services/lead-importer";
import {
	createLifecycleManager,
	type LifecycleManager,
} from "@/services/lifecycle-manager";
import {
	createOutboundWorker,
	createSequentialOutboundSendCommitter,
	type OutboundSendQueue,
	type OutboundWorker,
} from "@/services/outbound-worker";
import type { MessageRepository } from "@/services/repositories";
import {
	createWahaClient,
	numberSessionResolverFromRepository,
	type WahaClient,
} from "@/services/waha-client";

/**
 * The domain layer for ONE organization: the tenant-bound repositories and the
 * services wired over them. Everything here is stateless and cheap to build, so
 * it is constructed per request (web) or per job (worker) rather than cached —
 * caching would only add an eviction problem for no measurable gain.
 */
export interface OrgServices {
	/** The tenant every repository below is bound to. */
	organizationId: string;
	leads: DrizzleLeadRepository;
	messages: DrizzleMessageRepository;
	numbers: DrizzleNumberRepository;
	scheduledJobs: DrizzleScheduledJobRepository;
	templates: DrizzleMessageTemplateRepository;
	waha: WahaClient;
	antiBan: AntiBanController;
	lifecycle: LifecycleManager;
	compliance: ComplianceManager;
	handoff: HandoffManager;
	cadenceScheduler: CadenceScheduler;
	cadenceWorker: CadenceWorker;
	outboundWorker: OutboundWorker;
	importer: LeadImporter;
	inboundHandler: InboundHandler;
	/**
	 * Load this organization's customized message templates into the cadence
	 * worker's generator. Called before processing a cadence job so operator
	 * edits apply without restarting the worker; a key with no stored row keeps
	 * the built-in default.
	 */
	refreshTemplates: () => Promise<void>;
}

/** The process-wide pieces `getOrgServices` needs from `@/services/runtime`. */
export interface OrgServicesContext {
	/** Anti-ban configuration (caps, ramp, delay range, send window). */
	antiBanConfig: AntiBanConfig;
	/** Injected time source shared with the rest of the process. */
	clock: Clock;
	/**
	 * Build the cadence enqueue seam for one organization. These are factories
	 * rather than plain queues because each enqueued job must carry the
	 * `organizationId` the consumer will rebuild these services from when the job
	 * fires — potentially days later, in the worker process. The domain services
	 * stay tenant-unaware; the queue adapter stamps the tenant on the way out.
	 */
	cadenceQueue: (organizationId: string) => CadenceJobQueue;
	/** Build the durable outbound choke-point queue for one organization. */
	outboundQueue: (organizationId: string) => OutboundSendQueue;
	/**
	 * Deprecated migration fallback: consultant alert numbers from
	 * `CONSULTANT_NOTIFY_NUMBERS`, used only while no member of the organization
	 * has a verified phone with alerts on.
	 */
	envNotifyNumbers: readonly string[];
	/** Optional `CONSULTANT_NOTIFY_FROM_NUMBER` preference for the alert sender. */
	notifyFromNumber?: string;
	/** CRM base URL used to deep-link the lead in a consultant alert. */
	crmBaseUrl?: string;
}

/**
 * Wrap a {@link MessageRepository} so `append` is idempotent on the inbound
 * `wa_message_id`: the webhook already persisted the raw inbound message before
 * enqueuing, so the worker-side inbound handler must NOT insert it again.
 * When a message with the same `wa_message_id` already exists, the existing
 * record is returned instead of a second insert; everything else delegates
 * unchanged. The lookup runs through the org-scoped repository, so it can only
 * ever match this tenant's own messages.
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

/**
 * Resolve the domain `numberId` a consultant alert is sent *from*, within this
 * organization. When `configured` is set it matches one of the org's registered
 * numbers by session name or msisdn; otherwise (or on no match) it falls back to
 * the first available number, then any registered one. Returns `undefined` when
 * the organization has registered no number, in which case the alert is skipped.
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

/**
 * Build the domain layer for `organizationId` over the process-wide `context`.
 *
 * The returned services are indistinguishable from the ones the pre-tenancy
 * runtime built — same interfaces, same behavior — except that every query they
 * issue carries `WHERE organization_id = $organizationId`.
 */
export function getOrgServices(
	organizationId: string,
	context: OrgServicesContext,
	database: Database = db,
): OrgServices {
	// Tenant-bound repositories. From here down, nothing can reach another org's
	// rows: the filter is baked into each repository, not passed per call.
	//
	// `database` defaults to the shared pool. Web routes pass the transaction
	// opened by `withOrg` instead, so the same statements also carry the RLS
	// tenant context (ADR-004) — application filter and database policy agreeing
	// on the same organization.
	const leads = new DrizzleLeadRepository(organizationId, database);
	const messages = new DrizzleMessageRepository(organizationId, database);
	const numbers = new DrizzleNumberRepository(organizationId, database);
	const scheduledJobs = new DrizzleScheduledJobRepository(
		organizationId,
		database,
	);
	const templates = new DrizzleMessageTemplateRepository(
		organizationId,
		database,
	);
	const complianceRepo = new DrizzleComplianceRepository(
		organizationId,
		database,
	);
	const handoffRepo = new DrizzleHandoffRepository(organizationId, database);
	// Better Auth's `member`/`user` tables are not tenant-bound at construction
	// (see `DrizzleConsultantRepository`); the organization is passed per query.
	const consultants = new DrizzleConsultantRepository(database);

	const { generator: messageGenerator, setTemplates } =
		createRefreshableMessageGenerator();

	const waha = createWahaClient({
		baseUrl: process.env.WAHA_BASE_URL ?? "http://localhost:3000",
		apiKey: process.env.WAHA_API_KEY,
		resolveNumber: numberSessionResolverFromRepository(numbers),
	});

	const lifecycle = createLifecycleManager({ leads });
	const compliance = createComplianceManager({
		leads,
		compliance: complianceRepo,
		scheduledJobs,
		lifecycle,
	});
	const antiBan = createAntiBanController({
		numbers,
		config: context.antiBanConfig,
		clock: context.clock,
	});

	// Best-effort consultant alert on handoff. Recipients resolve at notify time
	// from THIS organization's membership (verified phone + alerts on), with the
	// deprecated env list as migration fallback.
	const handoffNotifier = createHandoffNotifier({
		waha,
		leads,
		resolveRecipients: async (leadId: string) => {
			const recipients =
				await consultants.listHandoffAlertRecipients(organizationId);
			if (recipients.length > 0) {
				return recipients;
			}
			if (context.envNotifyNumbers.length > 0) {
				logger.warn(
					{ event: "handoff.env_fallback", organizationId, leadId },
					"no member with a verified phone and alerts on; falling back to " +
						"deprecated CONSULTANT_NOTIFY_NUMBERS",
				);
			}
			return context.envNotifyNumbers;
		},
		resolveFromNumberId: () =>
			resolveNotifyFromNumberId(numbers, context.notifyFromNumber),
		crmBaseUrl: context.crmBaseUrl,
	});
	const handoff = createHandoffManager({
		lifecycle,
		handoffEvents: handoffRepo,
		scheduledJobs,
		notifier: handoffNotifier,
	});

	const cadenceScheduler = createCadenceScheduler({
		lifecycle,
		scheduledJobs,
		queue: context.cadenceQueue(organizationId),
	});

	const cadenceWorker = createCadenceWorker({
		leads,
		cadence: cadenceScheduler,
		outbound: context.outboundQueue(organizationId),
		lifecycle,
		scheduledJobs,
		messages: messageGenerator,
	});
	const outboundWorker = createOutboundWorker({
		leads,
		antiBan,
		waha,
		commit: createSequentialOutboundSendCommitter({ antiBan, messages }),
		clock: context.clock,
	});

	const importer = createLeadImporter({
		leads,
		cadence: cadenceScheduler,
		clock: context.clock,
	});

	const inboundHandler = createInboundHandler({
		leads,
		messages: idempotentInboundMessages(messages),
		waha,
		compliance,
		cadence: cadenceScheduler,
		handoff,
	});

	return {
		organizationId,
		leads,
		messages,
		numbers,
		scheduledJobs,
		templates,
		waha,
		antiBan,
		lifecycle,
		compliance,
		handoff,
		cadenceScheduler,
		cadenceWorker,
		outboundWorker,
		importer,
		inboundHandler,
		refreshTemplates: async () => {
			setTemplates(await templates.getAll());
		},
	};
}
