// Internal CRM API — WhatsApp session provisioning (create + start).
//
// Guarded by session. Generates a fresh WAHA session name and creates + starts
// the session so the numbers UI can render its scan QR. The number row is not
// persisted here — that happens on `/confirm` once the session reaches WORKING
// and WAHA reports the authenticated line.

import { NextResponse } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { logger } from "@/logger";
import { wahaAdmin } from "@/services/waha-admin-client";

// Multi-tenant seam: prefix the generated session name so it becomes
// `t_<tenantId>_…` once organizations land. Empty for the single-business build.
const TENANT_PREFIX = "";

/** A short, collision-resistant, tenant-ready WAHA session name. */
function generateSessionName(): string {
	return `${TENANT_PREFIX}wa-${crypto.randomUUID().slice(0, 8)}`;
}

export async function POST(): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const sessionName = generateSessionName();
	try {
		const info = await wahaAdmin.createSession(sessionName);
		return NextResponse.json(
			{ sessionName: info.name, status: info.status },
			{ status: 201 },
		);
	} catch (err) {
		// The base URL goes in the line on purpose: the usual cause of a 502 here
		// is a WAHA_BASE_URL that is missing or points at an address the app
		// cannot reach (e.g. the compose-internal `http://waha:3000`), and that is
		// invisible from the WAHA side — the request never leaves the app.
		logger.error(
			{
				event: "crm.session_create_failed",
				sessionName,
				wahaBaseUrl: wahaAdmin.configuredBaseUrl,
				err,
			},
			"failed to create WAHA session",
		);
		return NextResponse.json(
			{ error: "Failed to create WhatsApp session" },
			{ status: 502 },
		);
	}
}
