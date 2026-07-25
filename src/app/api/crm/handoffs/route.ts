// Internal CRM API — handed-off leads (Req 13.3, 20.4).
//
// Guarded by the edge proxy and re-validated server-side here. Returns the
// leads handed off to a consultant, each with its collected qualification data,
// full message history, and handoff events, for the CRM_UI handoff view. Reads
// go through the data layer (`@/db/crm-read`).

import { NextResponse } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { listHandedOffLeads } from "@/db/crm-read";
import { withOrg } from "@/db/with-org";

export async function GET(): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) {
		return auth.denied;
	}

	const { organizationId } = auth.org;
	const leads = await withOrg(organizationId, (tx) =>
		listHandedOffLeads(organizationId, tx),
	);
	return NextResponse.json({ leads });
}
