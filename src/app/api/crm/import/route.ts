// Internal CRM API — CSV import (Req 1, 20.3).
//
// Guarded by the edge proxy and re-validated server-side here. Accepts a
// multipart upload carrying a CSV `file`, runs it through the reused
// `Lead_Importer` (composed in `@/services/crm-importer`), and returns the
// import result report (created / updated / rejected with per-row reasons) for
// the CRM_UI to display (Req 1.6, 20.3).

import { NextResponse } from "next/server";

import { denyIfUnauthenticated } from "@/app/api/crm/_lib/guard";
import { createCrmImporter } from "@/services/crm-importer";

/** Form field name carrying the uploaded CSV file. */
const FILE_FIELD = "file";
/** Form field name carrying the originating source label (optional). */
const SOURCE_FIELD = "source";
/** Default source recorded on leads created via the CRM_UI upload (Req 2.1). */
const DEFAULT_SOURCE = "csv";

export async function POST(request: Request): Promise<NextResponse> {
	const denied = await denyIfUnauthenticated();
	if (denied) {
		return denied;
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

	const csv = Buffer.from(await file.arrayBuffer());
	const report = await createCrmImporter().import(csv, source);

	return NextResponse.json({ report });
}
