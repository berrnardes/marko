// Internal CRM API — WhatsApp numbers management (list + create).
//
// Guarded by session. Returns all registered numbers for the CRM management
// view, and accepts POST to insert a new number for the outbound choke point.

import { NextResponse, type NextRequest } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { toNumberView } from "@/app/api/crm/numbers/_view";
import type { NumberView } from "@/app/crm/_lib/types";
import { DrizzleNumberRepository } from "@/db/number-repository";

export async function GET(): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) return denied;

	const repo = new DrizzleNumberRepository();
	const records = await repo.listAll();
	const numbers: NumberView[] = records.map(toNumberView);
	return NextResponse.json({ numbers });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) return denied;

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

	const repo = new DrizzleNumberRepository();
	const record = await repo.insert({
		sessionName: body.sessionName,
		msisdn: body.msisdn,
	});
	return NextResponse.json({ number: toNumberView(record) }, { status: 201 });
}
