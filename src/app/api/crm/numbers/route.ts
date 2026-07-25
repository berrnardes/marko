// Internal CRM API — WhatsApp numbers management (list + create).
//
// Guarded by session. Returns all registered numbers for the CRM management
// view, and accepts POST to insert a new number for the outbound choke point.

import { NextResponse, type NextRequest } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { toNumberView } from "@/app/api/crm/numbers/_view";
import type { NumberView } from "@/app/crm/_lib/types";
import { DrizzleNumberRepository } from "@/db/number-repository";
import { withOrg } from "@/db/with-org";

export async function GET(): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const { organizationId } = auth.org;
	const records = await withOrg(organizationId, (tx) =>
		new DrizzleNumberRepository(organizationId, tx).listAll(),
	);
	const numbers: NumberView[] = records.map(toNumberView);
	return NextResponse.json({ numbers });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const body = (await request.json()) as {
		sessionName?: string;
		msisdn?: string;
	};

	if (!body.sessionName || !body.msisdn) {
		return NextResponse.json(
			{ error: "sessionName and msisdn are required" },
			{ status: 400 },
		);
	}

	// Bound outside the closure so the non-empty narrowing above survives into it.
	const { sessionName, msisdn } = body;
	const { organizationId } = auth.org;
	const record = await withOrg(organizationId, (tx) =>
		new DrizzleNumberRepository(organizationId, tx).insert({
			sessionName,
			msisdn,
		}),
	);
	return NextResponse.json({ number: toNumberView(record) }, { status: 201 });
}
