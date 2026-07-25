// Internal CRM API — cadence/nurture message templates (read + edit + reset).
//
// Guarded by session. Returns the six editable templates (T1–T5 + nurture) with
// their current body (stored custom body, or the built-in default), accepts PUT
// to customize one, and DELETE to restore a template to its default.

import { NextResponse, type NextRequest } from "next/server";

import { requireOrgSession } from "@/app/api/crm/_lib/guard";
import type {
	TemplatesResponse,
	TemplateView,
} from "@/app/crm/_lib/types";
import {
	DEFAULT_TEMPLATES,
	TEMPLATE_KEYS,
	TEMPLATE_META,
	TEMPLATE_PLACEHOLDERS,
} from "@/core/messages";
import type { TemplateKey } from "@/core/types";
import { DrizzleMessageTemplateRepository } from "@/db/message-template-repository";
import { withOrg } from "@/db/with-org";

/** Narrow an arbitrary string to a known {@link TemplateKey}. */
function isTemplateKey(value: unknown): value is TemplateKey {
	return (
		typeof value === "string" &&
		(TEMPLATE_KEYS as readonly string[]).includes(value)
	);
}

export async function GET(): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const { organizationId } = auth.org;
	const stored = await withOrg(organizationId, (tx) =>
		new DrizzleMessageTemplateRepository(organizationId, tx).getAll(),
	);

	const templates: TemplateView[] = TEMPLATE_KEYS.map((key) => ({
		key,
		label: TEMPLATE_META[key].label,
		description: TEMPLATE_META[key].description,
		body: stored[key] ?? DEFAULT_TEMPLATES[key],
		default: DEFAULT_TEMPLATES[key],
		isCustomized: stored[key] !== undefined,
	}));

	const payload: TemplatesResponse = {
		templates,
		placeholders: TEMPLATE_PLACEHOLDERS.map((p) => ({ ...p })),
	};
	return NextResponse.json(payload);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const body = (await request.json()) as { key?: unknown; body?: unknown };

	if (!isTemplateKey(body.key)) {
		return NextResponse.json(
			{ error: "Invalid or missing template key" },
			{ status: 400 },
		);
	}
	if (typeof body.body !== "string" || body.body.trim().length === 0) {
		return NextResponse.json(
			{ error: "Template body must not be empty" },
			{ status: 400 },
		);
	}

	const { organizationId } = auth.org;
	const { key, body: newBody } = { key: body.key, body: body.body };
	await withOrg(organizationId, (tx) =>
		new DrizzleMessageTemplateRepository(organizationId, tx).upsert(
			key,
			newBody,
		),
	);

	const view: TemplateView = {
		key: body.key,
		label: TEMPLATE_META[body.key].label,
		description: TEMPLATE_META[body.key].description,
		body: body.body,
		default: DEFAULT_TEMPLATES[body.key],
		isCustomized: true,
	};
	return NextResponse.json({ template: view });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
	const auth = await requireOrgSession();
	if ("denied" in auth) return auth.denied;

	const key = request.nextUrl.searchParams.get("key");
	if (!isTemplateKey(key)) {
		return NextResponse.json(
			{ error: "Invalid or missing template key" },
			{ status: 400 },
		);
	}

	const { organizationId } = auth.org;
	await withOrg(organizationId, (tx) =>
		new DrizzleMessageTemplateRepository(organizationId, tx).reset(key),
	);

	const view: TemplateView = {
		key,
		label: TEMPLATE_META[key].label,
		description: TEMPLATE_META[key].description,
		body: DEFAULT_TEMPLATES[key],
		default: DEFAULT_TEMPLATES[key],
		isCustomized: false,
	};
	return NextResponse.json({ template: view });
}
