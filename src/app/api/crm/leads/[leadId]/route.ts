// Internal CRM API — lead detail (Req 20.2).
//
// Guarded by the edge proxy and re-validated server-side here. Returns a single
// lead's qualification fields and full message history, or `404` when no lead
// matches. Reads go through the data layer (`@/db/crm-read`).

import { NextResponse } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { getLeadDetail } from "@/db/crm-read";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ leadId: string }> },
): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) {
		return denied;
	}

	const { leadId } = await params;
	const lead = await getLeadDetail(leadId);
	if (!lead) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	return NextResponse.json({ lead });
}
