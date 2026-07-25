// Internal CRM API — WhatsApp session status (poll target).
//
// Guarded by session. Read-only, safe to poll: returns the session's current
// status, the scan QR (while awaiting a scan), and the authenticated account
// (once WORKING). The numbers UI polls this to drive the connect flow.

import { NextResponse } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import type { SessionStatusView } from "@/app/crm/_lib/types";
import { msisdnFromMe, wahaAdmin } from "@/services/waha-admin-client";

type Params = { params: Promise<{ sessionName: string }> };

export async function GET(
	_request: Request,
	{ params }: Params,
): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const { sessionName } = await params;
	try {
		const info = await wahaAdmin.getSession(sessionName);

		const view: SessionStatusView = { status: info.status };

		if (info.status === "SCAN_QR_CODE") {
			view.qr = (await wahaAdmin.getQrDataUrl(sessionName)) ?? undefined;
		}

		if (info.status === "WORKING") {
			const msisdn = msisdnFromMe(info.me);
			if (msisdn) {
				view.me = { msisdn, pushName: info.me?.pushName };
			}
		}

		return NextResponse.json(view);
	} catch {
		return NextResponse.json(
			{ error: "Failed to read WhatsApp session" },
			{ status: 502 },
		);
	}
}

/**
 * Tear down a pending session that was never confirmed (the operator closed the
 * connect panel before scanning). Best-effort and always returns ok — there is
 * no persisted number row to clean up at this point, only the WAHA session.
 */
export async function DELETE(
	_request: Request,
	{ params }: Params,
): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const { sessionName } = await params;
	await wahaAdmin.logoutAndDelete(sessionName);
	return NextResponse.json({ ok: true });
}
