// Internal CRM API session guard (Req 21.1, 21.3).
//
// Side-effect boundary: server-only helper used by every `/api/crm/*` route to
// perform the authoritative session check. The edge proxy (`src/proxy.ts`)
// already rejects cookie-less requests optimistically; this adds the
// server-side validation (including expiry) that denies unauthenticated or
// expired sessions with a machine-readable `401` before any lead data is read.

import { NextResponse } from "next/server";

import { getServerSession } from "@/services/auth";

/**
 * Resolve the current session, or a `401` JSON response when the caller is
 * unauthenticated or the session has expired (Req 21.1, 21.3). Routes call this
 * first and return the response when present:
 *
 * ```ts
 * const denied = await denyIfUnauthenticated();
 * if (denied) return denied;
 * ```
 */
export async function denyIfUnauthenticated(): Promise<NextResponse | null> {
	const session = await getServerSession();
	if (!session) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}
	return null;
}
