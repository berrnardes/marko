// Internal CRM API — WhatsApp session provisioning (create + start).
//
// Guarded by session. Generates a fresh WAHA session name and creates + starts
// the session so the numbers UI can render its scan QR. The number row is not
// persisted here — that happens on `/confirm` once the session reaches WORKING
// and WAHA reports the authenticated line.

import { NextResponse } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { wahaAdmin } from "@/services/waha-admin-client";

// Multi-tenant seam: prefix the generated session name so it becomes
// `t_<tenantId>_…` once organizations land. Empty for the single-business build.
const TENANT_PREFIX = "";

/** A short, collision-resistant, tenant-ready WAHA session name. */
function generateSessionName(): string {
	return `${TENANT_PREFIX}wa-${crypto.randomUUID().slice(0, 8)}`;
}

export async function POST(): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) return denied;

	const sessionName = generateSessionName();
	try {
		const info = await wahaAdmin.createSession(sessionName);
		return NextResponse.json(
			{ sessionName: info.name, status: info.status },
			{ status: 201 },
		);
	} catch {
		return NextResponse.json(
			{ error: "Failed to create WhatsApp session" },
			{ status: 502 },
		);
	}
}
