// CRM_UI WhatsApp numbers management page.
//
// Side-effect boundary: client component. Lists registered WhatsApp numbers
// with their anti-ban state (blocked, daily count, warm-up start), and provides
// actions to add a new number, toggle block, and delete.

"use client";

import { useState } from "react";

import { PageHeader, StatusNote } from "../_components/ui";
import {
	useCreateNumber,
	useDeleteNumber,
	useNumbers,
	useToggleNumberBlock,
} from "../_lib/api";

export default function NumbersPage() {
	const { data: numbers, isPending, isError, error } = useNumbers();
	const createNumber = useCreateNumber();
	const toggleBlock = useToggleNumberBlock();
	const deleteNumber = useDeleteNumber();

	const [sessionName, setSessionName] = useState("");
	const [msisdn, setMsisdn] = useState("");
	const [formError, setFormError] = useState<string | null>(null);

	function handleAdd(e: React.FormEvent) {
		e.preventDefault();
		setFormError(null);
		if (!sessionName.trim() || !msisdn.trim()) {
			setFormError("Preencha todos os campos.");
			return;
		}
		createNumber.mutate(
			{ sessionName: sessionName.trim(), msisdn: msisdn.trim() },
			{
				onSuccess: () => {
					setSessionName("");
					setMsisdn("");
				},
				onError: (err) => setFormError(err.message),
			},
		);
	}

	return (
		<div>
			<PageHeader
				title="Números WhatsApp"
				description="Gerencie os números usados para envio de mensagens. Cada número precisa de uma sessão WAHA ativa."
			/>

			{/* Add number form */}
			<form
				onSubmit={handleAdd}
				className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-ink/10 bg-surface-card p-4 shadow-sm"
			>
				<div className="flex flex-col gap-1">
					<label
						htmlFor="sessionName"
						className="text-xs font-medium text-ink/70"
					>
						Nome da sessão WAHA
					</label>
					<input
						id="sessionName"
						type="text"
						placeholder="default"
						value={sessionName}
						onChange={(e) => setSessionName(e.target.value)}
						className="rounded-md border border-ink/20 bg-surface px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
					/>
				</div>
				<div className="flex flex-col gap-1">
					<label htmlFor="msisdn" className="text-xs font-medium text-ink/70">
						Número (E.164)
					</label>
					<input
						id="msisdn"
						type="text"
						placeholder="+5511999999999"
						value={msisdn}
						onChange={(e) => setMsisdn(e.target.value)}
						className="rounded-md border border-ink/20 bg-surface px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
					/>
				</div>
				<button
					type="submit"
					disabled={createNumber.isPending}
					className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
				>
					{createNumber.isPending ? "Adicionando…" : "Adicionar"}
				</button>
				{formError ? (
					<span className="text-xs text-secondary">{formError}</span>
				) : null}
			</form>

			{/* State */}
			{isPending ? <StatusNote>Carregando números…</StatusNote> : null}
			{isError ? <StatusNote tone="error">{error.message}</StatusNote> : null}

			{numbers && numbers.length === 0 ? (
				<StatusNote>
					Nenhum número cadastrado. Adicione um acima para começar a enviar.
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
														`Remover o número ${num.msisdn}? Esta ação não pode ser desfeita.`,
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
