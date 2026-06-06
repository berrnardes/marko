// Internal CRM API — handed-off leads (Req 13.3, 20.4).
//
// Guarded by the edge proxy and re-validated server-side here. Returns the
// leads handed off to a consultant, each with its collected qualification data,
// full message history, and handoff events, for the CRM_UI handoff view. Reads
// go through the data layer (`@/db/crm-read`).

import { NextResponse } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { listHandedOffLeads } from "@/db/crm-read";

export async function GET(): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) {
		return denied;
	}

	const leads = await listHandedOffLeads();
	return NextResponse.json({ leads });
}
