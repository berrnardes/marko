// CRM_UI WhatsApp numbers management page.
//
// Side-effect boundary: client component. Lists registered WhatsApp numbers with
// their anti-ban state (blocked, daily count, warm-up start), and connects new
// numbers end-to-end via a WAHA session: create session → scan QR → auto-register
// the authenticated line (no manual session-name/number entry).

"use client";

import { useEffect, useRef, useState } from "react";

import { PageHeader, StatusNote } from "../_components/ui";
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
		<div className="mb-6 rounded-lg border border-primary/20 bg-surface-card p-6 shadow-sm">
			<div className="mb-4 flex items-center justify-between">
				<h2 className="text-sm font-semibold text-ink">Conectar novo número</h2>
				<button
					type="button"
					onClick={handleCancel}
					className="rounded-md border border-ink/20 px-2.5 py-1 text-xs transition-colors hover:bg-ink/5"
				>
					Cancelar
				</button>
			</div>

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
							className="h-56 w-56 rounded-md border border-ink/10 bg-white p-2"
						/>
					) : (
						<StatusNote>Gerando QR code…</StatusNote>
					)}
					<p className="max-w-xs text-center text-xs text-ink/60">
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

			{phase === "error" ? (
				<StatusNote tone="error">{error}</StatusNote>
			) : null}
		</div>
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
				<button
					type="button"
					onClick={() => setConnecting(true)}
					className="mb-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
				>
					Conectar novo número
				</button>
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
				<div className="overflow-x-auto rounded-lg border border-ink/10 shadow-sm">
					<table className="w-full text-left text-sm">
						<thead className="border-b border-ink/10 bg-surface-card text-xs font-medium text-ink/60">
							<tr>
								<th className="px-4 py-3">Sessão</th>
								<th className="px-4 py-3">Número</th>
								<th className="px-4 py-3">Status</th>
								<th className="px-4 py-3">Enviados hoje</th>
								<th className="px-4 py-3">Warm-up desde</th>
								<th className="px-4 py-3">Ações</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-ink/5">
							{numbers.map((num) => (
								<tr key={num.id} className="bg-surface">
									<td className="px-4 py-3 font-medium">{num.sessionName}</td>
									<td className="px-4 py-3 font-mono text-xs">{num.msisdn}</td>
									<td className="px-4 py-3">
										{num.blocked ? (
											<span className="inline-flex items-center rounded-full bg-secondary/15 px-2 py-0.5 text-xs font-medium text-secondary">
												Bloqueado
											</span>
										) : (
											<span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
												Ativo
											</span>
										)}
									</td>
									<td className="px-4 py-3 tabular-nums">{num.dailySent}</td>
									<td className="px-4 py-3 text-ink/60">
										{new Date(num.warmupStartDate).toLocaleDateString("pt-BR")}
									</td>
									<td className="flex items-center gap-2 px-4 py-3">
										<button
											type="button"
											onClick={() =>
												toggleBlock.mutate({
													numberId: num.id,
													blocked: !num.blocked,
												})
											}
											className="rounded-md border border-ink/20 px-2.5 py-1 text-xs transition-colors hover:bg-ink/5"
										>
											{num.blocked ? "Desbloquear" : "Bloquear"}
										</button>
										<button
											type="button"
											onClick={() => {
												if (
													confirm(
														`Remover o número ${num.msisdn}? A sessão WhatsApp será desconectada. Esta ação não pode ser desfeita.`,
													)
												) {
													deleteNumber.mutate(num.id);
												}
											}}
											className="rounded-md border border-secondary/30 px-2.5 py-1 text-xs text-secondary transition-colors hover:bg-secondary/10"
										>
											Remover
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
		</div>
	);
}
