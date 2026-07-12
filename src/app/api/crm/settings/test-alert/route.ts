// Internal CRM API — send a sample handoff alert to the caller (POST).
//
// Sends the caller's own verified phone a handoff alert built from a sample
// Lead, so a consultant sees exactly what a real alert looks like — and proves
// the WAHA pipeline end-to-end — before the first real lead hands off.
// Requires a verified phone (409 otherwise). Guarded by session.

import { NextResponse } from "next/server";

import type { LeadSnapshot } from "@/core/types";
import { requireMemberSession } from "@/app/api/crm/settings/_lib/session";
import { settingsWiring } from "@/app/api/crm/settings/_lib/wiring";
import { buildHandoffNotificationText } from "@/services/handoff-notifier";
import { logger } from "@/logger";

/** A representative sample Lead for the alert preview (never persisted). */
function sampleLead(now: Date): LeadSnapshot {
	return {
		id: "exemplo",
		phoneE164: "+5547999990000",
		source: "exemplo",
		lifecycleState: "HOT",
		optInStatus: "opt_in",
		optInAt: now,
		score: 75,
		blocked: false,
		unreachableAt: null,
		classificationBand: "HOT",
		qualification: {
			segment: "imóvel",
			creditValue: 300_000,
			objective: "housing",
			income: 8_000,
			hasLanceReserve: true,
		},
		assignedConsultantId: null,
		lastOutboundAt: null,
		lastInboundAt: now,
		createdAt: now,
		updatedAt: now,
	};
}

export async function POST(): Promise<NextResponse> {
	const auth = await requireMemberSession();
	if ("denied" in auth) return auth.denied;
	const { userId, organizationId } = auth.member;

	const { consultants, waha, resolveFromNumberId } = settingsWiring();
	const settings = await consultants.getNotificationSettings(
		userId,
		organizationId,
	);
	if (!settings?.phoneE164 || settings.phoneVerifiedAt === null) {
		return NextResponse.json(
			{ error: "Verifique seu WhatsApp antes de enviar um alerta de teste." },
			{ status: 409 },
		);
	}

	const fromNumberId = await resolveFromNumberId();
	if (!fromNumberId) {
		return NextResponse.json(
			{
				error:
					"Nenhum número WhatsApp conectado para enviar o teste. " +
					"Conecte um número na página Números primeiro.",
			},
			{ status: 409 },
		);
	}

	// The sample omits the CRM deep link on purpose: its Lead does not exist,
	// so a link would 404.
	const text = `[TESTE — alerta de exemplo]\n\n${buildHandoffNotificationText(sampleLead(new Date()), "replied")}`;
	try {
		const chatId = await waha.resolveChatId(settings.phoneE164);
		await waha.sendText(fromNumberId, chatId, text);
	} catch (err) {
		logger.error(
			{ event: "settings.test_alert_failed", userId, err },
			"failed to send test alert",
		);
		return NextResponse.json(
			{ error: "Falha ao enviar o teste pelo WhatsApp. Tente novamente." },
			{ status: 502 },
		);
	}

	return NextResponse.json({ ok: true });
}
