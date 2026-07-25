// Internal CRM API — lead list (Req 20.1).
//
// Guarded by the edge proxy (session cookie) and re-validated server-side here.
// Returns every lead as a summary carrying its lifecycle state and score, for
// the CRM_UI lead list. Reads go through the data layer (`@/db/crm-read`); no
// SQL/Drizzle lives in the route.

import { NextResponse } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { listLeadSummaries } from "@/db/crm-read";
import { withOrg } from "@/db/with-org";

export async function GET(): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) {
		return auth.denied;
	}

	const { organizationId } = auth.org;
	const leads = await withOrg(organizationId, (tx) =>
		listLeadSummaries(organizationId, tx),
	);
	return NextResponse.json({ leads });
}
