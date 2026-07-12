// CRM_UI settings page — handoff alerts on the consultant's WhatsApp.
//
// Side-effect boundary: client component. Lets the signed-in member set the
// WhatsApp number that receives handoff alerts, confirm it with the 6-digit
// code sent by WhatsApp (only a verified number is ever alerted), toggle the
// per-membership alert opt-in, and send themselves a sample alert.

"use client";

import { REGEXP_ONLY_DIGITS } from "input-otp";
import { MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { PageHeader, StatusNote } from "../_components/ui";
import {
	useNotificationSettings,
	useSendTestAlert,
	useSetAlertPhone,
	useToggleHandoffAlerts,
	useVerifyAlertPhone,
} from "../_lib/api";
import type { NotificationSettingsView } from "../_lib/types";
import { useCrmTheme } from "../theme-provider";

/** Inline error surface for a failed mutation. */
function ErrorNote({ message }: { message: string }) {
	return (
		<Alert variant="destructive">
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}

/** Small green/amber pill for the phone's verification state. */
function VerificationBadge({ verified }: { verified: boolean }) {
	return verified ? (
		<Badge className="border-transparent bg-secondary/10 text-secondary">
			Verificado
		</Badge>
	) : (
		<Badge variant="outline" className="text-muted-foreground">
			Não verificado
		</Badge>
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
				<Label htmlFor="alert-phone">Seu WhatsApp (DDD + número)</Label>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						id="alert-phone"
						type="tel"
						value={phoneInput}
						onChange={(e) => setPhoneInput(e.target.value)}
						placeholder="(47) 99999-0000"
						className="w-56"
					/>
					<Button
						disabled={busy || phoneInput.trim() === ""}
						onClick={() => submitPhone(phoneInput)}
					>
						{setPhone.isPending ? "Enviando…" : "Enviar código"}
					</Button>
					{editing ? (
						<Button variant="outline" onClick={() => setEditing(false)}>
							Cancelar
						</Button>
					) : null}
				</div>
				<p className="text-xs text-muted-foreground">
					Enviaremos um código de confirmação por WhatsApp. Só números
					verificados recebem alertas.
				</p>
				{setPhone.isError ? <ErrorNote message={setPhone.error.message} /> : null}
			</div>
		);
	}

	// State 2 — a code is pending: confirm it.
	if (pending) {
		return (
			<div className="flex flex-col gap-3">
				<p className="text-sm text-foreground/80">
					Enviamos um código por WhatsApp para{" "}
					<span className="font-mono text-xs">{pending.phoneE164}</span>. Digite
					o código de 6 dígitos:
				</p>
				<div className="flex flex-wrap items-center gap-3">
					<InputOTP
						maxLength={6}
						pattern={REGEXP_ONLY_DIGITS}
						value={codeInput}
						onChange={setCodeInput}
					>
						<InputOTPGroup>
							<InputOTPSlot index={0} />
							<InputOTPSlot index={1} />
							<InputOTPSlot index={2} />
							<InputOTPSlot index={3} />
							<InputOTPSlot index={4} />
							<InputOTPSlot index={5} />
						</InputOTPGroup>
					</InputOTP>
					<Button
						disabled={busy || codeInput.length !== 6}
						onClick={() => verify.mutate(codeInput)}
					>
						{verify.isPending ? "Confirmando…" : "Confirmar"}
					</Button>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => submitPhone(pending.phoneE164)}
					>
						Reenviar código
					</Button>
					<Button variant="ghost" onClick={() => setEditing(true)}>
						Usar outro número
					</Button>
				</div>
				{verify.isError ? <ErrorNote message={verify.error.message} /> : null}
				{setPhone.isError ? <ErrorNote message={setPhone.error.message} /> : null}
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
					<Button
						size="sm"
						disabled={busy}
						onClick={() => submitPhone(settings.phoneE164 ?? "")}
					>
						{setPhone.isPending ? "Enviando…" : "Enviar código"}
					</Button>
				) : null}
				<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
					Alterar número
				</Button>
				{settings.phoneVerified ? (
					<Button
						variant="outline"
						size="sm"
						disabled={testAlert.isPending}
						onClick={() => testAlert.mutate()}
						className="border-secondary/30 text-secondary hover:bg-secondary/5 hover:text-secondary"
					>
						{testAlert.isPending ? "Enviando…" : "Enviar alerta de teste"}
					</Button>
				) : null}
			</div>
			{testAlert.isSuccess ? (
				<StatusNote>Alerta de teste enviado para o seu WhatsApp.</StatusNote>
			) : null}
			{testAlert.isError ? <ErrorNote message={testAlert.error.message} /> : null}
			{setPhone.isError ? <ErrorNote message={setPhone.error.message} /> : null}
		</div>
	);
}

/** The per-membership alert opt-in toggle. */
function AlertToggle({ settings }: { settings: NotificationSettingsView }) {
	const toggle = useToggleHandoffAlerts();
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-3">
				<Switch
					id="handoff-alerts"
					checked={settings.receivesHandoffAlerts}
					disabled={toggle.isPending}
					onCheckedChange={(checked) => toggle.mutate(checked)}
				/>
				<Label htmlFor="handoff-alerts" className="font-normal">
					Receber alertas de novos leads repassados
				</Label>
			</div>
			{!settings.phoneVerified ? (
				<p className="text-xs text-muted-foreground">
					Mesmo com os alertas ativados, você só recebe mensagens após
					verificar seu WhatsApp acima.
				</p>
			) : null}
			{toggle.isError ? <ErrorNote message={toggle.error.message} /> : null}
		</div>
	);
}

/** Local visual preference for the CRM shell. */
function ThemeModeButton() {
	const { isDark, toggleTheme } = useCrmTheme();
	const Icon = isDark ? SunIcon : MoonIcon;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p className="text-sm font-medium">Modo escuro</p>
					<p className="text-xs text-muted-foreground">
						Aplica o tema apenas ao CRM neste navegador.
					</p>
				</div>
				<Button variant="outline" onClick={toggleTheme}>
					<Icon aria-hidden="true" />
					{isDark ? "Usar modo claro" : "Usar modo escuro"}
				</Button>
			</div>
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
					<Card>
						<CardHeader>
							<CardTitle>Seu WhatsApp para alertas</CardTitle>
						</CardHeader>
						<CardContent>
							<PhoneSection settings={settings} />
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Alertas de repasse</CardTitle>
						</CardHeader>
						<CardContent>
							<AlertToggle settings={settings} />
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Aparência</CardTitle>
						</CardHeader>
						<CardContent>
							<ThemeModeButton />
						</CardContent>
					</Card>
				</div>
			) : null}
		</div>
	);
}
