// CRM_UI settings page — handoff alerts on the consultant's WhatsApp.
//
// Side-effect boundary: client component. Lets the signed-in member set the
// WhatsApp number that receives handoff alerts, confirm it with the 6-digit
// code sent by WhatsApp (only a verified number is ever alerted), toggle the
// per-membership alert opt-in, and send themselves a sample alert.

"use client";

import { useState } from "react";

import { PageHeader, StatusNote } from "../_components/ui";
import {
	useNotificationSettings,
	useSendTestAlert,
	useSetAlertPhone,
	useToggleHandoffAlerts,
	useVerifyAlertPhone,
} from "../_lib/api";
import type { NotificationSettingsView } from "../_lib/types";

/** Small green/amber pill for the phone's verification state. */
function VerificationBadge({ verified }: { verified: boolean }) {
	return verified ? (
		<span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
			Verificado
		</span>
	) : (
		<span className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-secondary">
			Não verificado
		</span>
	);
}

/**
 * The phone block: enter a number → receive the code by WhatsApp → confirm.
 * Renders one of four states — no phone yet (input), code pending (code
 * entry), phone saved but unverified (resend), or verified (change / test).
 */
function PhoneSection({ settings }: { settings: NotificationSettingsView }) {
	const setPhone = useSetAlertPhone();
	const verify = useVerifyAlertPhone();
	const testAlert = useSendTestAlert();

	const [editing, setEditing] = useState(false);
	const [phoneInput, setPhoneInput] = useState("");
	const [codeInput, setCodeInput] = useState("");

	const pending = settings.pendingVerification;
	const busy = setPhone.isPending || verify.isPending;

	function submitPhone(phone: string) {
		setPhone.mutate(phone, {
			onSuccess: () => {
				setEditing(false);
				setPhoneInput("");
				setCodeInput("");
				verify.reset();
			},
		});
	}

	// State 1 — entering a (new) number.
	if (editing || (!settings.phoneE164 && !pending)) {
		return (
			<div className="flex flex-col gap-3">
				<label className="text-sm text-ink/80" htmlFor="alert-phone">
					Seu WhatsApp (DDD + número)
				</label>
				<div className="flex flex-wrap items-center gap-2">
					<input
						id="alert-phone"
						type="tel"
						value={phoneInput}
						onChange={(e) => setPhoneInput(e.target.value)}
						placeholder="(47) 99999-0000"
						className="w-56 rounded-md border border-ink/20 bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
					/>
					<button
						type="button"
						disabled={busy || phoneInput.trim() === ""}
						onClick={() => submitPhone(phoneInput)}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
					>
						{setPhone.isPending ? "Enviando…" : "Enviar código"}
					</button>
					{editing ? (
						<button
							type="button"
							onClick={() => setEditing(false)}
							className="rounded-md border border-ink/20 px-3 py-2 text-sm transition-colors hover:bg-ink/5"
						>
							Cancelar
						</button>
					) : null}
				</div>
				<p className="text-xs text-ink/50">
					Enviaremos um código de confirmação por WhatsApp. Só números
					verificados recebem alertas.
				</p>
				{setPhone.isError ? (
					<StatusNote tone="error">{setPhone.error.message}</StatusNote>
				) : null}
			</div>
		);
	}

	// State 2 — a code is pending: confirm it.
	if (pending) {
		return (
			<div className="flex flex-col gap-3">
				<p className="text-sm text-ink/80">
					Enviamos um código por WhatsApp para{" "}
					<span className="font-mono text-xs">{pending.phoneE164}</span>. Digite
					o código de 6 dígitos:
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<input
						type="text"
						inputMode="numeric"
						maxLength={6}
						value={codeInput}
						onChange={(e) => setCodeInput(e.target.value.replace(/\D+/g, ""))}
						placeholder="000000"
						className="w-32 rounded-md border border-ink/20 bg-surface px-3 py-2 text-center font-mono text-sm tracking-widest outline-none focus:border-primary"
					/>
					<button
						type="button"
						disabled={busy || codeInput.length !== 6}
						onClick={() => verify.mutate(codeInput)}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
					>
						{verify.isPending ? "Confirmando…" : "Confirmar"}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => submitPhone(pending.phoneE164)}
						className="rounded-md border border-ink/20 px-3 py-2 text-sm transition-colors hover:bg-ink/5 disabled:opacity-50"
					>
						Reenviar código
					</button>
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="rounded-md border border-ink/20 px-3 py-2 text-sm transition-colors hover:bg-ink/5"
					>
						Usar outro número
					</button>
				</div>
				{verify.isError ? (
					<StatusNote tone="error">{verify.error.message}</StatusNote>
				) : null}
				{setPhone.isError ? (
					<StatusNote tone="error">{setPhone.error.message}</StatusNote>
				) : null}
			</div>
		);
	}

	// States 3 + 4 — a saved phone, unverified (no pending code) or verified.
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-mono text-sm">{settings.phoneE164}</span>
				<VerificationBadge verified={settings.phoneVerified} />
				{!settings.phoneVerified ? (
					<button
						type="button"
						disabled={busy}
						onClick={() => submitPhone(settings.phoneE164 ?? "")}
						className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
					>
						{setPhone.isPending ? "Enviando…" : "Enviar código"}
					</button>
				) : null}
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="rounded-md border border-ink/20 px-3 py-1.5 text-xs transition-colors hover:bg-ink/5"
				>
					Alterar número
				</button>
				{settings.phoneVerified ? (
					<button
						type="button"
						disabled={testAlert.isPending}
						onClick={() => testAlert.mutate()}
						className="rounded-md border border-primary/30 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/5 disabled:opacity-50"
					>
						{testAlert.isPending ? "Enviando…" : "Enviar alerta de teste"}
					</button>
				) : null}
			</div>
			{testAlert.isSuccess ? (
				<StatusNote>Alerta de teste enviado para o seu WhatsApp.</StatusNote>
			) : null}
			{testAlert.isError ? (
				<StatusNote tone="error">{testAlert.error.message}</StatusNote>
			) : null}
			{setPhone.isError ? (
				<StatusNote tone="error">{setPhone.error.message}</StatusNote>
			) : null}
		</div>
	);
}

