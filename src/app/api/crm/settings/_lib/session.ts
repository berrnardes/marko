// Settings API session helper (server-only).
//
// The settings routes act on "the signed-in member of the active
// organization", so beyond the plain authentication check they need the
// caller's user id and active organization id. This wraps the shared
// `getServerSession` guard with that extraction: a missing session denies with
// 401 (Req 21.1, 21.3), and a session without an active organization (a user
// with no membership — the session hook stamps one at login otherwise) denies
// with 403.

import { NextResponse } from "next/server";

import { getServerSession } from "@/services/auth";

/** The caller identity the settings routes act on. */
export interface MemberSession {
	userId: string;
	organizationId: string;
}

/**
 * Resolve the caller's user + active organization, or the deny response to
 * return as-is. Discriminate with `"denied" in result`.
 */
export async function requireMemberSession(): Promise<
	{ member: MemberSession } | { denied: NextResponse }
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
	return { member: { userId: session.user.id, organizationId } };
}
