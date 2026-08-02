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

import {
	ConfirmButton,
	PageHeader,
	StatusNote,
	TableSkeleton,
} from "../_components/ui";
import {
	deleteSession,
	useConfirmSession,
	useCreateSession,
	useDeleteNumber,
	useNumbers,
	useSessionStatus,
	useToggleNumberBlock,
} from "../_lib/api";

/**
 * How long the session may stay in STARTING before the panel declares it stuck.
 * With the browserless GOWS engine (`WHATSAPP_DEFAULT_ENGINE` in the compose
 * files) the QR shows up in a couple of seconds; taking 30s means something is
 * actually wrong — WAHA out of resources, or a session that fell back to the
 * Chromium-based WEBJS engine, which routinely takes minutes.
 */
const START_TIMEOUT_MS = 30_000;

/** What the connect panel is showing. Every WAHA state maps to exactly one. */
type ConnectPhase =
	| "starting"
	| "scan"
	| "confirming"
	| "failed"
	| "timeout"
	| "error";

/** A dead end the operator can back out of, with the way out attached. */
function FailureNote({
	children,
	onRetry,
}: {
	children: React.ReactNode;
	onRetry: () => void;
}) {
	return (
		<div className="flex flex-col items-center gap-3">
			<StatusNote tone="error">{children}</StatusNote>
			<Button variant="outline" size="sm" onClick={onRetry}>
				Tentar novamente
			</Button>
		</div>
	);
}

/**
 * Guided connect flow: starts a WAHA session, shows its rotating QR, and on
 * successful scan auto-registers the number (msisdn read server-side from the
 * connected line). Calls `onClose` when the number is registered.
 *
 * Every failure mode is distinguishable on screen — a stuck start, a dead
 * gateway and a session that WAHA gave up on used to render the same frozen
 * "Iniciando sessão…", which is indistinguishable from progress.
 *
 * The panel remounts on retry (see the `key` in {@link ConnectPanel}), so all
 * of its state is rebuilt from scratch and the abandoned session is torn down
 * by the mount effect's cleanup.
 */
function ConnectSession({
	onClose,
	onRetry,
}: {
	onClose: () => void;
	onRetry: () => void;
}) {
	// `mutateAsync` is a stable reference in React Query, so it is a safe effect
	// dependency — unlike the mutation object, which is new on every render.
	const { mutateAsync: createSession } = useCreateSession();
	const { mutateAsync: confirmSession } = useConfirmSession();

	const [sessionName, setSessionName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [elapsedMs, setElapsedMs] = useState(0);
	const startedAtRef = useRef<number | null>(null);
	const confirmedRef = useRef(false);

	const { data: status, error: pollError } = useSessionStatus(sessionName);

	// Start a session when the panel opens, and tear it down again if the panel
	// goes away before the number is confirmed. Without that cleanup, closing the
	// panel by navigating away leaks the session inside WAHA forever — and on the
	// browser engines each leaked session also pins a whole Chromium.
	useEffect(() => {
		let dropped = false;
		let created: string | null = null;

		void (async () => {
			try {
				const data = await createSession();
				created = data.sessionName;
				if (dropped) {
					// The panel closed while the create was still in flight.
					void deleteSession(created);
					return;
				}
				setSessionName(created);
			} catch (err) {
				if (!dropped) setError((err as Error).message);
			}
		})();

		return () => {
			dropped = true;
			// A confirmed session belongs to a registered number now: deleting it
			// would log the operator's WhatsApp back out.
			if (created && !confirmedRef.current) void deleteSession(created);
		};
	}, [createSession]);

	// Once the session is WORKING, confirm (register the number) exactly once.
	useEffect(() => {
		if (status?.status !== "WORKING" || !sessionName) return;
		if (confirmedRef.current) return;
		confirmedRef.current = true;
		void (async () => {
			try {
				await confirmSession(sessionName);
				onClose();
			} catch (err) {
				// `confirmedRef` stays set on purpose: the line is authenticated, so
				// the session must survive for a retry of the registration alone.
				setError((err as Error).message);
			}
		})();
	}, [status?.status, sessionName, confirmSession, onClose]);

	// Tick a visible elapsed counter while there is nothing else to show, so the
	// wait reads as progress rather than as a frozen screen.
	const awaitingQr = !status || status.status === "STARTING";
	useEffect(() => {
		if (!awaitingQr) return;
		// Read the clock here, not during render: the wait starts when the panel
		// mounts, and `awaitingQr` is true from the first render.
		const startedAt = startedAtRef.current ?? Date.now();
		startedAtRef.current = startedAt;
		const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
		return () => clearInterval(id);
	}, [awaitingQr]);

	const phase = ((): ConnectPhase => {
		// A create/confirm failure is sticky; a poll failure clears itself as soon
		// as one poll succeeds again (the interval keeps running through errors).
		if (error || pollError) return "error";
		switch (status?.status) {
			case "WORKING":
				return "confirming";
			case "SCAN_QR_CODE":
				return "scan";
			case "FAILED":
			case "STOPPED":
				return "failed";
			default:
				return elapsedMs >= START_TIMEOUT_MS ? "timeout" : "starting";
		}
	})();

	return (
		<Card className="mb-6">
			<CardHeader>
				<CardTitle>Conectar novo número</CardTitle>
				<CardAction>
					<Button variant="outline" size="sm" onClick={onClose}>
						Cancelar
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent>
				{phase === "starting" ? (
					<StatusNote>
						Iniciando sessão WhatsApp…
						{elapsedMs >= 3000 ? ` (${Math.floor(elapsedMs / 1000)}s)` : ""}
					</StatusNote>
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
					<FailureNote onRetry={onRetry}>
						A sessão foi encerrada pelo WhatsApp antes da conexão.
					</FailureNote>
				) : null}

				{phase === "timeout" ? (
					<FailureNote onRetry={onRetry}>
						A sessão não gerou o QR code em{" "}
						{Math.round(START_TIMEOUT_MS / 1000)}s. Verifique se o serviço
						WhatsApp (WAHA) está no ar.
					</FailureNote>
				) : null}

				{phase === "error" ? (
					<FailureNote onRetry={onRetry}>
						{error ?? pollError?.message}
					</FailureNote>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * Hosts the connect flow and owns its retry: bumping `attempt` remounts
 * {@link ConnectSession}, which discards the failed session and starts a new one.
 */
function ConnectPanel({ onClose }: { onClose: () => void }) {
	const [attempt, setAttempt] = useState(0);
	return (
		<ConnectSession
			key={attempt}
			onClose={onClose}
			onRetry={() => setAttempt((n) => n + 1)}
		/>
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
				action={
					connecting ? null : (
						<Button onClick={() => setConnecting(true)}>
							Conectar novo número
						</Button>
					)
				}
			/>

			{connecting ? (
				<ConnectPanel onClose={() => setConnecting(false)} />
			) : null}

			{/* State */}
			{isPending ? <TableSkeleton columns={6} /> : null}
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
											<Badge className="border-transparent bg-primary/10 text-primary">
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
