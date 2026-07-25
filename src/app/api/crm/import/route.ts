// Internal CRM API — CSV import (Req 1, 20.3).
//
// Guarded by the edge proxy and re-validated server-side here. Accepts a
// multipart upload carrying a CSV `file`, runs it through the shared runtime's
// `Lead_Importer` — the same enrollment path every future real-time source
// uses (Req 2.2, 2.3, 3.1) — and returns the import result report (created /
// updated / rejected with per-row reasons) for the CRM_UI to display
// (Req 1.6, 20.3).

import { NextResponse } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import { withOrg } from "@/db/with-org";
import { getRuntime } from "@/services/runtime";

/** Form field name carrying the uploaded CSV file. */
const FILE_FIELD = "file";
/** Form field name carrying the originating source label (optional). */
const SOURCE_FIELD = "source";
/** Default source recorded on leads created via the CRM_UI upload (Req 2.1). */
const DEFAULT_SOURCE = "csv";

export async function POST(request: Request): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) {
		return auth.denied;
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json(
			{ error: "expected a multipart/form-data upload" },
			{ status: 400 },
		);
	}

	const file = form.get(FILE_FIELD);
	if (!(file instanceof File)) {
		return NextResponse.json(
			{ error: `missing CSV file in form field "${FILE_FIELD}"` },
			{ status: 400 },
		);
	}

	const sourceValue = form.get(SOURCE_FIELD);
	const source =
		typeof sourceValue === "string" && sourceValue.trim().length > 0
			? sourceValue.trim()
			: DEFAULT_SOURCE;

	// Imported leads (and the cadence enrollment each one triggers) belong to the
	// caller's organization, taken from the session — never from the upload.
	const csv = Buffer.from(await file.arrayBuffer());
	const runtime = await getRuntime();
	const { organizationId } = auth.org;
	// The whole import runs in one transaction so the RLS context covers every
	// row it writes. That also makes the import atomic on the database side —
	// though not end to end: enrollment enqueues pg-boss jobs over a separate
	// pool, so jobs for a rolled-back import would survive (they would then find
	// no lead and drop). Acceptable at the CRM's scale of ~1,000 rows; revisit if
	// imports grow large enough to hold a pooled connection for long.
	const report = await withOrg(organizationId, (tx) =>
		runtime.forOrg(organizationId, tx).importer.import(csv, source),
	);

	return NextResponse.json({ report });
}
