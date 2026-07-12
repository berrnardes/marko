// Internal CRM API — set the caller's alert phone and send its code (POST).
//
// Saves the phone (unverified) and sends the 6-digit confirmation code to it
// by WhatsApp from the org's own sending number. Also used to resend: starting
// again replaces the pending code. Guarded by session; the typed service
// failures map to distinct HTTP statuses so the UI can explain each one.

import { NextResponse, type NextRequest } from "next/server";

import { requireMemberSession } from "@/app/api/crm/settings/_lib/session";
import { settingsWiring } from "@/app/api/crm/settings/_lib/wiring";

export async function POST(request: NextRequest): Promise<NextResponse> {
	const auth = await requireMemberSession();
	if ("denied" in auth) return auth.denied;

	const body = (await request.json()) as { phone?: string };
	if (typeof body.phone !== "string" || body.phone.trim() === "") {
		return NextResponse.json(
			{ error: "phone (string) is required" },
			{ status: 400 },
		);
	}

	const { verification } = settingsWiring();
	const result = await verification.start(auth.member.userId, body.phone);
	if (!result.ok) {
		switch (result.reason) {
			case "invalid_phone":
				return NextResponse.json(
					{ error: "Número de telefone inválido. Use DDD + número." },
					{ status: 400 },
				);
			case "no_sending_number":
				return NextResponse.json(
					{
						error:
							"Nenhum número WhatsApp conectado para enviar o código. " +
							"Conecte um número na página Números primeiro.",
					},
					{ status: 409 },
				);
			case "send_failed":
				return NextResponse.json(
					{ error: "Falha ao enviar o código pelo WhatsApp. Tente novamente." },
					{ status: 502 },
				);
		}
	}

	return NextResponse.json({
		phoneE164: result.phoneE164,
		expiresAt: result.expiresAt,
	});
}
