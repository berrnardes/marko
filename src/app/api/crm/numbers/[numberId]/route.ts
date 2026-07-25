// Internal CRM API — single WhatsApp number (PATCH block toggle + DELETE).
//
// Guarded by session. Supports toggling the block flag and deleting a number.

import { NextResponse, type NextRequest } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { DrizzleNumberRepository } from "@/db/number-repository";
import { withOrg } from "@/db/with-org";
import { wahaAdmin } from "@/services/waha-admin-client";

type Params = { params: Promise<{ numberId: string }> };

export async function PATCH(
	request: NextRequest,
	{ params }: Params,
): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const { numberId } = await params;
	const body = (await request.json()) as { blocked?: boolean };

	if (typeof body.blocked !== "boolean") {
		return NextResponse.json(
			{ error: "blocked (boolean) is required" },
			{ status: 400 },
		);
	}

	// Bound outside the closure so the `boolean` narrowing above survives into it.
	const blocked = body.blocked;
	const { organizationId } = auth.org;
	await withOrg(organizationId, (tx) =>
		new DrizzleNumberRepository(organizationId, tx).setBlocked(numberId, blocked),
	);
	return NextResponse.json({ ok: true });
}

export async function DELETE(
	_request: NextRequest,
	{ params }: Params,
): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const { numberId } = await params;
	const { organizationId } = auth.org;

	// Three steps, deliberately in three phases rather than one transaction: the
	// WAHA call in the middle is network I/O and must not hold a pooled
	// connection open (each `withOrg` is its own transaction, ADR-004).
	const record = await withOrg(organizationId, (tx) =>
		new DrizzleNumberRepository(organizationId, tx).findById(numberId),
	);

	// Free the underlying WAHA session so a removed number leaves no orphan.
	// Best-effort: the CRM row is deleted even if WAHA is unreachable.
	if (record) {
		await wahaAdmin.logoutAndDelete(record.sessionName);
	}

	await withOrg(organizationId, (tx) =>
		new DrizzleNumberRepository(organizationId, tx).delete(numberId),
	);
	return NextResponse.json({ ok: true });
}