/** The per-membership alert opt-in toggle. */
function AlertToggle({ settings }: { settings: NotificationSettingsView }) {
	const toggle = useToggleHandoffAlerts();
	return (
		<div className="flex flex-col gap-2">
			<label className="flex items-center gap-3 text-sm text-ink/80">
				<input
					type="checkbox"
					checked={settings.receivesHandoffAlerts}
					disabled={toggle.isPending}
					onChange={(e) => toggle.mutate(e.target.checked)}
					className="h-4 w-4 accent-primary"
				/>
				Receber alertas de novos leads repassados
			</label>
			{!settings.phoneVerified ? (
				<p className="text-xs text-ink/50">
					Mesmo com os alertas ativados, você só recebe mensagens após
					verificar seu WhatsApp acima.
				</p>
			) : null}
			{toggle.isError ? (
				<StatusNote tone="error">{toggle.error.message}</StatusNote>
			) : null}
		</div>
	);
}

export default function ConfiguracoesPage() {
	const { data: settings, isPending, isError, error } = useNotificationSettings();

	return (
		<div>
			<PageHeader
				title="Configurações"
				description="Quando um lead responde e é repassado, os consultores com número verificado recebem um alerta no próprio WhatsApp."
			/>

			{isPending ? <StatusNote>Carregando configurações…</StatusNote> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{settings ? (
				<div className="flex max-w-2xl flex-col gap-6">
					<section className="rounded-lg border border-ink/10 bg-surface-card p-6 shadow-sm">
						<h2 className="mb-4 text-sm font-semibold text-ink">
							Seu WhatsApp para alertas
						</h2>
						<PhoneSection settings={settings} />
					</section>

					<section className="rounded-lg border border-ink/10 bg-surface-card p-6 shadow-sm">
						<h2 className="mb-4 text-sm font-semibold text-ink">
							Alertas de repasse
						</h2>
						<AlertToggle settings={settings} />
					</section>
				</div>
			) : null}
		</div>
	);
}
