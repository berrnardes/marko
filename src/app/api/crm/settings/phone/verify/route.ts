// Internal CRM API — confirm the caller's alert phone with the sent code (POST).
//
// Checks the submitted 6-digit code against the pending verification and, on a
// match, stamps `user.phone_verified_at` — from then on the member receives
// handoff alerts (subject to their opt-in flag). Guarded by session; the typed
// service failures map to distinct HTTP statuses so the UI can explain each.

import { NextResponse, type NextRequest } from "next/server";

import { requireMemberSession } from "@/app/api/crm/settings/_lib/session";
import { settingsWiring } from "@/app/api/crm/settings/_lib/wiring";

export async function POST(request: NextRequest): Promise<NextResponse> {
	const auth = await requireMemberSession();
	if ("denied" in auth) return auth.denied;

	const body = (await request.json()) as { code?: string };
	if (typeof body.code !== "string" || body.code.trim() === "") {
		return NextResponse.json(
			{ error: "code (string) is required" },
			{ status: 400 },
		);
	}

	const { verification } = settingsWiring();
	const result = await verification.confirm(auth.member.userId, body.code);
	if (!result.ok) {
		switch (result.reason) {
			case "invalid_code":
				return NextResponse.json(
					{
						error: `Código incorreto. ${result.attemptsLeft} tentativa(s) restante(s).`,
						attemptsLeft: result.attemptsLeft,
					},
					{ status: 400 },
				);
			case "no_pending":
				return NextResponse.json(
					{ error: "Nenhuma verificação pendente. Envie o código novamente." },
					{ status: 409 },
				);
			case "expired":
				return NextResponse.json(
					{ error: "Código expirado. Envie um novo código." },
					{ status: 410 },
				);
			case "too_many_attempts":
				return NextResponse.json(
					{ error: "Muitas tentativas. Envie um novo código." },
					{ status: 429 },
				);
			case "phone_changed":
				return NextResponse.json(
					{
						error:
							"O número foi alterado desde o envio do código. Envie um novo código.",
					},
					{ status: 409 },
				);
		}
	}

	return NextResponse.json({ ok: true, phoneE164: result.phoneE164 });
}
