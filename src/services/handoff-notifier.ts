// Consultant handoff notifier (I/O boundary — alert a human on handoff).
//
// Implements {@link HandoffNotifier} by sending a WhatsApp message carrying the
// handed-off Lead's context to the resolved consultant number(s), so a
// consultant is alerted on their own phone the moment a Lead replies to the
// cadence and is handed off (beta flow). The consultant then continues the
// conversation on the same WAHA number from a WhatsApp Web linked device.
//
// Side-effect boundary: reads the Lead via the injected `LeadRepository` and
// sends through the injected `WahaClient` only. It never throws into the handoff
// path — the {@link HandoffManager} invokes it best-effort — but it also guards
// each recipient send so one failing number does not stop the others.
//
// Both the recipients and the WhatsApp number the alert is sent *from* are
// supplied as resolvers computed lazily at notify time, so they always reflect
// current state: recipients come from org membership (members with a verified
// phone and alerts on, with a deprecated env fallback — see `runtime.ts`), and
// the sending number defaults to the first available registered number.

import type { HandoffReason, LeadSnapshot } from "@/core/types";
import { logger } from "@/logger";
import type { HandoffNotifier } from "@/services/handoff-manager";
import type { LeadRepository } from "@/services/repositories";
import type { WahaClient } from "@/services/waha-client";

/** Construction dependencies for {@link WahaHandoffNotifier}. */
export interface WahaHandoffNotifierConfig {
	/** Send the alert text and resolve recipient chat ids. */
	waha: Pick<WahaClient, "resolveChatId" | "sendText">;
	/** Read the handed-off Lead's context for the alert body. */
	leads: Pick<LeadRepository, "findById">;
	/**
	 * Resolve the consultant recipient numbers (E.164) to alert, computed lazily
	 * at notify time so membership changes apply without rebuilding the runtime.
	 * Takes the handed-off `leadId` so recipients can be scoped to the lead's
	 * organization once the domain tables are tenant-scoped. An empty result
	 * skips the alert (logged, never thrown).
	 */
	resolveRecipients: (leadId: string) => Promise<readonly string[]>;
	/**
	 * Resolve the domain `numberId` the alert is sent *from*, computed lazily so
	 * the "first available number" default reflects current state. Returns
	 * `undefined` when no number can send, in which case the alert is skipped.
	 */
	resolveFromNumberId: () => Promise<string | undefined>;
	/** CRM base URL used to build a deep link to the Lead (no trailing slash). */
	crmBaseUrl?: string;
}

/** Short PT-BR label for the handoff trigger, used in the alert body. */
const REASON_LABELS: Record<HandoffReason, string> = {
	replied: "respondeu à cadência",
	hot_score: "pontuação atingiu 70 (quente)",
	frustration: "frustração detectada",
	out_of_data: "pediu informação indisponível",
};

/** Append a `label: value` line when the value is present. */
function appendField(
	lines: string[],
	label: string,
	value: string | number | boolean | null,
): void {
	if (value !== null && value !== undefined && value !== "") {
		lines.push(`• ${label}: ${value}`);
	}
}

/**
 * Build the PT-BR consultant alert body from a Lead snapshot and the handoff
 * reason (Req 13). Pure over its inputs so it is unit-testable. Includes the
 * Lead's phone, score/band, whatever qualification data is already on file, and
 * a deep link to the Lead in the CRM when a base URL is configured.
 */
export function buildHandoffNotificationText(
	lead: LeadSnapshot,
	reason: HandoffReason,
	crmBaseUrl?: string,
): string {
	const lines: string[] = [
		"Novo lead para atendimento",
		"",
		`Motivo: ${REASON_LABELS[reason]}`,
		`• Telefone: ${lead.phoneE164}`,
		`• Pontuação: ${lead.score}${lead.classificationBand ? ` (${lead.classificationBand})` : ""}`,
	];

	const q = lead.qualification;
	appendField(lines, "Segmento", q.segment);
	appendField(lines, "Crédito", q.creditValue);
	appendField(
		lines,
		"Objetivo",
		q.objective === "housing"
			? "moradia"
			: q.objective === "investment"
				? "investimento"
				: null,
	);
	appendField(lines, "Renda", q.income);
	if (q.hasLanceReserve !== null) {
		appendField(lines, "Reserva p/ lance", q.hasLanceReserve ? "sim" : "não");
	}

	if (crmBaseUrl) {
		lines.push("", `Abrir no CRM: ${crmBaseUrl}/crm/leads/${lead.id}`);
	}

	return lines.join("\n");
}

/**
 * Concrete {@link HandoffNotifier} over the WAHA client. Reads the Lead,
 * resolves the current recipients, builds the alert body, and sends it to each
 * recipient from the resolved sending number. Best-effort throughout: a missing
 * Lead, no recipients, no available sending number, or a per-recipient failure
 * is logged and skipped rather than thrown, so a notification problem never
 * disturbs the handoff.
 */
export class WahaHandoffNotifier implements HandoffNotifier {
	private readonly waha: WahaHandoffNotifierConfig["waha"];
	private readonly leads: WahaHandoffNotifierConfig["leads"];
	private readonly resolveRecipients: WahaHandoffNotifierConfig["resolveRecipients"];
	private readonly resolveFromNumberId: () => Promise<string | undefined>;
	private readonly crmBaseUrl?: string;

	constructor(deps: WahaHandoffNotifierConfig) {
		this.waha = deps.waha;
		this.leads = deps.leads;
		this.resolveRecipients = deps.resolveRecipients;
		this.resolveFromNumberId = deps.resolveFromNumberId;
		this.crmBaseUrl = deps.crmBaseUrl;
	}

	/** @inheritdoc */
	async notify(leadId: string, reason: HandoffReason): Promise<void> {
		const lead = await this.leads.findById(leadId);
		if (!lead) {
			return;
		}
		const recipients = await this.resolveRecipients(leadId);
		if (recipients.length === 0) {
			logger.warn(
				{ event: "handoff.no_recipients", leadId },
				"no consultant has a verified phone with alerts on; skipping alert",
			);
			return;
		}
		const fromNumberId = await this.resolveFromNumberId();
		if (!fromNumberId) {
			logger.warn(
				{ event: "handoff.no_number", leadId },
				"no sending number available; skipping consultant alert",
			);
			return;
		}

		const text = buildHandoffNotificationText(lead, reason, this.crmBaseUrl);
		for (const recipient of recipients) {
			try {
				const chatId = await this.waha.resolveChatId(fromNumberId, recipient);
				await this.waha.sendText(fromNumberId, chatId, text);
				logger.info(
					{ event: "handoff.notified", leadId, reason },
					"consultant alerted",
				);
			} catch (err) {
				logger.error(
					{ event: "handoff.notify_failed", leadId, err },
					"failed to alert consultant",
				);
			}
		}
	}
}

/** Construct a {@link WahaHandoffNotifier} from its config. */
export function createHandoffNotifier(
	config: WahaHandoffNotifierConfig,
): HandoffNotifier {
	return new WahaHandoffNotifier(config);
}
