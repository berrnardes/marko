// Internal CRM API — lead list (Req 20.1).
//
// Guarded by the edge proxy (session cookie) and re-validated server-side here.
// Returns every lead as a summary carrying its lifecycle state and score, for
// the CRM_UI lead list. Reads go through the data layer (`@/db/crm-read`); no
// SQL/Drizzle lives in the route.

import { NextResponse } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { listLeadSummaries } from "@/db/crm-read";

export async function GET(): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) {
		return denied;
	}

	const leads = await listLeadSummaries();
	return NextResponse.json({ leads });
}
