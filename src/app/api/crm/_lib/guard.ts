// Internal CRM API session guard (Req 21.1, 21.3).
//
// Side-effect boundary: server-only helper used by every `/api/crm/*` route to
// perform the authoritative session check. The edge proxy (`src/proxy.ts`)
// already rejects cookie-less requests optimistically; this adds the
// server-side validation (including expiry) that denies unauthenticated or
// expired sessions with a machine-readable `401` before any lead data is read.
//
// It is also the ONLY place a route may learn which organization it is acting
// for. The organization comes from the server-side session
// (`session.activeOrganizationId`, stamped at login from the user's membership)
// and never from the request body, query string, or a header — otherwise any
// authenticated user could read another tenant's data simply by naming its id.

import { NextResponse } from "next/server";

import { getServerSession } from "@/services/auth";

/** The caller identity a CRM route acts as: a user within one organization. */
export interface OrgSession {
	userId: string;
	/** The tenant every query this request makes must be scoped to. */
	organizationId: string;
}

/**
 * Resolve the caller's user + active organization, or the deny response to
 * return as-is. Discriminate with `"denied" in result`:
 *
 * ```ts
 * const auth = await requireOrgSession();
 * if ("denied" in auth) return auth.denied;
 * const { organizationId } = auth.org;
 * ```
 *
 * Denies with `401` when there is no valid session (Req 21.1, 21.3), and with
 * `403` when the session carries no active organization — a user with no
 * membership has no tenant to act within, and must never fall back to reading
 * unscoped data.
 */
export async function requireOrgSession(): Promise<
	{ org: OrgSession } | { denied: NextResponse }
> {
	const session = await getServerSession();
	if (!session) {
		return {
			denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
		};
	}
	const organizationId = session.session.activeOrganizationId;
	if (!organizationId) {
		return {
			denied: NextResponse.json(
				{ error: "no active organization" },
				{ status: 403 },
			),
		};
	}
	return { org: { userId: session.user.id, organizationId } };
}
