// Internal CRM API — the caller's handoff-alert settings (GET + PATCH toggle).
//
// GET returns the signed-in member's notification settings for the active
// organization: phone, verification state, the alert opt-in flag, and any
// pending (unexpired) verification so the UI can offer the code entry. PATCH
// updates the per-membership opt-in flag. Guarded by session.

import { NextResponse, type NextRequest } from "next/server";

import { requireMemberSession } from "@/app/api/crm/settings/_lib/session";
import { settingsWiring } from "@/app/api/crm/settings/_lib/wiring";

export async function GET(): Promise<NextResponse> {
	const auth = await requireMemberSession();
	if ("denied" in auth) return auth.denied;
	const { userId, organizationId } = auth.member;

	const { consultants, verifications } = settingsWiring();
	const settings = await consultants.getNotificationSettings(
		userId,
		organizationId,
	);
	if (!settings) {
		return NextResponse.json({ error: "no membership" }, { status: 403 });
	}

	const pending = await verifications.findByUser(userId);
	const pendingVerification =
		pending && pending.expiresAt.getTime() > Date.now()
			? { phoneE164: pending.phoneE164, expiresAt: pending.expiresAt }
			: null;

	return NextResponse.json({
		settings: {
			phoneE164: settings.phoneE164,
			phoneVerified: settings.phoneVerifiedAt !== null,
			receivesHandoffAlerts: settings.receivesHandoffAlerts,
			pendingVerification,
		},
	});
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
	const auth = await requireMemberSession();
	if ("denied" in auth) return auth.denied;
	const { userId, organizationId } = auth.member;

	const body = (await request.json()) as { receivesHandoffAlerts?: boolean };
	if (typeof body.receivesHandoffAlerts !== "boolean") {
		return NextResponse.json(
			{ error: "receivesHandoffAlerts (boolean) is required" },
			{ status: 400 },
		);
	}

	const { consultants } = settingsWiring();
	await consultants.setAlertOptIn(
		userId,
		organizationId,
		body.receivesHandoffAlerts,
	);
	return NextResponse.json({ ok: true });
}
