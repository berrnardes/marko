// Internal CRM API — confirm a connected WhatsApp session (persist the number).
//
// Guarded by session. Called once the session reaches WORKING: it re-reads the
// session from WAHA, derives the msisdn from the *authenticated* account (never
// from client input, so the CRM cannot drift from the line that actually
// connected), and persists the number row. Made idempotent explicitly (a
// re-confirm of the same session returns the existing row) because
// `whatsapp_numbers` has no unique constraint to collapse a duplicate insert.

import { NextResponse } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { toNumberView } from "@/app/api/crm/numbers/_view";
import { DrizzleNumberRepository } from "@/db/number-repository";
import { msisdnFromMe, wahaAdmin } from "@/services/waha-admin-client";

type Params = { params: Promise<{ sessionName: string }> };

export async function POST(
	_request: Request,
	{ params }: Params,
): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) return denied;

	const { sessionName } = await params;

	let info: Awaited<ReturnType<typeof wahaAdmin.getSession>>;
	try {
		info = await wahaAdmin.getSession(sessionName);
	} catch {
		return NextResponse.json(
			{ error: "Failed to read WhatsApp session" },
			{ status: 502 },
		);
	}

	if (info.status !== "WORKING") {
		return NextResponse.json(
			{ error: `Session not connected (status: ${info.status})` },
			{ status: 409 },
		);
	}

	const msisdn = msisdnFromMe(info.me);
	if (!msisdn) {
		return NextResponse.json(
			{ error: "Connected session did not report a phone number" },
			{ status: 502 },
		);
	}

	const repo = new DrizzleNumberRepository();

	// Idempotency: if this session (or the same line) was already confirmed,
	// return the existing row instead of inserting a duplicate — the table has
	// no unique constraint to rely on.
	const existing = (await repo.listAll()).find(
		(n) => n.sessionName === sessionName || n.msisdn === msisdn,
	);
	if (existing) {
		return NextResponse.json({ number: toNumberView(existing) });
	}

	const record = await repo.insert({ sessionName, msisdn });
	return NextResponse.json({ number: toNumberView(record) }, { status: 201 });
}
