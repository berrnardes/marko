// CRM_UI WhatsApp numbers management page.
//
// Side-effect boundary: client component. Lists registered WhatsApp numbers with
// their anti-ban state (blocked, daily count, warm-up start), and connects new
// numbers end-to-end via a WAHA session: create session → scan QR → auto-register
// the authenticated line (no manual session-name/number entry).

"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

import { ConfirmButton, PageHeader, StatusNote } from "../_components/ui";
import {
	useCancelSession,
	useConfirmSession,
	useCreateSession,
	useDeleteNumber,
	useNumbers,
	useSessionStatus,
	useToggleNumberBlock,
} from "../_lib/api";

/**
 * Guided connect flow: starts a WAHA session, shows its rotating QR, and on
 * successful scan auto-registers the number (msisdn read server-side from the
 * connected line). Calls `onDone` when the number is registered.
 */
function ConnectPanel({ onClose }: { onClose: () => void }) {
	const createSession = useCreateSession();
	const confirmSession = useConfirmSession();
	const cancelSession = useCancelSession();

	const [sessionName, setSessionName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const startedRef = useRef(false);
	const confirmedRef = useRef(false);

	const { data: status } = useSessionStatus(sessionName);

	// Start a session exactly once when the panel opens.
	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		createSession.mutate(undefined, {
			onSuccess: (data) => setSessionName(data.sessionName),
			onError: (err) => setError(err.message),
		});
	}, [createSession]);

	// Once the session is WORKING, confirm (register the number) exactly once.
	useEffect(() => {
		if (status?.status !== "WORKING" || !sessionName) return;
		if (confirmedRef.current) return;
		confirmedRef.current = true;
		confirmSession.mutate(sessionName, {
			onSuccess: () => onClose(),
			onError: (err) => setError(err.message),
		});
	}, [status?.status, sessionName, confirmSession, onClose]);

	function handleCancel() {
		// Best-effort teardown of the pending, unconfirmed session.
		if (sessionName && !confirmedRef.current) {
			cancelSession.mutate(sessionName);
		}
		onClose();
	}

	const phase = error
		? "error"
		: !sessionName || status?.status === "STARTING"
			? "starting"
			: status?.status === "SCAN_QR_CODE"
				? "scan"
				: status?.status === "WORKING"
					? "confirming"
					: status?.status === "FAILED"
						? "failed"
						: "starting";

	return (
		<Card className="mb-6">
			<CardHeader>
				<CardTitle>Conectar novo número</CardTitle>
				<CardAction>
					<Button variant="outline" size="sm" onClick={handleCancel}>
						Cancelar
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent>
				{phase === "starting" ? (
					<StatusNote>Iniciando sessão WhatsApp…</StatusNote>
				) : null}

				{phase === "scan" ? (
					<div className="flex flex-col items-center gap-3">
						{status?.qr ? (
							// eslint-disable-next-line @next/next/no-img-element
							<img
								src={status.qr}
								alt="QR code para conectar o WhatsApp"
								className="h-56 w-56 rounded-md border border-border bg-white p-2"
							/>
						) : (
							<StatusNote>Gerando QR code…</StatusNote>
						)}
						<p className="max-w-xs text-center text-xs text-muted-foreground">
							Abra o WhatsApp no celular do número, toque em{" "}
							<strong>Aparelhos conectados</strong> e aponte a câmera para o QR
							code. Ele é atualizado automaticamente.
						</p>
					</div>
				) : null}

				{phase === "confirming" ? (
					<StatusNote>Conectado! Registrando o número…</StatusNote>
				) : null}

				{phase === "failed" ? (
					<StatusNote tone="error">
						A sessão falhou. Feche e tente conectar novamente.
					</StatusNote>
				) : null}

				{phase === "error" ? <StatusNote tone="error">{error}</StatusNote> : null}
			</CardContent>
		</Card>
	);
}

export default function NumbersPage() {
	const { data: numbers, isPending, isError, error } = useNumbers();
	const toggleBlock = useToggleNumberBlock();
	const deleteNumber = useDeleteNumber();

	const [connecting, setConnecting] = useState(false);

	return (
		<div>
			<PageHeader
				title="Números WhatsApp"
				description="Gerencie os números usados para envio de mensagens. Conecte um novo número escaneando o QR code — a sessão e o número são registrados automaticamente."
			/>

			{connecting ? (
				<ConnectPanel onClose={() => setConnecting(false)} />
			) : (
				<Button className="mb-6" onClick={() => setConnecting(true)}>
					Conectar novo número
				</Button>
			)}

			{/* State */}
			{isPending ? <StatusNote>Carregando números…</StatusNote> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{numbers && numbers.length === 0 ? (
				<StatusNote>
					Nenhum número cadastrado. Conecte um acima para começar a enviar.
				</StatusNote>
			) : null}

			{/* Number list */}
			{numbers && numbers.length > 0 ? (
				<div className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Sessão</TableHead>
								<TableHead>Número</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Enviados hoje</TableHead>
								<TableHead>Warm-up desde</TableHead>
								<TableHead>Ações</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{numbers.map((num) => (
								<TableRow key={num.id}>
									<TableCell className="font-medium">
										{num.sessionName}
									</TableCell>
									<TableCell className="font-mono text-xs">
										{num.msisdn}
									</TableCell>
									<TableCell>
										{num.blocked ? (
											<Badge variant="destructive">Bloqueado</Badge>
										) : (
											<Badge className="border-transparent bg-secondary/10 text-secondary">
												Ativo
											</Badge>
										)}
									</TableCell>
									<TableCell className="tabular-nums">{num.dailySent}</TableCell>
									<TableCell className="text-muted-foreground">
										{new Date(num.warmupStartDate).toLocaleDateString("pt-BR")}
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-2">
											<Button
												variant="outline"
												size="sm"
												onClick={() =>
													toggleBlock.mutate({
														numberId: num.id,
														blocked: !num.blocked,
													})
												}
											>
												{num.blocked ? "Desbloquear" : "Bloquear"}
											</Button>
											<ConfirmButton
												title="Remover número"
												description={`Remover o número ${num.msisdn}? A sessão WhatsApp será desconectada. Esta ação não pode ser desfeita.`}
												confirmLabel="Remover"
												onConfirm={() => deleteNumber.mutate(num.id)}
											>
												Remover
											</ConfirmButton>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			) : null}
		</div>
	);
}
