// Internal CRM API — single WhatsApp number (PATCH block toggle + DELETE).
//
// Guarded by session. Supports toggling the block flag and deleting a number.

import { NextResponse, type NextRequest } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { DrizzleNumberRepository } from "@/db/number-repository";

type Params = { params: Promise<{ numberId: string }> };

export async function PATCH(
	request: NextRequest,
	{ params }: Params,
): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) return denied;

	const { numberId } = await params;
	const body = (await request.json()) as { blocked?: boolean };

	if (typeof body.blocked !== "boolean") {
		return NextResponse.json(
			{ error: "blocked (boolean) is required" },
			{ status: 400 },
		);
	}

	const repo = new DrizzleNumberRepository();
	await repo.setBlocked(numberId, body.blocked);
	return NextResponse.json({ ok: true });
}

export async function DELETE(
	_request: NextRequest,
	{ params }: Params,
): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) return denied;

	const { numberId } = await params;
	const repo = new DrizzleNumberRepository();
	await repo.delete(numberId);
	return NextResponse.json({ ok: true });
}
